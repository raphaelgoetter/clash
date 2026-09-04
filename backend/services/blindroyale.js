// ============================================================
// blindroyale.js — Jeu "Blind Royale" (devine la carte Clash Royale à partir
// du son qu'elle produit). Couche métier : lecture du pool de cartes
// sonores, état de la partie, scoring, classements. Miroir structurel de
// zoom.js/anagrams.js (même stockage Upstash Redis, mêmes pièges —
// automaticDeserialization/HGETALL, client paresseux — voir les commentaires
// détaillés dans frames.js).
//
// Scoring identique à Zoom (pas de notion de vitesse/rang comme Anagram) :
// on part de 10 pts, -2 pts par mauvaise réponse, -3 pts si l'indice
// "Rareté" est utilisé (une seule fois).
//
// Pas de fichier catalogue dédié (data/blindroyale/*.json) : le pool est
// directement les entrées de data/cardNames.json qui ont un champ "sound"
// (114/122 cartes) — voir loadBlindRoyaleCards(). gameId = cardKey
// (identifiant déjà unique et lisible, pas besoin d'un ID numérique séparé).
//
// Rotation des cartes : cardNames.json étant trié alphabétiquement, la
// progression ne peut pas être une simple avancée séquentielle dans le
// fichier (la prochaine carte serait devinable à l'avance) — voir
// loadPlayOrder(), même solution que lajustecarte.js (ordre mélangé une
// fois puis persisté dans Redis).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace, fetchCards } from "./clashApi.js";
import { computeCurrentSeasonId, countRemainingWeekdayOccurrences } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";
import { normalizeAnswer } from "./textNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");
export const SOUNDS_DIR = path.resolve(__dirname, "..", "..", "data", "card-sounds", "sounds");
export const ILLUSTRATION_PATH = path.resolve(__dirname, "..", "..", "data", "card-sounds", "images", "blindroyale.webp");

const MONDAY = 1;
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;

// Construction paresseuse (pas au chargement du module) — voir frames.js
// pour la raison exacte (ordre des imports ES vs dotenv.config()).
let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      automaticDeserialization: false,
    });
  }
  return _redis;
}

function toJson(value) {
  return JSON.stringify(value);
}

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau plat
// [champ1, valeur1, ...] et non un objet — voir frames.js.
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

async function hgetallRaw(key) {
  return pairsToObject((await getRedis().hgetall(key)) || []);
}

async function hgetallJson(key) {
  const raw = await hgetallRaw(key);
  const result = {};
  for (const [field, value] of Object.entries(raw)) {
    result[field] = fromJson(value);
  }
  return result;
}

const STATE_KEY = "blindroyale:state";
const ORDER_KEY = "blindroyale:order";

function participantsKey(gameId) {
  return `blindroyale:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `blindroyale:usernames:${gameId}`;
}
function attemptsKey(gameId, discordId) {
  return `blindroyale:attempts:${gameId}:${discordId}`;
}
function hintKey(gameId, discordId) {
  return `blindroyale:hint:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `blindroyale:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `blindroyale:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `blindroyale:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `blindroyale:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `blindroyale:archived:${seasonId}`;
}

// SCAN par motif — uniquement utilisé pour le nettoyage, jamais sur le
// chemin critique d'une interaction joueur (voir frames.js).
async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function scanDelete(pattern) {
  const keys = await scanKeys(pattern);
  if (keys.length) await getRedis().del(...keys);
}

// ── Lecture du pool de cartes sonores (statique, jamais muté) ────
// Sous-ensemble de cardNames.json filtré sur la présence d'un champ "sound"
// (voir data/card-sounds/README.md pour la provenance des fichiers et les
// cartes absentes du pool faute de son disponible).

let blindRoyaleCardsCache = null;

