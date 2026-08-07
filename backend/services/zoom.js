// ============================================================
// zoom.js — Jeu "Zoom carte" (devine 2 cartes à partir d'un zoom extrême sur
// leurs icônes). Couche métier : lecture du catalogue, état de la partie,
// scoring, classements. Miroir structurel de frames.js/anagrams.js (même
// stockage Upstash Redis, mêmes pièges — automaticDeserialization/HGETALL,
// client paresseux — voir les commentaires détaillés dans frames.js), avec
// une différence structurelle majeure :
//
// Chaque manche affiche 2 cartes ("slots" A et B, gauche/droite) au lieu
// d'une seule. Chaque slot a son propre compteur d'indice, ses propres
// tentatives et son propre statut résolu — un joueur peut marquer des
// points en ne trouvant qu'une seule des deux cartes (score partiel), pas
// besoin des deux. Le score d'une manche pour un joueur est la somme des
// scores de ses slots résolus.
//
// checkAnswer utilise une égalité STRICTE (comme anagrams.js), pas une
// correspondance par sous-chaîne comme Frame — les noms de cartes sont
// courts, un fragment comme "Barbares" accepterait à tort "Barbares
// d'élite".
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
export const SLOTS = ["A", "B"];

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
// de garde-fou anti-spoiler pour getZoomImageByGameId (backend/services/
// zoomImage.js) — même pattern que frame:posted_games (frames.js).
function postedGamesKey() {
  return "zoom:posted_games";
}
function participantsKey(gameId) {
  return `zoom:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `zoom:usernames:${gameId}`;
}
function hintKey(gameId, discordId, slot) {
  return `zoom:hint:${gameId}:${discordId}:${slot}`;
}
function attemptsKey(gameId, discordId, slot) {
  return `zoom:attempts:${gameId}:${discordId}:${slot}`;
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

// Une manche = une paire d'entrées du catalogue, identifiées par leurs id
// respectifs et jointes par "__" (jamais un caractère présent dans un id,
// qui n'est composé que de [a-z0-9-] — voir slugifyCardKey dans
// scripts/generateZoomCatalog.js). Utilisé partout où l'on a besoin des 2
// entrées jouées d'une manche (embed, vérification de réponse, image).
export function resolveZoomPair(catalog, gameId) {
  const [idA, idB] = String(gameId).split("__");
  return {
    entryA: catalog.find((e) => e.id === idA) ?? null,
    entryB: catalog.find((e) => e.id === idB) ?? null,
  };
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

// Remet le jeu à zéro : plus de partie active (la prochaine repart au début
// du catalogue) et historique/scores entièrement effacés.
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
// cache change) — pas de valeur à extraire tant que ça reste 3 copies
// quasi-identiques (voir la remarque équivalente en tête d'anagrams.js).
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

// ── Sélection de la paire et démarrage d'une partie ──────────────

// Progression par ID (pas par index de tableau) : reste correcte même si
// data/zoom/zoom.json est régénéré/complété plus tard (scripts/
// generateZoomCatalog.js peut réordonner ou insérer des entrées sans casser
// la rotation, contrairement à une progression par index qui suppose un
// fichier strictement append-only comme frames.json/anagrams.json).
export function pickNextZoomPair(state, catalog) {
  const n = catalog.length;
  const prevSecondId = state?.gameId?.split("__")?.[1] ?? null;
  const prevIndexB = prevSecondId ? catalog.findIndex((e) => e.id === prevSecondId) : -1;
  const idxA = (prevIndexB + 1) % n;
  let idxB = (idxA + 1) % n;
  // Évite 2 variantes de LA MÊME carte dans une manche (ex. Golem base +
  // Golem évolution en même temps).
  while (catalog[idxB].cardKey === catalog[idxA].cardKey && idxB !== idxA) {
    idxB = (idxB + 1) % n;
  }
  return { idxA, idxB };
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
// calendaire — même principe que Frame (mercredis) / Anagram (samedis), voir
// le commentaire détaillé équivalent dans frames.js.
function countRemainingFridays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, FRIDAY);
}
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingFridays(now);
}

export async function startNewGame(channelId) {
  const catalog = await loadZoomCatalog();
  const previousState = await readState();
  const { idxA, idxB } = pickNextZoomPair(previousState, catalog);
  const entryA = catalog[idxA];
  const entryB = catalog[idxB];
  const gameId = `${entryA.id}__${entryB.id}`;
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

  // Purge la progression (indices/tentatives/participants) de la partie
  // précédente — données jetables une fois la partie terminée. Les
  // résultats archivés (zoom:season:*, nécessaires au total de la saison)
  // ne sont eux jamais supprimés ici.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entryA, entryB };
}

// Garde-fou anti-spoiler pour backend/services/zoomImage.js — un gameId
// n'est servable que s'il a réellement été posté un jour (jamais une
// manche future devinée par construction d'id). Même pattern que
// getFrameImageByGameId (frames.js).
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

// ── Scoring par slot ────────────────────────────────────────────
// hintUsed est un booléen (un seul palier d'indice, contrairement à Frame
// qui en a 2) — le terme de pénalité vaut donc 0 ou 3, jamais plus.

export function computeScore(attemptsIncorrects, hintUsed) {
  return Math.max(0, 10 - 2 * attemptsIncorrects - (hintUsed ? 3 : 0));
}

// ── Progression par joueur, par SLOT ──────────────────────────────
// HSET/SETNX/INCR sont des primitives atomiques côté Redis : deux joueurs
// (ou deux clics rapprochés du même joueur) n'entrent jamais en collision.

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

async function slotHintUsed(gameId, discordId, slot) {
  return (await getRedis().get(hintKey(gameId, discordId, slot))) === "1";
}

async function countSlotAttempts(gameId, discordId, slot) {
  const n = await getRedis().get(attemptsKey(gameId, discordId, slot));
  return Number(n) || 0;
}

export async function recordSlotAttempt(gameId, discordId, slot, username, isCorrect) {
  await touchUsername(gameId, discordId, username);
  if (isCorrect) return; // la tentative gagnante n'est jamais comptée comme incorrecte
  await getRedis().incr(attemptsKey(gameId, discordId, slot));
}

// Un seul palier d'indice : un simple flag SETNX suffit (pas besoin de
// SADD/SCARD comme Frame, qui a 2 indices indépendants par manche).
export async function recordSlotHintUsed(gameId, discordId, slot, username) {
  await touchUsername(gameId, discordId, username);
  const wasSet = Number(await getRedis().setnx(hintKey(gameId, discordId, slot), "1"));
  return { alreadyUsed: wasSet === 0 };
}

// Idempotent PAR SLOT : si ce slot est déjà résolu, renvoie le résultat
// existant sans rien réécrire. Met aussi à jour le total combiné et le
// statut "fullySolved" (les 2 slots résolus) du participant.
export async function markSlotSolved(gameId, discordId, slot, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.slots?.[slot]?.solved) {
    return {
      participant: existing,
      score: existing.slots[slot].score,
      fullySolved: !!existing.fullySolved,
      justCompleted: false,
    };
  }

  const [hintUsed, attempts] = await Promise.all([
    slotHintUsed(gameId, discordId, slot),
    countSlotAttempts(gameId, discordId, slot),
  ]);
  const score = computeScore(attempts, hintUsed);
  const solvedAt = new Date().toISOString();
  const otherSlot = slot === "A" ? "B" : "A";
  const otherSlotState = existing?.slots?.[otherSlot];
  const otherSolved = !!otherSlotState?.solved;

  const participant = {
    discordId,
    username,
    slots: {
      ...(existing?.slots ?? {}),
      [slot]: { solved: true, solvedAt, score, attempts, hintUsed },
    },
    totalScore: (otherSlotState?.score ?? 0) + score,
    fullySolved: otherSolved,
    fullySolvedAt: otherSolved ? solvedAt : null,
  };

  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score, fullySolved: otherSolved, justCompleted: otherSolved };
}

// ── Résultats archivés (classement de la saison) ─────────────────
// Archivage PAR SLOT dès qu'il est résolu (pas seulement quand les 2 slots
// le sont) : un joueur qui ne trouve qu'une seule des 2 cartes garde ses
// points au classement de saison, il n'a pas besoin de finir la manche en
// entier.

export async function archiveSlotSolve(state, entry, discordId, username, slot, score, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}:${slot}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    slot,
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

// Tous les résultats archivés d'un joueur pour une saison donnée (une entrée
// par SLOT résolu, pas par manche) — utilisé par /zoom pour l'historique
// personnel. Le regroupement par manche (somme des 2 slots) est fait par la
// couche d'affichage (api/discord/handlers/zoom.js), pas ici.
export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}:A`) || field.endsWith(`:${discordId}:B`))
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

