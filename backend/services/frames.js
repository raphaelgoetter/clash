// ============================================================
// frames.js — Jeu "Frame" (devine le film à partir d'une image)
// Couche métier : lecture des frames, état de la partie, scoring,
// classements.
//
// Stockage : Upstash Redis (via @upstash/redis, REST — compatible
// serverless). Choisi après avoir découvert que Vercel Blob facture
// chaque put()/list() comme "Advanced Operation" avec un quota gratuit
// très bas (2 000/mois) — largement dépassé par l'usage normal du jeu
// (indices, tentatives, résolutions). Upstash offre 500 000 commandes/mois
// gratuites, et surtout des primitives ATOMIQUES natives (INCR, SADD,
// HSETNX, ZINCRBY) qui résolvent nativement les problèmes de concurrence
// qu'on a dû bricoler à la main avec Blob (verrou optimiste, sharding par
// fichier) — plus besoin de rien de tout ça ici.
//
// ⚠️ automaticDeserialization désactivée volontairement : le SDK convertit
// par défaut toute valeur "numérique" en Number JS, y compris les IDs
// Discord (17-19 chiffres) qui dépassent Number.MAX_SAFE_INTEGER — ça les
// corrompt silencieusement (perte de précision). On sérialise/désérialise
// le JSON nous-mêmes partout ci-dessous pour rester en contrôle exact des
// types (discordId toujours string).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.resolve(__dirname, "..", "..", "data", "frames");
const FRAMES_JSON_PATH = path.join(FRAMES_DIR, "frames.json");
const FRAMES_IMAGES_DIR = path.join(FRAMES_DIR, "images");

// Construction paresseuse (pas au chargement du module) : avec les imports
// ES hoistés, "import ... from frames.js" s'exécute avant le
// dotenv.config() du script appelant — construire le client ici en top-level
// figerait des variables d'env pas encore chargées. Voir scripts/*.js qui
// font tous import dotenv + dotenv.config() puis import frames.js.
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

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau
// plat [champ1, valeur1, champ2, valeur2, ...] et non un objet — vérifié
// empiriquement (pas documenté explicitement par le SDK).
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

const STATE_KEY = "frame:state";
const HINT_KEYS = ["indice1", "indice2"];

