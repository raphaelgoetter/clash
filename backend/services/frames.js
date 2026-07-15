// ============================================================
// frames.js — Jeu "Frame" (devine le film à partir d'une image)
// Couche métier : lecture des frames, état de la partie, scoring,
// classements.
//
// Stockage : frames_state.json (métadonnées de la partie, peu de
// contention) reste un seul objet Blob. En revanche la progression de
// CHAQUE joueur (frames_participants/<gameId>/<discordId>.json) et son
// résultat archivé (frames_results/<gameId>/<discordId>.json) sont
// éclatés en un objet Blob PAR JOUEUR : deux joueurs différents n'écrivent
// alors jamais la même clé, donc aucune collision possible entre eux —
// contrairement à un unique fichier partagé, où un lire-modifier-écrire
// concurrent peut silencieusement perdre la contribution d'un joueur (testé
// et confirmé : même un verrou optimiste par ETag ne suffit pas ici, Vercel
// Blob ayant un délai de réplication qui peut faire relire une version
// périmée juste après un conflit).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet, invalidate } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.resolve(__dirname, "..", "..", "data", "frames");
const FRAMES_JSON_PATH = path.join(FRAMES_DIR, "frames.json");
const FRAMES_IMAGES_DIR = path.join(FRAMES_DIR, "images");

const STATE_FILE = "frames_state.json";
const PARTICIPANTS_PREFIX = "frames_participants";
const RESULTS_PREFIX = "frames_results";

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

// ── Helpers fichiers locaux (fallback dev) ──────────────────────

