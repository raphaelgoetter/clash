// ============================================================
// anagrams.js — Jeu "Anagram" (devine la carte Clash Royale à partir d'une
// anagramme de son nom). Couche métier : lecture des anagrammes, état de la
// partie, scoring, classements. Miroir de frames.js (même stockage Upstash
// Redis, mêmes pièges — automaticDeserialization/HGETALL, client paresseux —
// voir les commentaires détaillés dans frames.js), avec deux différences
// structurelles :
//
// 1. Le score dépend UNIQUEMENT de la position d'arrivée (1er = 10pts, 2e =
//    9pts, ... 10e = 1pt, 11e+ = 0pt), attribuée atomiquement au moment de la
//    résolution (INCR + HSETNX, même pattern que assignSeasonMancheNumber).
//    Contrairement à Frame, position et rang sont donc structurellement la
//    même donnée : un seul computeGameRanking() suffit, pas besoin d'un
//    computeArrivalOrder() séparé (Frame a eu un bug réel car son DM "vous
//    êtes le Xe à avoir trouvé" utilisait par erreur le classement par score
//    au lieu de l'ordre d'arrivée — cette classe de bug ne peut pas se
//    reproduire ici).
// 2. Post hebdomadaire à horaire ALÉATOIRE (samedi, 7h-19h UTC, cron toutes
//    les 2h + tirage au sort applicatif) plutôt qu'à heure fixe — voir
//    alreadyPostedThisWeek/computeWeeklySlotIndex/shouldPostThisSlot.
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
const ANAGRAMS_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "anagrams", "anagrams.json");

const SATURDAY = 6;
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;
// Doit rester synchronisé avec le cron de .github/workflows/anagrams.yml
// ("0 7-19/2 * * 6").
export const ANAGRAM_CRON_HOURS = [7, 9, 11, 13, 15, 17, 19];

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

const STATE_KEY = "anagram:state";

function participantsKey(gameId) {
  return `anagram:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `anagram:usernames:${gameId}`;
}
function attemptsKey(gameId, discordId) {
  return `anagram:attempts:${gameId}:${discordId}`;
}
function positionSeqKey(gameId) {
  return `anagram:position_seq:${gameId}`;
}
function positionsKey(gameId) {
  return `anagram:positions:${gameId}`;
}
function seasonKey(seasonId) {
  return `anagram:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `anagram:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `anagram:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `anagram:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `anagram:archived:${seasonId}`;
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

// ── Lecture des anagrammes (statique, jamais mutée) ────────────

let anagramsCache = null;

export async function loadAnagrams() {
  if (anagramsCache) return anagramsCache;
  const txt = await fs.readFile(ANAGRAMS_JSON_PATH, "utf-8");
  anagramsCache = JSON.parse(txt);
  return anagramsCache;
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

async function cleanupGameScratchData(gameId) {
  await getRedis().del(participantsKey(gameId), usernamesKey(gameId), positionSeqKey(gameId), positionsKey(gameId));
  await scanDelete(`anagram:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart à
// l'index 0 de anagrams.json) et historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("anagram:participants:*");
  await scanDelete("anagram:usernames:*");
  await scanDelete("anagram:attempts:*");
  await scanDelete("anagram:position_seq:*");
  await scanDelete("anagram:positions:*");
  await scanDelete("anagram:season:*");
  await scanDelete("anagram:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis frames.js (seule la clé de cache change) —
// fonction 100% générique, pas de valeur à extraire tant qu'un 3e mini-jeu
// ne justifie pas un module partagé (voir décision équivalente sur
// normalizeAnswer, qui elle a été extraite car strictement plus simple).
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "anagrams:seasonId",
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

// ── Sélection de l'anagramme et démarrage d'une partie ──────────

export function pickNextAnagramIndex(state, anagrams) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % anagrams.length;
}

// Attribue le numéro de manche relatif à la saison — identique en structure
// à frames.js (INCR + HSETNX idempotent).
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

// X = manche déjà attribuée + samedis restants avant la fin de la saison
// calendaire (countRemainingWeekdayOccurrences, dateUtils.js) — même
// principe que Frame (mercredis), voir le commentaire détaillé équivalent
// dans frames.js pour la justification (gère nativement un démarrage en
// cours de saison).
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, SATURDAY);
}

