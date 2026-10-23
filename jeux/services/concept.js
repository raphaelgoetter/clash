// ============================================================
// concept.js — Jeu "Concept" (devine le film, l'expression, la chanson…
// cachés derrière une suite d'emojis), groupe "Jeux de mots" du samedi
// (voir refonte.js). Couche métier : état Redis, tirage, vérification,
// scoring, classements. Même mécanique que Frame (frames.js) : réponse
// libre via Modal, tentatives incorrectes et indice comptés par joueur,
// score figé à la résolution. La catégorie est affichée d'office ; le seul
// indice payant est le masque de la réponse (une case par lettre).
//
// Catalogue jeux/data/concept/concepts.json (importé d'UniClaude, trié à la
// main), parcouru dans l'ordre du fichier, en boucle. gameId = `c` + numéro
// zéro-paddé (c001…) : ne jamais réordonner le fichier une fois joué,
// ajouter en fin.
//
// ⚠️ automaticDeserialization désactivée : voir frames.js (IDs Discord).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";

const SATURDAY = 6;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONCEPTS_JSON_PATH = path.resolve(__dirname, "..", "data", "concept", "concepts.json");

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

const STATE_KEY = "concept:state";

function participantsKey(gameId) {
  return `concept:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `concept:usernames:${gameId}`;
}
function hintKey(gameId, discordId) {
  return `concept:hint:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `concept:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `concept:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `concept:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `concept:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `concept:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `concept:archived:${seasonId}`;
}

// ── Catalogue (statique, jamais muté) ────────────────────────────

export function gameIdFor(entry) {
  return `c${String(entry.numero).padStart(3, "0")}`;
}

let conceptsCache = null;

export async function loadConcepts() {
  if (conceptsCache) return conceptsCache;
  conceptsCache = JSON.parse(await fs.readFile(CONCEPTS_JSON_PATH, "utf-8"));
  return conceptsCache;
}

export async function resolveConcept(gameId) {
  return (await loadConcepts()).find((e) => gameIdFor(e) === gameId) ?? null;
}

// Réponse affichée d'une manche — pour le récap de fin de saison.
export async function getConceptLabel(gameId) {
  return (await resolveConcept(gameId))?.reponse ?? null;
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
  await scanDelete(`concept:hint:${gameId}:*`);
  await scanDelete(`concept:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart au début
// du catalogue) et historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("concept:participants:*");
  await scanDelete("concept:usernames:*");
  await scanDelete("concept:hint:*");
  await scanDelete("concept:attempts:*");
  await scanDelete("concept:season:*");
  await scanDelete("concept:archived:*");
}

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Démarrage d'une manche ───────────────────────────────────────

export function pickNextConceptIndex(state, concepts) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % concepts.length;
}

// Total projeté = manche attribuée + samedis restants de la saison.
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, SATURDAY);
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
  const concepts = await loadConcepts();
  const previousState = await readState();
  const currentIndex = pickNextConceptIndex(previousState, concepts);
  const entry = concepts[currentIndex];
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
  // archivés (concept:season:*, concept:archived:*) ne sont jamais touchés.
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

// ── Vérification de la réponse ───────────────────────────────────
// Contrairement à Frame (sous-chaîne), un terme accepté doit apparaître en
// MOTS ENTIERS : « up » ne doit pas valider « supermarché ». normalizeAnswer
// ne décompose pas les ligatures, d'où le remplacement préalable de œ/æ.

export function normalizeConcept(str) {
  return normalizeAnswer(String(str ?? "").replace(/œ/gi, "oe").replace(/æ/gi, "ae"));
}

function containsWords(normalizedText, term) {
  const t = normalizeConcept(term);
  return t !== "" && ` ${normalizedText} `.includes(` ${t} `);
}

export function checkAnswer(entry, rawAnswer) {
  const normalized = normalizeConcept(rawAnswer);
  if (!normalized) return false;
  if ((entry.refuse || []).some((term) => containsWords(normalized, term))) return false;
  return (entry.accepte || []).some((term) => containsWords(normalized, term));
}

// ── Indice : masque de la réponse ────────────────────────────────
// Une case « _ » par lettre ou chiffre de `solution` (la réponse « propre »,
// sans parenthèse), mots séparés par trois espaces ; la ponctuation
// (apostrophe, tiret, point, &, !) reste visible. Affiché dans un bloc de
// code inline, sinon Discord interprète les « _ » comme de l'italique.
export function buildMasque(solution) {
  const mots = String(solution).trim().split(/\s+/);
  const masque = mots
    .map((mot) => [...mot].map((c) => (/[\p{L}\p{N}]/u.test(c) ? "_" : c)).join(" "))
    .join("   ");
  const lettres = mots
    .map((mot) => [...mot].filter((c) => /[\p{L}\p{N}]/u.test(c)).length)
    .filter((n) => n > 0);
  return { masque, lettres };
}

// ── Scoring ──────────────────────────────────────────────────────
// Barème de Frame, avec un seul indice : plancher à 1, trouver rapporte
// toujours au moins un point.
export function computeScore(attemptsIncorrects, hintUsed) {
  return Math.max(1, 10 - 2 * attemptsIncorrects - (hintUsed ? 3 : 0));
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

export async function recordHintUsed(gameId, discordId, username) {
  await touchUsername(gameId, discordId, username);
  const wasSet = await getRedis().set(hintKey(gameId, discordId), "1", { nx: true });
  return { alreadyUsed: wasSet !== "OK" };
}

// Idempotent : si déjà résolu, renvoie le résultat existant.
export async function markSolved(gameId, discordId, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) return { participant: existing, score: existing.score };

  const [attemptsRaw, hintRaw] = await Promise.all([
    getRedis().get(attemptsKey(gameId, discordId)),
    getRedis().get(hintKey(gameId, discordId)),
  ]);
  const attempts = Number(attemptsRaw) || 0;
  const score = computeScore(attempts, hintRaw != null);
  const participant = {
    discordId,
    username,
    attempts,
    hintUsed: hintRaw != null,
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
    reponse: entry.reponse,
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
  const keys = await scanKeys("concept:archived:*");
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