async function readJsonSafe(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

async function writeJsonSafe(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function dataFilePath(name) {
  return path.resolve(__dirname, "..", "..", "data", name);
}

// ── Blob helpers (copiés/adaptés de championPredictions.js) ─────

function useBlob() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function tmpPath(name) {
  return `/tmp/${name}`;
}

function blobStoreId() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return token.split("_")[3] || null;
}

function blobUrlFor(path) {
  const storeId = blobStoreId();
  if (!storeId) return null;
  return `https://${storeId}.private.blob.vercel-storage.com/${path}`;
}

async function readFromBlob(path) {
  const url = blobUrlFor(path);
  if (!url) return null;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function writeToBlob(path, data) {
  try {
    const { put } = await import("@vercel/blob");
    await put(path, JSON.stringify(data), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
  } catch (err) {
    console.error(`[Blob] Écriture échouée ${path}:`, err.message);
  }
}

// ── Lecture/écriture générique 3 niveaux (tmp → Blob → data/ + cache) ──

async function readJsonThreeTier(fileName, cacheKey, defaultValue = null) {
  const local = await readJsonSafe(tmpPath(fileName));
  if (local) return local;

  if (useBlob()) {
    const data = await readFromBlob(fileName);
    if (data) {
      await writeJsonSafe(tmpPath(fileName), data).catch(() => {});
      return data;
    }
    return defaultValue;
  }
  const { value } = await getOrSet(
    cacheKey,
    async () => (await readJsonSafe(dataFilePath(fileName))) ?? defaultValue,
    30 * 1000,
  );
  return value;
}

async function writeJsonThreeTier(fileName, data, cacheKey) {
  await writeJsonSafe(tmpPath(fileName), data).catch(() => {});
  if (useBlob()) {
    await writeToBlob(fileName, data);
  } else {
    await writeJsonSafe(dataFilePath(fileName), data).catch(() => {});
    if (cacheKey) invalidate(cacheKey);
  }
}

// ── Verrou optimiste (ETag) — utilisé uniquement pour des clés à faible
// contention (un seul joueur écrit sa propre clé la plupart du temps ; ça
// protège juste contre un double-clic très rapproché du même joueur). Pour
// des clés à FORTE contention (plusieurs joueurs sur le même objet), voir
// le sharding par joueur ci-dessous — ce verrou seul n'y suffit pas.

async function readBlobWithEtag(path) {
  const url = blobUrlFor(path);
  if (!url) return { data: null, etag: null };
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  for (const delay of [0, 400, 800]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${url}?_=${Date.now()}-${Math.random()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return { data: null, etag: null };
      if (res.ok) {
        const data = await res.json();
        return { data, etag: res.headers.get("etag") };
      }
    } catch {}
  }
  return { data: null, etag: null };
}

async function writeBlobWithCas(path, data, etag) {
  try {
    const { put } = await import("@vercel/blob");
    await put(path, JSON.stringify(data), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      ...(etag ? { ifMatch: etag } : {}),
    });
    return true;
  } catch (err) {
    console.error(`[Blob] Écriture CAS échouée ${path}:`, err.message);
    return false;
  }
}

// mutateFn(doc) reçoit le document courant (ou null s'il n'existe pas encore)
// et doit retourner { doc, returnValue } — doc étant le document complet à
// persister, returnValue ce qu'on souhaite renvoyer à l'appelant.
async function mutateJsonWithCas(fileName, cacheKey, mutateFn, { maxAttempts = 8 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let doc, etag;
    if (useBlob()) {
      ({ data: doc, etag } = await readBlobWithEtag(fileName));
    } else {
      doc = await readJsonSafe(dataFilePath(fileName));
    }

    const { doc: nextDoc, returnValue } = mutateFn(doc);

    await writeJsonSafe(tmpPath(fileName), nextDoc).catch(() => {});

    if (useBlob()) {
      const ok = await writeBlobWithCas(fileName, nextDoc, etag);
      if (ok) return returnValue;
      const backoff = Math.min(1500, 50 * 2 ** attempt) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    await writeJsonSafe(dataFilePath(fileName), nextDoc).catch(() => {});
    invalidate(cacheKey);
    return returnValue;
  }
  throw new Error(
    `Conflit d'écriture persistant sur ${fileName} après ${maxAttempts} tentatives.`,
  );
}

// ── Listage éclaté (Blob list() par préfixe / répertoire local) ─────

async function listSharded(prefixNoSlash) {
  if (useBlob()) {
    const { list } = await import("@vercel/blob");
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const prefix = `${prefixNoSlash}/`;
    let cursor;
    const blobs = [];
    do {
      const res = await list({ prefix, cursor, token, limit: 1000 }).catch(() => ({
        blobs: [],
        hasMore: false,
      }));
      blobs.push(...res.blobs);
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);

    const docs = await Promise.all(
      blobs.map(async (b) => {
        try {
          const res = await fetch(b.url, {
            headers: { authorization: `Bearer ${token}` },
          });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      }),
    );
    return docs.filter(Boolean);
  }

  const dir = path.resolve(__dirname, "..", "..", "data", prefixNoSlash);
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    const docs = await Promise.all(
      entries
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJsonSafe(path.join(dir, f))),
    );
    return docs.filter(Boolean);
  } catch {
    return [];
  }
}

async function delSharded(prefixNoSlash) {
  if (useBlob()) {
    const { del, list } = await import("@vercel/blob");
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const prefix = `${prefixNoSlash}/`;
    let cursor;
    do {
      const res = await list({ prefix, cursor, token, limit: 1000 }).catch(() => ({
        blobs: [],
        hasMore: false,
      }));
      if (res.blobs.length) {
        await del(res.blobs.map((b) => b.url), { token }).catch(() => {});
      }
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
    return;
  }
  await fs
    .rm(path.resolve(__dirname, "..", "..", "data", prefixNoSlash), {
      recursive: true,
      force: true,
    })
    .catch(() => {});
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return readJsonThreeTier(STATE_FILE, "frames:state", null);
}

export async function writeState(state) {
  return writeJsonThreeTier(STATE_FILE, state, "frames:state");
}

// Remet le jeu à zéro : plus de partie active (la prochaine repart à
// l'index 0 de frames.json) et historique/scores entièrement effacés.
export async function resetGame() {
  await fs.rm(tmpPath(STATE_FILE), { force: true }).catch(() => {});
  await fs.rm(dataFilePath(STATE_FILE), { force: true }).catch(() => {});
  invalidate("frames:state");

  if (useBlob()) {
    const { del } = await import("@vercel/blob");
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const url = blobUrlFor(STATE_FILE);
    if (url) await del(url, { token }).catch(() => {});
  }

  await delSharded(PARTICIPANTS_PREFIX);
  await delSharded(RESULTS_PREFIX);
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

  // Purge la progression (indices/tentatives/participants) de la partie
  // précédente — données jetables une fois la partie terminée, plus
  // jamais lues. Sans ça, ces petits fichiers s'accumuleraient sans fin au
  // fil des semaines. Les résultats archivés (frames_results, nécessaires
  // au total de la saison) ne sont eux jamais supprimés ici.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await delSharded(`${PARTICIPANTS_PREFIX}/${previousState.gameId}`).catch(() => {});
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

// ── Progression par joueur (frames_participants/<gameId>/<discordId>) ──
// Une clé Blob PAR joueur : deux joueurs différents n'écrivent jamais le
// même objet, donc aucune collision possible entre eux.

// Les indices sont des marqueurs indépendants par type d'indice
// (frames_participants/<gameId>/<discordId>/hints/<hintKey>.json), écrits
// sans verrou (simple création idempotente) plutôt que dans le document
// principal du joueur — un joueur qui clique "Indice 1" et "Indice 2"
// quasi simultanément n'écrit alors jamais la même clé deux fois, donc
// aucun conflit possible entre ces deux clics (contrairement à un compteur
// partagé, où un verrou optimiste seul s'est révélé insuffisant en test
// sous forte contention).
const HINT_KEYS = ["indice1", "indice2"];

function participantKey(gameId, discordId) {
  return `${PARTICIPANTS_PREFIX}/${gameId}/${discordId}.json`;
}

function hintMarkerKey(gameId, discordId, hintKey) {
  return `${PARTICIPANTS_PREFIX}/${gameId}/${discordId}/hints/${hintKey}.json`;
}

function defaultParticipant(discordId, username) {
  return {
    discordId,
    username,
    attempts: 0,
    solved: false,
    solvedAt: null,
    score: 0,
  };
}

export async function readParticipant(gameId, discordId) {
  return readJsonThreeTier(
    participantKey(gameId, discordId),
    `frames:participant:${gameId}:${discordId}`,
    null,
  );
}

// Nombre d'indices déjà utilisés par ce joueur — lecture directe des 2 clés
// connues (indice1/indice2), jamais via list() (pas de délai d'indexation
// à attendre, contrairement à un listage par préfixe).
async function countHintsUsed(gameId, discordId) {
  const markers = await Promise.all(
    HINT_KEYS.map((k) =>
      readJsonThreeTier(
        hintMarkerKey(gameId, discordId, k),
        `frames:hint:${gameId}:${discordId}:${k}`,
        null,
      ),
    ),
  );
  return markers.filter(Boolean).length;
}

// Même principe que les indices : chaque tentative incorrecte est un
// fichier à part (clé toujours unique), jamais un compteur partagé — un
// verrou optimiste seul ne suffit pas à protéger un compteur incrémenté par
// le même joueur qui soumet deux réponses rapprochées (testé et confirmé :
// des écritures concurrentes sur le MÊME compteur peuvent s'écraser l'une
// l'autre même avec plusieurs tentatives de ré-essai).
function attemptsPrefix(gameId, discordId) {
  return `${PARTICIPANTS_PREFIX}/${gameId}/${discordId}/attempts`;
}

export async function recordAttempt(gameId, discordId, username, isCorrect) {
  if (isCorrect) return null; // la tentative gagnante n'est jamais comptée comme incorrecte
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await writeJsonThreeTier(`${attemptsPrefix(gameId, discordId)}/${uniqueId}.json`, {
    discordId,
    username,
    at: new Date().toISOString(),
  });
  return null;
}

async function countAttempts(gameId, discordId) {
  const docs = await listSharded(attemptsPrefix(gameId, discordId));
  return docs.length;
}

export async function recordHintUsed(gameId, discordId, username, hintKey) {
  const key = hintMarkerKey(gameId, discordId, hintKey);
  const cacheKey = `frames:hint:${gameId}:${discordId}:${hintKey}`;
  const existing = await readJsonThreeTier(key, cacheKey, null);
  if (existing) return { alreadyUsed: true };
  await writeJsonThreeTier(key, { discordId, username, hintKey, usedAt: new Date().toISOString() }, cacheKey);
  return { alreadyUsed: false };
}

// Écriture directe (sans verrou optimiste) plutôt qu'un mutateJsonWithCas :
// un double-clic/nouvel essai du même joueur ne doit jamais pouvoir faire
// échouer la résolution avec un conflit d'écriture. Idempotent : si déjà
// résolu, renvoie le résultat existant sans rien réécrire ; sinon calcule
// le score à partir des marqueurs indices/tentatives (déjà sans contention)
// et écrit sans condition — deux appels concurrents produisent au pire deux
// écritures avec le même score, jamais une erreur.
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
  await writeJsonThreeTier(
    participantKey(gameId, discordId),
    participant,
    `frames:participant:${gameId}:${discordId}`,
  );
  return { participant, score };
}

// ── Résultats archivés (frames_results/<seasonId>/<gameId>/<discordId>) ──
// Même principe de sharding par joueur. Scopés par saison (pas juste par
// partie) pour que computeSeasonRanking ne liste jamais que la saison en
// cours — sans ça, list() devrait scanner l'historique complet depuis le
// début du jeu à chaque calcul de classement, un coût qui grandirait sans
// borne au fil des mois.

function resultKey(seasonId, gameId, discordId) {
  return `${RESULTS_PREFIX}/${seasonId}/${gameId}/${discordId}.json`;
}

export async function archiveSolve(state, frameEntry, discordId, username, score, solvedAt) {
  const key = resultKey(state.seasonId, state.gameId, discordId);
  const cacheKey = `frames:result:${state.seasonId}:${state.gameId}:${discordId}`;
  const existing = await readJsonThreeTier(key, cacheKey, null);
  if (existing) return existing; // déjà archivé, idempotent — pas de réécriture

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
  await writeJsonThreeTier(key, result, cacheKey);
  return result;
}

// ── Classements ──────────────────────────────────────────────────

export async function computeGameRanking(gameId) {
  const participants = await listSharded(`${PARTICIPANTS_PREFIX}/${gameId}`);
  return participants
    .filter((p) => p.solved)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      score: p.score,
      solvedAt: p.solvedAt,
    }))
    .sort((a, b) => b.score - a.score || new Date(a.solvedAt) - new Date(b.solvedAt));
}

