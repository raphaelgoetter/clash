// ============================================================
// platpays.js — Jeu "Plat Pays" (devine le pays d'origine d'un plat à partir
// de sa photo),
// groupe "Coup d'œil" du vendredi (voir refonte.js), en alternance avec
// Zoom logo. Couche métier : état Redis, tirage, vérification, scoring,
// classements. Même mécanique que Frame (frames.js) : réponse libre via
// Modal, deux indices (ingrédients, continent) et tentatives incorrectes comptés
// par joueur, score figé à la résolution. Les deux indices n'ont pas le même
// coût (voir HINT_COSTS).
//
// Catalogue jeux/data/jeux-visuels/platpays/platpays.json, parcouru dans
// l'ordre du fichier, en boucle. gameId = `p` + numéro zéro-paddé (p001…) :
// ne jamais réordonner le fichier une fois joué, ajouter en fin. Photos
// (Wikimedia Commons, crédit dans le catalogue) servies uniquement par
// platpaysImage.js, gardées par le registre `platpays:posted_games`.
//
// ⚠️ automaticDeserialization désactivée : voir frames.js (IDs Discord).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";

import { normalizeAnswer } from "@clash/commun/textNormalize.js";

const FRIDAY = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATPAYS_JSON_PATH = path.resolve(__dirname, "..", "data", "jeux-visuels", "platpays", "platpays.json");

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

const STATE_KEY = "platpays:state";

function participantsKey(gameId) {
  return `platpays:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `platpays:usernames:${gameId}`;
}
function hintsKey(gameId, discordId) {
  return `platpays:hints:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `platpays:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `platpays:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `platpays:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `platpays:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `platpays:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `platpays:archived:${seasonId}`;
}
function postedGamesKey() {
  return "platpays:posted_games";
}

// ── Catalogue (statique, jamais muté) ────────────────────────────

export function gameIdFor(entry) {
  return `p${String(entry.numero).padStart(3, "0")}`;
}

let platsCache = null;

export async function loadPlats() {
  if (platsCache) return platsCache;
  platsCache = JSON.parse(await fs.readFile(PLATPAYS_JSON_PATH, "utf-8"));
  return platsCache;
}

export async function resolvePlat(gameId) {
  return (await loadPlats()).find((e) => gameIdFor(e) === gameId) ?? null;
}

// Libellé d'une manche (« Ramen (Japon) ») — pour le récap de fin de saison.
export async function getPlatLabel(gameId) {
  const entry = await resolvePlat(gameId);
  return entry ? `${entry.plat} (${paysAffiche(entry)})` : null;
}

// Pays affiché à la résolution : `origine` (« Mali ou Sénégal ») quand deux
// pays revendiquent le plat (le second est alors dans `accepte`), sinon `pays`.
export function paysAffiche(entry) {
  return entry.origine ?? entry.pays;
}

// ── Vérification de la réponse ──────────────────────────────────
// Égalité stricte (comme Zoom carte), pas de sous-chaîne comme Frame :
// « niger » ne doit pas valider « nigeria ». Les articles et prépositions de
// tête sont ignorés (« le Japon », « au Japon », « l'Inde »).
const LEADING_WORDS = /^((le|la|les|l|au|aux|en|du|de|des)\s+)+/;

function normalizeCountry(str) {
  return normalizeAnswer(str).replace(LEADING_WORDS, "");
}

export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeCountry(rawAnswer);
  if (!normalized) return false;
  return [entry.pays, ...(entry.accepte || [])].map(normalizeCountry).includes(normalized);
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
  await scanDelete(`platpays:hints:${gameId}:*`);
  await scanDelete(`platpays:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart au début
// du catalogue) et historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("platpays:participants:*");
  await scanDelete("platpays:usernames:*");
  await scanDelete("platpays:hints:*");
  await scanDelete("platpays:attempts:*");
  await scanDelete("platpays:season:*");
  await scanDelete("platpays:archived:*");
  await getRedis().del(postedGamesKey());
}

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Démarrage d'une manche ───────────────────────────────────────

export function pickNextPlatIndex(state, catalogue) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % catalogue.length;
}

// Total projeté = manche attribuée + vendredis restants de la saison.
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, FRIDAY);
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
  const catalogue = await loadPlats();
  const previousState = await readState();
  const currentIndex = pickNextPlatIndex(previousState, catalogue);
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
  await getRedis().sadd(postedGamesKey(), gameId);

  // Purge la progression jetable de la manche précédente ; les résultats
  // archivés (platpays:season:*, platpays:archived:*) ne sont jamais touchés.
  if (previousState?.gameId && previousState.gameId !== gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// Garde-fou anti-spoiler de platpaysImage.js : jamais la photo d'une manche
// pas encore postée. Registre jamais nettoyé (même pattern que zoom.js).
export async function isGamePosted(gameId) {
  return Number(await getRedis().sismember(postedGamesKey(), gameId)) === 1;
}

// ── Garde-fou anti-double-post (même jour UTC que la manche en cours) ──
export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return new Date(state.startedAt).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

// ── Scoring ──────────────────────────────────────────────────────
// Indices : champ du catalogue révélé et coût. Les ingrédients aident moins
// que le continent.
export const HINT_FIELDS = { indice1: "ingredients", indice2: "continent" };
export const HINT_COSTS = { indice1: 1, indice2: 3 };

// −1 par réponse fausse (et non −2 comme Frame) : certains pays restent
// très difficiles à trouver même en connaissant le continent.
export const WRONG_ANSWER_COST = 1;

// Plancher à 1 : trouver rapporte toujours au moins un point.
export function computeScore(attemptsIncorrects, hintsUsed) {
  const hintsCost = hintsUsed.reduce((sum, key) => sum + (HINT_COSTS[key] ?? 0), 0);
  return Math.max(1, 10 - WRONG_ANSWER_COST * attemptsIncorrects - hintsCost);
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

  const [attemptsRaw, hints] = await Promise.all([
    getRedis().get(attemptsKey(gameId, discordId)),
    getRedis().smembers(hintsKey(gameId, discordId)),
  ]);
  const attempts = Number(attemptsRaw) || 0;
  const hintsUsed = (hints || []).map(String);
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
    plat: entry.plat,
    pays: entry.pays,
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
  const keys = await scanKeys("platpays:archived:*");
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