export async function loadBlindRoyaleCards() {
  if (blindRoyaleCardsCache) return blindRoyaleCardsCache;
  const txt = await fs.readFile(CARD_NAMES_JSON_PATH, "utf-8");
  const all = JSON.parse(txt);
  blindRoyaleCardsCache = all.filter((c) => !!c.sound);
  return blindRoyaleCardsCache;
}

export function resolveBlindRoyaleEntry(cards, gameId) {
  return cards.find((c) => c.cardKey === gameId) ?? null;
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

async function cleanupGameScratchData(gameId) {
  await getRedis().del(participantsKey(gameId), usernamesKey(gameId));
  await scanDelete(`blindroyale:hint:${gameId}:*`);
  await scanDelete(`blindroyale:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active, ordre de rotation remélangé
// à la prochaine partie, historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY, ORDER_KEY);
  await scanDelete("blindroyale:participants:*");
  await scanDelete("blindroyale:usernames:*");
  await scanDelete("blindroyale:hint:*");
  await scanDelete("blindroyale:attempts:*");
  await scanDelete("blindroyale:season:*");
  await scanDelete("blindroyale:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis anagrams.js/zoom.js (seule la clé de cache
// change) — voir la remarque équivalente en tête d'anagrams.js.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "blindroyale:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      for (const delay of [0, 1000, 3000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const raceLog = await fetchRaceLog(clanTag).catch(() => null);
        const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
        const seasonId = computeCurrentSeasonId(currentRace, raceLog);
        if (seasonId != null) return seasonId;
      }
      return null;
    },
    15 * 60 * 1000,
  );
  return value;
}

// ── Ordre de rotation hebdomadaire ────────────────────────────────
// cardNames.json reste trié alphabétiquement (contrainte de
// generateCardNames.js) : contrairement à Frame/Anagram/Zoom (dont les
// catalogues JSON dédiés sont déjà mélangés une fois pour toutes à
// l'écriture du fichier), on ne peut pas s'appuyer sur l'ordre physique du
// fichier pour éviter que la prochaine carte secrète soit devinable à
// l'avance — même problème que La Juste Carte (lajustecarte.js), même
// solution : l'ordre de passage est mélangé une fois puis persisté dans
// Redis ; les nouvelles cartes (ajoutées après coup par
// generateCardStats.js) sont insérées à la suite, mélangées entre elles,
// sans perturber l'ordre déjà en cours.
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function loadPlayOrder(cards) {
  const stored = fromJson(await getRedis().get(ORDER_KEY)) || [];
  const cardKeySet = new Set(cards.map((c) => c.cardKey));
  const kept = stored.filter((k) => cardKeySet.has(k));
  const missing = cards.map((c) => c.cardKey).filter((k) => !kept.includes(k));
  const order = [...kept, ...shuffle(missing)];
  if (missing.length > 0 || kept.length !== stored.length) {
    await getRedis().set(ORDER_KEY, toJson(order));
  }
  return order;
}

// Avance d'une position dans l'ordre de rotation (pas dans le pool brut) et
// boucle au début une fois épuisé — même pattern que Zoom/Anagram/Frame,
// mais appliqué à `order` (loadPlayOrder ci-dessus), pas à `cards`.
export function pickNextBlindRoyaleIndex(state, order) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % order.length;
}

// Attribue le numéro de manche relatif à la saison — identique en structure
// à frames.js/anagrams.js/zoom.js (INCR + HSETNX idempotent).
async function assignSeasonMancheNumber(seasonId, gameId) {
  const numbersKey = seasonMancheNumbersKey(seasonId);
  const existing = await getRedis().hget(numbersKey, gameId);
  if (existing != null) return Number(existing);

  const seasonManche = Number(await getRedis().incr(seasonMancheSeqKey(seasonId)));
  const wasSet = Number(await getRedis().hsetnx(numbersKey, gameId, String(seasonManche)));
  if (!wasSet) {
    return Number(await getRedis().hget(numbersKey, gameId));
  }
  return seasonManche;
}

// X = manche déjà attribuée + lundis restants avant la fin de la saison
// calendaire — même principe que Frame (mercredis) / Zoom (vendredis).
function countRemainingMondays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, MONDAY);
}
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingMondays(now);
}

export async function startNewGame(channelId) {
  const cards = await loadBlindRoyaleCards();
  const order = await loadPlayOrder(cards);
  const previousState = await readState();
  const currentIndex = pickNextBlindRoyaleIndex(previousState, order);
  const entry = resolveBlindRoyaleEntry(cards, order[currentIndex]);
  const gameId = entry.cardKey;
  const seasonId = await getCurrentSeasonId();
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);

  const newState = {
    currentIndex,
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal,
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);

  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// ── Garde-fou anti-double-post ────────────────────────────────────
// Un seul créneau hebdomadaire (contrairement à Anagram, 2 créneaux) : même
// pattern minimal que Zoom (alreadyPostedThisWeek + force), pas besoin de la
// logique de tirage aléatoire par créneau.
function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// ── Résolution de l'image de carte (API Clash Royale) ────────────
// Dupliquée à l'identique depuis anagrams.js — clé de cache
// "clashCardDefinitions" volontairement partagée (voir anagrams.js).

async function loadCardDefinitions() {
  const { value } = await getOrSet("clashCardDefinitions", () => fetchCards(), CARD_DEF_CACHE_TTL);
  return value;
}

export async function getCardImageUrl(cardKey) {
  if (!cardKey) return null;
  const cards = await loadCardDefinitions();
  const match = cards.find((c) => c.name === cardKey);
  if (!match) {
    console.warn(`[BlindRoyale] cardKey introuvable dans l'API Clash Royale : "${cardKey}"`);
    return null;
  }
  return match.iconUrls?.medium ?? null;
}

// Réponse (nom FR de la carte) pour une manche précise — utilisé par le
// récap de fin de saison pour rappeler la liste des cartes de la saison
// écoulée.
export async function getBlindRoyaleAnswer(gameId) {
  const cards = await loadBlindRoyaleCards();
  return resolveBlindRoyaleEntry(cards, gameId)?.fr ?? null;
}

// ── Normalisation et vérification de la réponse ─────────────────
// Égalité STRICTE contre le nom FR (comme Anagram/Zoom) — cardNames.json n'a
// pas de liste d'alias "accept", juste le nom canonique.
export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return false;
  return normalizeAnswer(entry.fr) === normalized;
}

