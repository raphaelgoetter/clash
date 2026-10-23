// ============================================================
// zoom2.js — Jeu "Zoom logo" (devine une marque à partir d'un zoom sur son
// logo), groupe "Coup d'œil" du vendredi (voir jeux/services/refonte.js).
// Couche métier : lecture du catalogue, état de la partie, scoring,
// classements. Même mécanique et même stockage que Zoom carte (zoom.js),
// sous le préfixe Redis `zoom2:` ; zoom.js reste intact tant que Zoom carte
// tourne.
//
// Différences avec Zoom carte :
// - gameId opaque dérivé du numéro (`l001`…) : il apparaît dans l'URL de
//   l'image et dans les custom_id Discord, il ne doit pas trahir la réponse.
// - Catalogue mélangé une fois pour toutes (jeux/data/jeux-visuels/zoom2/
//   zoom2.json), parcouru dans l'ordre ; les ajouts se font en fin de
//   fichier, jamais au milieu (les numéros déjà joués ne bougent pas).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZOOM2_JSON_PATH = path.resolve(__dirname, "..", "data", "jeux-visuels", "zoom2", "zoom2.json");

const FRIDAY = 5;

// Construction paresseuse (pas au chargement du module) — voir frames.js.
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

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau plat.
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

const STATE_KEY = "zoom2:state";

// Registre anti-spoiler, jamais nettoyé : tous les gameId déjà postés.
function postedGamesKey() {
  return "zoom2:posted_games";
}
function participantsKey(gameId) {
  return `zoom2:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `zoom2:usernames:${gameId}`;
}
function hintKey(gameId, discordId) {
  return `zoom2:hint:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `zoom2:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `zoom2:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `zoom2:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `zoom2:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `zoom2:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `zoom2:archived:${seasonId}`;
}

// SCAN par motif : nettoyage uniquement, jamais sur une interaction joueur.
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

let zoom2CatalogCache = null;

export async function loadZoom2Catalog() {
  if (zoom2CatalogCache) return zoom2CatalogCache;
  const txt = await fs.readFile(ZOOM2_JSON_PATH, "utf-8");
  zoom2CatalogCache = JSON.parse(txt);
  return zoom2CatalogCache;
}

export function gameIdFor(entry) {
  return `l${String(entry.numero).padStart(3, "0")}`;
}

export function resolveZoom2Entry(catalog, gameId) {
  return catalog.find((e) => gameIdFor(e) === gameId) ?? null;
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
  await scanDelete(`zoom2:hint:${gameId}:*`);
  await scanDelete(`zoom2:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart au début
// du catalogue), historique et scores effacés. Le registre anti-spoiler est
// purgé aussi : après un reset, les manches repartent de l001.
export async function resetGame() {
  await getRedis().del(STATE_KEY, postedGamesKey());
  await scanDelete("zoom2:participants:*");
  await scanDelete("zoom2:usernames:*");
  await scanDelete("zoom2:hint:*");
  await scanDelete("zoom2:attempts:*");
  await scanDelete("zoom2:season:*");
  await scanDelete("zoom2:archived:*");
}

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Sélection du prochain logo : progression séquentielle ───
// Avance d'une position dans le catalogue et boucle au début une fois
// épuisé (même principe que Zoom carte).
export function pickNextZoom2Index(state, catalog) {
  const prevIndex = state?.gameId ? catalog.findIndex((e) => gameIdFor(e) === state.gameId) : -1;
  return (prevIndex + 1) % catalog.length;
}

// Numéro de manche relatif à la saison (INCR + HSETNX idempotent).
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

// X = manche déjà attribuée + vendredis restants avant la fin de la saison.
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, FRIDAY);
}

export async function startNewGame(channelId) {
  const catalog = await loadZoom2Catalog();
  const previousState = await readState();
  const entry = catalog[pickNextZoom2Index(previousState, catalog)];
  const gameId = gameIdFor(entry);
  const seasonId = await getCurrentSeasonId();
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const newState = {
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal: computeSeasonMancheTotal(seasonManche, now),
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);
  await getRedis().sadd(postedGamesKey(), gameId);

  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// Garde-fou anti-spoiler pour jeux/services/zoom2Image.js.
export async function isGamePosted(gameId) {
  return Number(await getRedis().sismember(postedGamesKey(), gameId)) === 1;
}

// ── Garde-fou anti-double-post (même jour UTC que la manche active) ──

function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// ── Vérification de la réponse ─────────────────
// Égalité STRICTE après normalisation (comme Zoom carte) : les noms de
// marques sont courts, une sous-chaîne validerait « LG » dans « Algérie ».

export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return false;
  return (entry.accept || []).map(normalizeAnswer).includes(normalized);
}

// ── Scoring ──────────────────────────────────────────────────────
// Barème de Zoom carte : un seul indice (-3), -2 par erreur, plancher 1.

export function computeScore(attemptsIncorrects, hintUsed) {
  return Math.max(1, 10 - 2 * attemptsIncorrects - (hintUsed ? 3 : 0));
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

export async function recordAttempt(gameId, discordId, username, isCorrect = false) {
  await touchUsername(gameId, discordId, username);
  if (isCorrect) return; // la tentative gagnante n'est jamais comptée comme incorrecte
  await getRedis().incr(attemptsKey(gameId, discordId));
}

export async function recordHintUsed(gameId, discordId, username) {
  await touchUsername(gameId, discordId, username);
  const wasSet = Number(await getRedis().setnx(hintKey(gameId, discordId), "1"));
  return { alreadyUsed: wasSet === 0 };
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien réécrire.
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

// Tous les résultats archivés, toutes saisons confondues (/mini-jeux-history).
export async function getAllArchivedResults() {
  const keys = await scanKeys("zoom2:archived:*");
  if (keys.length === 0) return [];
  const hashes = await Promise.all(keys.map((key) => hgetallJson(key)));
  return hashes.flatMap((hash) => Object.values(hash));
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

// Nom de la marque d'une manche donnée (récap de fin de saison).
export async function getZoom2RoundLabel(gameId) {
  const entry = resolveZoom2Entry(await loadZoom2Catalog(), gameId);
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