function participantsKey(gameId) {
  return `frame:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `frame:usernames:${gameId}`;
}
function hintsKey(gameId, discordId) {
  return `frame:hints:${gameId}:${discordId}`;
}
function attemptsKey(gameId, discordId) {
  return `frame:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `frame:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `frame:season:${seasonId}:pseudos`;
}
function seasonManchesKey(seasonId) {
  return `frame:season:${seasonId}:manches`;
}
function archivedKey(seasonId) {
  return `frame:archived:${seasonId}`;
}

// SCAN par motif — uniquement utilisé pour le nettoyage (rare : une fois par
// semaine au démarrage d'une partie, ou lors d'un reset manuel), jamais sur
// le chemin critique d'une interaction joueur.
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

// ── Lecture des frames (statique, jamais mutée) ────────────────

let framesCache = null;

export async function loadFrames() {
  if (framesCache) return framesCache;
  const txt = await fs.readFile(FRAMES_JSON_PATH, "utf-8");
  framesCache = JSON.parse(txt);
  return framesCache;
}

// Sert uniquement l'image de la partie active — jamais une image future ou
// passée par nom de fichier, pour ne pas laisser deviner les prochaines
// semaines via l'URL (data/frames/images n'est pas exposé statiquement).
export async function getCurrentFrameImage() {
  const state = await readState();
  if (!state) return null;
  const frames = await loadFrames();
  const frameEntry = frames[state.currentIndex];
  if (!frameEntry) return null;
  try {
    const buffer = await fs.readFile(path.join(FRAMES_IMAGES_DIR, frameEntry.image));
    return { buffer, filename: frameEntry.image };
  } catch {
    return null;
  }
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
  await scanDelete(`frame:hints:${gameId}:*`);
  await scanDelete(`frame:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart à
// l'index 0 de frames.json) et historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("frame:participants:*");
  await scanDelete("frame:usernames:*");
  await scanDelete("frame:hints:*");
  await scanDelete("frame:attempts:*");
  await scanDelete("frame:season:*");
  await scanDelete("frame:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────

export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "frames:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      // Une partie ne démarre qu'une fois par semaine : quelques tentatives
      // suffisent à absorber un aléa réseau transitoire plutôt que de figer
      // définitivement un seasonId à null pour toute la partie.
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

// ── Sélection de l'image et démarrage d'une partie ──────────────

export function pickNextFrameIndex(state, frames) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % frames.length;
}

export async function startNewGame(channelId) {
  const frames = await loadFrames();
  const previousState = await readState();
  const currentIndex = pickNextFrameIndex(previousState, frames);
  const frameEntry = frames[currentIndex];
  const seasonId = await getCurrentSeasonId();

  const newState = {
    currentIndex,
    gameId: path.parse(frameEntry.image).name,
    seasonId,
    startedAt: new Date().toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);

  // Enregistre cette manche comme faisant partie de la saison — permet à
  // /frame de lister TOUTES les manches passées de la saison (y compris
  // celles où le joueur n'a pas joué), pas seulement celles où il a un
  // résultat archivé.
  await getRedis().sadd(seasonManchesKey(seasonId), newState.gameId);

  // Purge la progression (indices/tentatives/participants) de la partie
  // précédente — données jetables une fois la partie terminée. Les
  // résultats archivés (frame:season:*, nécessaires au total de la saison)
  // ne sont eux jamais supprimés ici.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, frameEntry };
}

// ── Normalisation et vérification de la réponse ─────────────────

export function normalizeAnswer(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function checkAnswer(frameEntry, rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return false;

  const refuse = (frameEntry.refuse || []).map(normalizeAnswer);
  if (refuse.some((term) => term && normalized.includes(term))) {
    return false;
  }

  const accepte = (frameEntry.accepte || []).map(normalizeAnswer);
  return accepte.some((term) => term && normalized.includes(term));
}

// ── Scoring ──────────────────────────────────────────────────────

export function computeScore(attemptsIncorrects, hintsUsedCount) {
  return Math.max(0, 10 - 2 * attemptsIncorrects - 3 * hintsUsedCount);
}

// ── Progression par joueur ────────────────────────────────────────
// HSET/SADD/INCR sont des primitives atomiques côté Redis : deux joueurs
// (ou deux clics rapprochés du même joueur) n'entrent jamais en collision,
// sans avoir besoin d'aucun verrou ni retry applicatif.

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

// Nombre d'indices déjà utilisés par ce joueur.
async function countHintsUsed(gameId, discordId) {
  return Number(await getRedis().scard(hintsKey(gameId, discordId))) || 0;
}

async function countAttempts(gameId, discordId) {
  const n = await getRedis().get(attemptsKey(gameId, discordId));
  return Number(n) || 0;
}

export async function recordAttempt(gameId, discordId, username, isCorrect) {
  await touchUsername(gameId, discordId, username);
  if (isCorrect) return null; // la tentative gagnante n'est jamais comptée comme incorrecte
  await getRedis().incr(attemptsKey(gameId, discordId));
  return null;
}

export async function recordHintUsed(gameId, discordId, username, hintKey) {
  await touchUsername(gameId, discordId, username);
  const added = Number(await getRedis().sadd(hintsKey(gameId, discordId), hintKey));
  return { alreadyUsed: added === 0 };
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien
// réécrire. Sinon calcule le score à partir des compteurs indices/tentatives
// (déjà atomiques) et écrit le document final.
export async function markSolved(gameId, discordId, username) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) {
    return { participant: existing, score: existing.score };
  }

  const [hintsUsedCount, attemptsCount] = await Promise.all([
    countHintsUsed(gameId, discordId),
    countAttempts(gameId, discordId),
  ]);
  const score = computeScore(attemptsCount, hintsUsedCount);
  const participant = {
    discordId,
    username,
    attempts: attemptsCount,
    solved: true,
    solvedAt: new Date().toISOString(),
    score,
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score };
}

// ── Résultats archivés (classement de la saison) ─────────────────
// ZSET Redis : le score total et le classement sont maintenus par Redis
// lui-même (ZINCRBY/ZRANGE), pas recalculés côté code à chaque lecture.
// HSETNX est atomique : si deux appels concurrents archivent la même
// résolution (double soumission), un seul incrémente réellement le score
// de saison — pas de double-comptage possible.

export async function archiveSolve(state, frameEntry, discordId, username, score, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    titre: frameEntry.titre,
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

// Tous les résultats archivés d'un joueur pour une saison donnée (une
// entrée par manche trouvée). Utilisé par /frame pour afficher l'historique
// personnel — un seul HGETALL (déjà utilisé ailleurs), filtré côté code sur
// le suffixe ":<discordId>" du champ (`<gameId>:<discordId>`).
export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

// Tous les gameId des manches postées cette saison (résolues ou non par qui
// que ce soit) — alimenté par startNewGame(). Permet de lister les manches
// passées où un joueur n'a pas du tout joué, pas seulement celles où il a
// un résultat archivé.
export async function getSeasonManches(seasonId) {
  const ids = await getRedis().smembers(seasonManchesKey(seasonId));
  return ids || [];
}

// Un joueur a-t-il interagi avec cette manche (indice pris ou tentative),
// qu'il ait résolu ou non ? frame:usernames est mis à jour à chaque indice/
// tentative — mais pas si le joueur trouve du premier coup sans indice, où
// seul markSolved() écrit directement le document participant.
export async function hasPlayerInteracted(gameId, discordId) {
  const username = await getRedis().hget(usernamesKey(gameId), discordId);
  return username != null;
}

// Position (1-indexée) d'une partie dans frames.json — c'est ce numéro qui
// est affiché comme "Manche N" partout dans le jeu (post, DM, /frame).
export async function getMancheNumber(gameId) {
  const frames = await loadFrames();
  const idx = frames.findIndex((f) => path.parse(f.image).name === gameId);
  return idx === -1 ? null : idx + 1;
}

// ── Classements ──────────────────────────────────────────────────

export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      score: p.score,
      solvedAt: p.solvedAt,
    }))
    .sort((a, b) => b.score - a.score || new Date(a.solvedAt) - new Date(b.solvedAt));
}

// Tous les joueurs ayant interagi avec la partie mais pas encore résolu —
// frame:usernames est mis à jour à chaque indice/tentative, donc même un
// joueur sans document participant (pas encore résolu) y apparaît.
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