// ── Scoring (identique à Zoom) ────────────────────────────────────
// Score plancher à 1 (et non 0) : trouver la bonne réponse doit toujours
// rapporter au moins un point, même après de nombreuses tentatives
// incorrectes et l'indice.
export function computeScore(attemptsIncorrects, hintUsed = false) {
  return Math.max(1, 10 - 2 * attemptsIncorrects - (hintUsed ? 3 : 0));
}

// ── Progression par joueur ────────────────────────────────────────

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

async function countAttempts(gameId, discordId) {
  const n = await getRedis().get(attemptsKey(gameId, discordId));
  return Number(n) || 0;
}

export async function recordAttempt(gameId, discordId, username, isCorrect) {
  await touchUsername(gameId, discordId, username);
  if (isCorrect) return; // la tentative gagnante n'est jamais comptée comme incorrecte
  await getRedis().incr(attemptsKey(gameId, discordId));
}

export async function hintUsedFor(gameId, discordId) {
  return (await getRedis().get(hintKey(gameId, discordId))) === "1";
}

// Un seul palier d'indice : un simple flag SETNX suffit (comme Zoom/La Juste
// Carte).
export async function recordHintUsed(gameId, discordId, username) {
  await touchUsername(gameId, discordId, username);
  const wasSet = Number(await getRedis().setnx(hintKey(gameId, discordId), "1"));
  return { alreadyUsed: wasSet === 0 };
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien
// réécrire. Sinon calcule le score à partir des compteurs indice/tentatives
// (comme Zoom).
export async function markSolved(gameId, discordId, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) {
    return { participant: existing, score: existing.score };
  }

  const [hintUsed, attempts] = await Promise.all([
    hintUsedFor(gameId, discordId),
    countAttempts(gameId, discordId),
  ]);
  const score = computeScore(attempts, hintUsed);
  const participant = {
    discordId,
    username,
    attempts,
    solved: true,
    solvedAt: new Date().toISOString(),
    score,
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score };
}

