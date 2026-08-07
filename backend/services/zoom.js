// ============================================================
// zoom.js — Jeu "Zoom carte" (devine une carte à partir d'un zoom extrême
// sur son icône). Couche métier : lecture du catalogue, état de la partie,
// scoring, classements. Miroir structurel de frames.js/anagrams.js (même
// stockage Upstash Redis, mêmes pièges — automaticDeserialization/HGETALL,
// client paresseux — voir les commentaires détaillés dans frames.js).
//
// Deux différences par rapport à Frame :
// - checkAnswer utilise une égalité STRICTE (comme anagrams.js), pas une
//   correspondance par sous-chaîne — les noms de cartes sont courts.
// - La progression est séquentielle comme Frame (pickNextZoomIndex), mais
//   sur un catalogue MÉLANGÉ une fois pour toutes (voir
//   scripts/generateZoomCatalog.js) plutôt que trié alphabétiquement —
//   un ordre alphabétique aurait rendu le jeu totalement prévisible.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId, countRemainingWeekdayOccurrences } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";
import { normalizeAnswer } from "./textNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZOOM_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "zoom", "zoom.json");

const FRIDAY = 5;

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

const STATE_KEY = "zoom:state";

// SET durable, jamais nettoyé (contrairement aux clés scopées par saison) :
// tous les gameId ayant un jour été postés, toutes saisons confondues. Sert
// de garde-fou anti-spoiler pour backend/services/zoomImage.js — même
// pattern que frame:posted_games (frames.js).
function postedGamesKey() {
  return "zoom:posted_games";
}
function participantsKey(gameId) {
  return `zoom:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `zoom:usernames:${gameId}`;
}
function hintKey(gameId, discordId) {
  return `zoom:hint:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `zoom:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `zoom:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `zoom:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `zoom:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `zoom:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `zoom:archived:${seasonId}`;
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

// ── Lecture du catalogue (statique, jamais muté) ──────────────────

let zoomCatalogCache = null;

export async function loadZoomCatalog() {
  if (zoomCatalogCache) return zoomCatalogCache;
  const txt = await fs.readFile(ZOOM_JSON_PATH, "utf-8");
  zoomCatalogCache = JSON.parse(txt);
  return zoomCatalogCache;
}

export function resolveZoomEntry(catalog, gameId) {
  return catalog.find((e) => e.id === gameId) ?? null;
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
  await scanDelete(`zoom:hint:${gameId}:*`);
  await scanDelete(`zoom:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine partie repart au
// début de data/zoom/zoom.json), historique/scores effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("zoom:participants:*");
  await scanDelete("zoom:usernames:*");
  await scanDelete("zoom:hint:*");
  await scanDelete("zoom:attempts:*");
  await scanDelete("zoom:season:*");
  await scanDelete("zoom:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis frames.js/anagrams.js (seule la clé de
// cache change) — pas de valeur à extraire tant que ça reste quelques
// copies quasi-identiques (voir la remarque équivalente en tête
// d'anagrams.js).
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "zoom:seasonId",
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

// ── Sélection de la prochaine carte : progression séquentielle ───
// Même pattern que Frame/Anagram (pickNextFrameIndex) : avance d'une
// position dans data/zoom/zoom.json et boucle au début une fois le
// catalogue épuisé. Le "hasard" ne vient pas d'un tirage au moment de
// poster (plus simple, pas d'état supplémentaire à maintenir en Redis) mais
// du fait que le FICHIER lui-même a été mélangé une fois — voir
// scripts/generateZoomCatalog.js, qui préserve cet ordre à chaque
// régénération plutôt que de retrier alphabétiquement.
export function pickNextZoomIndex(state, catalog) {
  const prevIndex = state?.gameId ? catalog.findIndex((e) => e.id === state.gameId) : -1;
  return (prevIndex + 1) % catalog.length;
}

// Attribue le numéro de manche relatif à la saison — identique en structure
// à frames.js/anagrams.js (INCR + HSETNX idempotent).
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

// X = manche déjà attribuée + vendredis restants avant la fin de la saison
// calendaire — même principe que Frame (mercredis) / Anagram (samedis).
function countRemainingFridays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, FRIDAY);
}
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingFridays(now);
}

export async function startNewGame(channelId) {
  const catalog = await loadZoomCatalog();
  const previousState = await readState();
  const currentIndex = pickNextZoomIndex(previousState, catalog);
  const gameId = catalog[currentIndex].id;
  const seasonId = await getCurrentSeasonId();
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);

  const newState = {
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal,
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);
  await getRedis().sadd(postedGamesKey(), gameId);

  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  const entry = resolveZoomEntry(catalog, gameId);
  return { state: newState, entry };
}

// Garde-fou anti-spoiler pour backend/services/zoomImage.js — même pattern
// que getFrameImageByGameId (frames.js).
export async function isGamePosted(gameId) {
  return Number(await getRedis().sismember(postedGamesKey(), gameId)) === 1;
}

// ── Normalisation et vérification de la réponse ─────────────────
// normalizeAnswer partagée avec Frame/Anagram (textNormalize.js). checkAnswer
// utilise une égalité STRICTE comme Anagram (pas de correspondance par
// sous-chaîne comme Frame) — les noms de cartes sont courts.

export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return false;
  return (entry.accept || []).map(normalizeAnswer).includes(normalized);
}

// ── Scoring ──────────────────────────────────────────────────────
// Un seul palier d'indice (contrairement à Frame qui en a 2) — hintUsed est
// un booléen, le terme de pénalité vaut donc 0 ou 3.

export function computeScore(attemptsIncorrects, hintUsed) {
  return Math.max(0, 10 - 2 * attemptsIncorrects - (hintUsed ? 3 : 0));
}

// ── Progression par joueur ────────────────────────────────────────

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

async function hintUsedFor(gameId, discordId) {
  return (await getRedis().get(hintKey(gameId, discordId))) === "1";
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

// Un seul palier d'indice : un simple flag SETNX suffit (pas besoin de
// SADD/SCARD comme Frame, qui a 2 indices indépendants par manche).
export async function recordHintUsed(gameId, discordId, username) {
  await touchUsername(gameId, discordId, username);
  const wasSet = Number(await getRedis().setnx(hintKey(gameId, discordId), "1"));
  return { alreadyUsed: wasSet === 0 };
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien
// réécrire. Sinon calcule le score à partir des compteurs indice/tentatives.
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
    variant: entry.variant,
    answer: entry.answer,
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

// Nom français de la carte d'une manche donnée — pour le récap de fin de
// saison (liste des manches jouées).
export async function getZoomRoundLabel(gameId) {
  const catalog = await loadZoomCatalog();
  const entry = resolveZoomEntry(catalog, gameId);
  return entry?.answer ?? null;
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
// trouver" — voir le même distinguo que Frame (computeGameRanking trie par
// score, pas par ordre d'arrivée).
export async function computeArrivalOrder(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({ discordId: p.discordId, username: p.username, score: p.score, solvedAt: p.solvedAt }))
    .sort((a, b) => new Date(a.solvedAt) - new Date(b.solvedAt));
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

export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}

export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