// "Label" français d'une manche pour le récap de fin de saison — les 2
// réponses jointes, ex. "Bébé dragon & Reine des archers".
export async function getZoomRoundLabel(gameId) {
  const catalog = await loadZoomCatalog();
  const { entryA, entryB } = resolveZoomPair(catalog, gameId);
  if (!entryA || !entryB) return null;
  return `${entryA.answer} & ${entryB.answer}`;
}

// Un joueur a-t-il interagi avec cette manche (indice pris ou tentative),
// qu'il ait résolu ou non ?
export async function hasPlayerInteracted(gameId, discordId) {
  const username = await getRedis().hget(usernamesKey(gameId), discordId);
  return username != null;
}

// ── Classements ──────────────────────────────────────────────────

// Classement PAR MANCHE : inclut les résolutions PARTIELLES (un seul slot
// trouvé), contrairement à Frame qui n'inclut que les joueurs ayant
// complètement résolu la manche — la progression partielle est une donnée
// significative ici.
export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => (p?.totalScore ?? 0) > 0)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      totalScore: p.totalScore,
      fullySolved: p.fullySolved,
      slots: p.slots,
    }))
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      const aLast = a.fullySolvedAt || a.slots?.A?.solvedAt || a.slots?.B?.solvedAt;
      const bLast = b.fullySolvedAt || b.slots?.A?.solvedAt || b.slots?.B?.solvedAt;
      return new Date(aLast) - new Date(bLast);
    });
}

