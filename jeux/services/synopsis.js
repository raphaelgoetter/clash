// ============================================================
// synopsis.js — Jeu "Synopsis éclaté" (devine le film ou la série à partir
// du pire synopsis possible), groupe "Ciné-club" du mercredi (voir
// refonte.js). Couche métier : état Redis, tirage, vérification, scoring,
// classements. Même mécanique que Frame (frames.js) : réponse libre via
// Modal, deux indices (année, réalisation) et tentatives incorrectes comptés
// par joueur, score figé à la résolution. La variante du synopsis est
// affichée d'office.
//
// Catalogue jeux/data/synopsis/synopsis.json, parcouru dans l'ordre du
// fichier, en boucle. gameId = `s` + numéro zéro-paddé (s001…) : ne jamais
// réordonner le fichier une fois joué, ajouter en fin.
//
// ⚠️ automaticDeserialization désactivée : voir frames.js (IDs Discord).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";

// Vérification de la réponse : système de Frame (sous-chaîne + `refuse`).
export { checkAnswer } from "./frames.js";

const WEDNESDAY = 3;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNOPSIS_JSON_PATH = path.resolve(__dirname, "..", "data", "synopsis", "synopsis.json");

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

// HGETALL renvoie un tableau plat [champ1, valeur1, ...] — voir frames.js.
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

const STATE_KEY = "synopsis:state";

function participantsKey(gameId) {
  return `synopsis:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `synopsis:usernames:${gameId}`;
}
function hintsKey(gameId, discordId) {
  return `synopsis:hints:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `synopsis:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `synopsis:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `synopsis:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `synopsis:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `synopsis:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `synopsis:archived:${seasonId}`;
}

// ── Catalogue (statique, jamais muté) ────────────────────────────

export function gameIdFor(entry) {
  return `s${String(entry.numero).padStart(3, "0")}`;
}

let synopsisCache = null;

export async function loadSynopsis() {
  if (synopsisCache) return synopsisCache;
  synopsisCache = JSON.parse(await fs.readFile(SYNOPSIS_JSON_PATH, "utf-8"));
  return synopsisCache;
}

export async function resolveSynopsis(gameId) {
  return (await loadSynopsis()).find((e) => gameIdFor(e) === gameId) ?? null;
}

// Titre affiché d'une manche — pour le récap de fin de saison.
export async function getSynopsisLabel(gameId) {
  return (await resolveSynopsis(gameId))?.titre ?? null;
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
  await scanDelete(`synopsis:hints:${gameId}:*`);
  await scanDelete(`synopsis:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart au début
// du catalogue) et historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("synopsis:participants:*");
  await scanDelete("synopsis:usernames:*");
  await scanDelete("synopsis:hints:*");
  await scanDelete("synopsis:attempts:*");
  await scanDelete("synopsis:season:*");
  await scanDelete("synopsis:archived:*");
}

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Démarrage d'une manche ───────────────────────────────────────

export function pickNextSynopsisIndex(state, catalogue) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % catalogue.length;
}

// Total projeté = manche attribuée + mercredis restants de la saison.
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, WEDNESDAY);
}

// Idempotent : HSETNX + relecture, jamais deux numéros pour le même gameId.
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

export async function startNewGame(channelId) {
  const catalogue = await loadSynopsis();
  const previousState = await readState();
  const currentIndex = pickNextSynopsisIndex(previousState, catalogue);
  const entry = catalogue[currentIndex];
  const gameId = gameIdFor(entry);
  const seasonId = await getCurrentSeasonId();
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const newState = {
    currentIndex,
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal: computeSeasonMancheTotal(seasonManche, now),
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);

  // Purge la progression jetable de la manche précédente ; les résultats
  // archivés (synopsis:season:*, synopsis:archived:*) ne sont jamais touchés.
  if (previousState?.gameId && previousState.gameId !== gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// ── Garde-fou anti-double-post (même jour UTC que la manche en cours) ──
export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return new Date(state.startedAt).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

// ── Scoring ──────────────────────────────────────────────────────
// Barème de Frame : plancher à 1, trouver rapporte toujours au moins un point.
export function computeScore(attemptsIncorrects, hintsUsedCount) {
  return Math.max(1, 10 - 2 * attemptsIncorrects - 3 * hintsUsedCount);
}

// ── Progression par joueur (primitives atomiques Redis) ──────────

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

export async function recordAttempt(gameId, discordId, username) {
  await touchUsername(gameId, discordId, username);
  await getRedis().incr(attemptsKey(gameId, discordId));
}

// `hintKey` : "indice1" ou "indice2" ; SADD rend chaque indice idempotent.
export async function recordHintUsed(gameId, discordId, username, hintKey) {
  await touchUsername(gameId, discordId, username);
  const added = Number(await getRedis().sadd(hintsKey(gameId, discordId), hintKey));
  return { alreadyUsed: added === 0 };
}

// Idempotent : si déjà résolu, renvoie le résultat existant.
export async function markSolved(gameId, discordId, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) return { participant: existing, score: existing.score };

  const [attemptsRaw, hintsCount] = await Promise.all([
    getRedis().get(attemptsKey(gameId, discordId)),
    getRedis().scard(hintsKey(gameId, discordId)),
  ]);
  const attempts = Number(attemptsRaw) || 0;
  const hintsUsed = Number(hintsCount) || 0;
  const score = computeScore(attempts, hintsUsed);
  const participant = {
    discordId,
    username,
    attempts,
    hintsUsed,
    solved: true,
    solvedAt: new Date().toISOString(),
    score,
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score };
}

// Un joueur a-t-il interagi avec cette manche (indice ou tentative) ? Le
// joueur qui trouve du premier coup sans indice n'a qu'un document
// participant (voir hasPlayedRound dans minijeux.js).
export async function hasPlayerInteracted(gameId, discordId) {
  return (await getRedis().hget(usernamesKey(gameId), discordId)) != null;
}

// ── Résultats archivés (classement de la saison) ─────────────────
// HSETNX : une double soumission n'incrémente jamais deux fois la saison.
export async function archiveSolve(state, entry, discordId, username, score, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    titre: entry.titre,
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

// Tous les résultats archivés, toutes saisons confondues — pour
// miniJeuxHistory.js et miniJeuxStats.js.
export async function getAllArchivedResults() {
  const keys = await scanKeys("synopsis:archived:*");
  if (keys.length === 0) return [];
  const hashes = await Promise.all(keys.map((key) => hgetallJson(key)));
  return hashes.flatMap((hash) => Object.values(hash));
}

export async function getSeasonManches(seasonId) {
  return (await getRedis().hkeys(seasonMancheNumbersKey(seasonId))) || [];
}

export async function getSeasonMancheNumber(seasonId, gameId) {
  const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
  return raw == null ? null : Number(raw);
}

// Aperçu du prochain numéro de manche, sans muter l'état (dry-run).
export async function previewSeasonManche(seasonId) {
  const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
  return seq + 1;
}

// ── Classements ──────────────────────────────────────────────────

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

// Classement avec ex-aequo (« 1224 »).
export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