// ── Résultats archivés (classement de la saison) ─────────────────

export async function archiveSolve(state, entry, discordId, username, score, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    cardKey: entry.cardKey,
    reponse: entry.fr,
    postedAt: state.startedAt,
    discordId,
    pseudo: username,
    score,
    solvedAt,
  };

  const wasSet = Number(await getRedis().hsetnx(archKey, field, toJson(result)));
  if (!wasSet) {
    return fromJson(await getRedis().hget(archKey, field)) ?? result; // déjà archivé par un appel concurrent
  }

  await getRedis().zincrby(seasonKey(state.seasonId), score, discordId);
  await getRedis().hset(seasonPseudosKey(state.seasonId), { [discordId]: username });
  return result;
}

export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

export async function getSeasonManches(seasonId) {
  const ids = await getRedis().hkeys(seasonMancheNumbersKey(seasonId));
  return ids || [];
}

export async function getSeasonMancheNumber(seasonId, gameId) {
  const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
  return raw == null ? null : Number(raw);
}

export async function previewSeasonManche(seasonId) {
  const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
  return seq + 1;
}

export async function hasPlayerInteracted(gameId, discordId) {
  const username = await getRedis().hget(usernamesKey(gameId), discordId);
  return username != null;
}

// ── Classements ──────────────────────────────────────────────────

export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({ discordId: p.discordId, username: p.username, score: p.score, solvedAt: p.solvedAt }))
    .sort((a, b) => b.score - a.score || new Date(a.solvedAt) - new Date(b.solvedAt));
}

// Ordre chronologique pur (arrivée), utilisé pour le DM "tu es le Nᵉ à
// trouver" — distinct de computeGameRanking, qui trie par score (comme
// Zoom : deux notions différentes, contrairement à Anagram où position et
// score sont la même donnée).
export async function computeArrivalOrder(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({ discordId: p.discordId, username: p.username, score: p.score, solvedAt: p.solvedAt }))
    .sort((a, b) => new Date(a.solvedAt) - new Date(b.solvedAt));
}

export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}

export async function listGamePlayersInProgress(gameId) {
  const [participants, usernames] = await Promise.all([
    hgetallJson(participantsKey(gameId)),
    hgetallRaw(usernamesKey(gameId)),
  ]);
  const solvedIds = new Set(
    Object.values(participants)
      .filter((p) => p?.solved)
      .map((p) => p.discordId),
  );
  return Object.entries(usernames)
    .filter(([discordId]) => !solvedIds.has(discordId))
    .map(([discordId, username]) => ({ discordId, username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function computeSeasonRanking(seasonId) {
  const [flat, pseudos] = await Promise.all([
    getRedis().zrange(seasonKey(seasonId), 0, -1, { rev: true, withScores: true }),
    hgetallRaw(seasonPseudosKey(seasonId)),
  ]);
  const ranking = [];
  for (let i = 0; i < flat.length; i += 2) {
    const discordId = String(flat[i]);
    const totalScore = Number(flat[i + 1]);
    ranking.push({ discordId, pseudo: pseudos?.[discordId] || discordId, totalScore });
  }
  return ranking.sort((a, b) => b.totalScore - a.totalScore || a.pseudo.localeCompare(b.pseudo));
}

// Classement avec ex-aequo ("1224") — utilisé pour le classement de SAISON
// (ZSET) ET pour le classement de manche (comme Zoom : plusieurs joueurs
// peuvent légitimement avoir le même score, ex. 10 pts chacun au 1er coup).
export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