// Ordre d'arrivée des joueurs ayant trouvé les 2 cartes (fullySolved) — pour
// le DM "tu es le Nᵉ à avoir tout trouvé !". Une résolution partielle n'est
// pas un événement d'"arrivée" pertinent à classer.
export async function computeFullSolveArrivalOrder(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.fullySolved)
    .map((p) => ({ discordId: p.discordId, username: p.username, totalScore: p.totalScore, fullySolvedAt: p.fullySolvedAt }))
    .sort((a, b) => new Date(a.fullySolvedAt) - new Date(b.fullySolvedAt));
}

// Tous les joueurs ayant interagi avec la partie mais n'ayant trouvé aucune
// carte (ni A ni B) — pour l'affichage "en cours" du récap.
export async function listGamePlayersInProgress(gameId) {
  const [participants, usernames] = await Promise.all([
    hgetallJson(participantsKey(gameId)),
    hgetallRaw(usernamesKey(gameId)),
  ]);
  const anySolvedIds = new Set(
    Object.values(participants)
      .filter((p) => (p?.totalScore ?? 0) > 0)
      .map((p) => p.discordId),
  );
  return Object.entries(usernames)
    .filter(([discordId]) => !anySolvedIds.has(discordId))
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

// Position (1-indexée) dans la liste déjà triée passée en paramètre.
export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}

// Classement avec ex-aequo ("1224").
export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