export async function startNewGame(channelId) {
  const anagrams = await loadAnagrams();
  const previousState = await readState();
  const currentIndex = pickNextAnagramIndex(previousState, anagrams);
  const entry = anagrams[currentIndex];
  const seasonId = await getCurrentSeasonId();
  const gameId = String(entry.ID);
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

  // Purge la progression (positions/tentatives/participants) de la partie
  // précédente — données jetables une fois la partie terminée. Les
  // résultats archivés (anagram:season:*, nécessaires au total de la
  // saison) ne sont eux jamais supprimés ici.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// ── Gating hebdomadaire (horaire aléatoire, samedi 7h-19h UTC) ───
// GitHub Actions ne permet pas nativement un cron à plage aléatoire : le
// workflow se déclenche toutes les 2h (ANAGRAM_CRON_HOURS), et à chaque
// déclenchement le tirage ci-dessous décide de poster ou non, avec une
// probabilité croissante garantissant un post au plus tard au dernier
// créneau (19h) si aucun post n'a encore eu lieu cette semaine.

function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

// Compare la date (UTC) du dernier post à aujourd'hui — un seul writer
// (startNewGame), pas de clé Redis redondante à maintenir en plus de l'état.
export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// Nombre de créneaux déjà "consommés" à l'heure courante (1..7) — robuste à
// un léger retard de déclenchement GitHub Actions (reste dans le même
// créneau tant que l'heure suivante n'est pas atteinte).
export function computeWeeklySlotIndex(now = new Date()) {
  const hour = now.getUTCHours();
  const passed = ANAGRAM_CRON_HOURS.filter((h) => h <= hour).length;
  return Math.min(ANAGRAM_CRON_HOURS.length, Math.max(1, passed));
}

export function shouldPostThisSlot(slotIndex, rng = Math.random) {
  const remaining = ANAGRAM_CRON_HOURS.length - slotIndex + 1; // 7,6,...,1
  return rng() < 1 / remaining; // dernier créneau : 1/1, garanti
}

// ── Résolution de l'image de carte (API Clash Royale) ────────────

async function loadCardDefinitions() {
  // Clé de cache "clashCardDefinitions" volontairement partagée avec
  // backend/routes/matchup.js et backend/routes/decks.js (getOrSet est un
  // cache in-memory par process, pas namespacé par fichier) — bénéficie du
  // cache déjà chaud si une autre route l'a peuplé dans le même process.
  const { value } = await getOrSet("clashCardDefinitions", () => fetchCards(), CARD_DEF_CACHE_TTL);
  return value;
}

// Renvoie l'URL de l'icône officielle de la carte, ou null si cardKey est
// absent ou ne correspond à aucune carte de l'API (dégrade proprement : pas
// d'image dans le message de révélation plutôt qu'un plantage).
export async function getCardImageUrl(cardKey) {
  if (!cardKey) return null;
  const cards = await loadCardDefinitions();
  const match = cards.find((c) => c.name === cardKey);
  if (!match) {
    console.warn(`[Anagram] cardKey introuvable dans l'API Clash Royale : "${cardKey}"`);
    return null;
  }
  return match.iconUrls?.medium ?? null;
}

// ── Normalisation et vérification de la réponse ─────────────────
// normalizeAnswer partagée avec Frame (textNormalize.js). checkAnswer est en
// revanche propre à Anagram : égalité STRICTE contre la liste accept (pas de
// correspondance par sous-chaîne comme Frame — sur un nom de carte court,
// "Barbares" seul accepterait à tort "Barbares d'élite").
export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return false;
  return (entry.accept || []).map(normalizeAnswer).includes(normalized);
}

// ── Scoring par position d'arrivée ────────────────────────────────

export function computeScore(position) {
  return Math.max(0, 11 - position); // 1er=10, 2e=9, ..., 10e=1, 11e+=0
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

// Compteur informatif uniquement (affichage éventuel) — contrairement à
// Frame, n'entre plus dans le calcul du score, purement dérivé de la
// position d'arrivée.
export async function recordAttempt(gameId, discordId, username, isCorrect) {
  await touchUsername(gameId, discordId, username);
  if (isCorrect) return null;
  await getRedis().incr(attemptsKey(gameId, discordId));
  return null;
}

// Attribution atomique et immuable de la position d'arrivée — même pattern
// INCR + HSETNX idempotent que assignSeasonMancheNumber(), scopé par gameId :
// garantit une position unique même en cas de résolutions simultanées.
async function assignArrivalPosition(gameId, discordId) {
  const existing = await getRedis().hget(positionsKey(gameId), discordId);
  if (existing != null) return Number(existing);

  const position = Number(await getRedis().incr(positionSeqKey(gameId)));
  const wasSet = Number(await getRedis().hsetnx(positionsKey(gameId), discordId, String(position)));
  if (!wasSet) {
    return Number(await getRedis().hget(positionsKey(gameId), discordId));
  }
  return position;
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien
// réécrire. Le score est connu et figé dès l'attribution de la position.
export async function markSolved(gameId, discordId, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) {
    return { participant: existing, score: existing.score };
  }

  const position = await assignArrivalPosition(gameId, discordId);
  const attempts = await countAttempts(gameId, discordId);
  const score = computeScore(position);
  const participant = {
    discordId,
    username,
    attempts,
    solved: true,
    solvedAt: new Date().toISOString(),
    position,
    score,
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score };
}

// ── Résultats archivés (classement de la saison) ─────────────────

export async function archiveSolve(state, entry, discordId, username, score, position, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    reponse: entry.answer,
    postedAt: state.startedAt,
    discordId,
    pseudo: username,
    score,
    position,
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

// Classement PAR POSITION d'arrivée (croissant) — contrairement à Frame,
// c'est la SEULE notion de classement par manche : position et score sont
// structurellement la même donnée (voir en-tête de fichier), pas besoin
// d'une fonction séparée pour "vous êtes le Xe à avoir trouvé".
export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      score: p.score,
      position: p.position,
      solvedAt: p.solvedAt,
    }))
    .sort((a, b) => a.position - b.position);
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

// Classement avec ex-aequo ("1224") — nécessaire uniquement pour le
// classement de SAISON (ZSET, où deux joueurs peuvent cumuler le même total
// sur plusieurs manches). Jamais pour le classement par manche : les
// positions sont garanties uniques par assignArrivalPosition(), inutile d'y
// gérer des ex-aequo.
export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