// Tous les joueurs ayant interagi avec la partie (résolu ou non) — un doc
// principal, un indice pris ou une tentative ratée contiennent tous
// discordId + username, donc un seul listage sous
// frames_participants/<gameId>/ suffit à les retrouver tous, même ceux qui
// n'ont encore qu'un marqueur d'indice/tentative sans document principal.
export async function listGamePlayersInProgress(gameId) {
  const docs = await listSharded(`${PARTICIPANTS_PREFIX}/${gameId}`);
  const byId = new Map();
  for (const d of docs) {
    if (!d.discordId) continue;
    const entry = byId.get(d.discordId) || { discordId: d.discordId, username: d.username, solved: false };
    entry.username = d.username || entry.username;
    if (d.solved) entry.solved = true;
    byId.set(d.discordId, entry);
  }
  return [...byId.values()]
    .filter((p) => !p.solved)
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function computeSeasonRanking(seasonId) {
  const results = await listSharded(`${RESULTS_PREFIX}/${seasonId}`);
  const totals = new Map();
  for (const r of results) {
    const entry = totals.get(r.discordId) || {
      discordId: r.discordId,
      pseudo: r.pseudo,
      totalScore: 0,
    };
    entry.totalScore += r.score;
    entry.pseudo = r.pseudo;
    totals.set(r.discordId, entry);
  }
  return [...totals.values()].sort(
    (a, b) => b.totalScore - a.totalScore || a.pseudo.localeCompare(b.pseudo),
  );
}

export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}
