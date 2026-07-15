// ============================================================
// frames.js — Jeu "Frame" (devine le film à partir d'une image)
// Couche métier : lecture des frames, état de la partie, scoring,
// classements. Même pattern Blob que championPredictions.js.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.resolve(__dirname, "..", "..", "data", "frames");
const FRAMES_JSON_PATH = path.join(FRAMES_DIR, "frames.json");
const FRAMES_IMAGES_DIR = path.join(FRAMES_DIR, "images");

const STATE_FILE = "frames_state.json";
const HISTORY_FILE = "frames_history.json";

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

// ── État de la partie en cours ──────────────────────────────────

export async function readState() {
  const local = await readJsonSafe(tmpPath(STATE_FILE));
  if (local) return local;

  if (useBlob()) {
    const data = await readFromBlob(STATE_FILE);
    if (data) {
      await writeJsonSafe(tmpPath(STATE_FILE), data).catch(() => {});
      return data;
    }
    return null;
  }
  const { value } = await getOrSet(
    "frames:state",
    () => readJsonSafe(dataFilePath(STATE_FILE)),
    30 * 1000,
  );
  return value;
}

export async function writeState(state) {
  await writeJsonSafe(tmpPath(STATE_FILE), state).catch(() => {});
  if (useBlob()) {
    await writeToBlob(STATE_FILE, state);
  } else {
    await writeJsonSafe(dataFilePath(STATE_FILE), state).catch(() => {});
  }
}

// ── Historique ───────────────────────────────────────────────────

const EMPTY_HISTORY = { games: [] };

export async function readHistory() {
  const local = await readJsonSafe(tmpPath(HISTORY_FILE));
  if (local) return local;

  if (useBlob()) {
    const data = await readFromBlob(HISTORY_FILE);
    if (data) {
      await writeJsonSafe(tmpPath(HISTORY_FILE), data).catch(() => {});
      return data;
    }
    return { ...EMPTY_HISTORY };
  }
  const { value } = await getOrSet(
    "frames:history",
    () => readJsonSafe(dataFilePath(HISTORY_FILE)) || { ...EMPTY_HISTORY },
    30 * 1000,
  );
  return value;
}

export async function writeHistory(history) {
  await writeJsonSafe(tmpPath(HISTORY_FILE), history).catch(() => {});
  if (useBlob()) {
    await writeToBlob(HISTORY_FILE, history);
  } else {
    await writeJsonSafe(dataFilePath(HISTORY_FILE), history).catch(() => {});
  }
}

// ── Saison Clash Royale en cours ────────────────────────────────

export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "frames:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      const raceLog = await fetchRaceLog(clanTag).catch(() => null);
      const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
      return computeCurrentSeasonId(currentRace, raceLog);
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
  const state = await readState();
  const currentIndex = pickNextFrameIndex(state, frames);
  const frameEntry = frames[currentIndex];
  const seasonId = await getCurrentSeasonId();

  const newState = {
    currentIndex,
    gameId: path.parse(frameEntry.image).name,
    seasonId,
    startedAt: new Date().toISOString(),
    channelId,
    messageId: null,
    participants: {},
  };

  await writeState(newState);
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

// ── Mutations d'état par joueur ──────────────────────────────────

function ensureParticipant(state, discordId, username) {
  if (!state.participants[discordId]) {
    state.participants[discordId] = {
      username,
      attempts: 0,
      hintsUsed: [],
      solved: false,
      solvedAt: null,
      score: 0,
    };
  } else {
    state.participants[discordId].username = username;
  }
  return state.participants[discordId];
}

export async function recordAttempt(discordId, username, isCorrect) {
  const state = await readState();
  const participant = ensureParticipant(state, discordId, username);
  if (!isCorrect) {
    participant.attempts += 1;
  }
  await writeState(state);
  return participant;
}

export async function recordHintUsed(discordId, username, hintKey) {
  const state = await readState();
  const participant = ensureParticipant(state, discordId, username);
  const alreadyUsed = participant.hintsUsed.includes(hintKey);
  if (!alreadyUsed) {
    participant.hintsUsed.push(hintKey);
    await writeState(state);
  }
  return { alreadyUsed, state };
}

export async function markSolved(discordId, username) {
  const state = await readState();
  const participant = ensureParticipant(state, discordId, username);
  const score = computeScore(participant.attempts, participant.hintsUsed.length);
  participant.solved = true;
  participant.solvedAt = new Date().toISOString();
  participant.score = score;
  await writeState(state);
  return { state, participant, score };
}

export async function archiveSolve(state, frameEntry, discordId, username, score, solvedAt) {
  const history = await readHistory();
  let game = history.games.find((g) => g.gameId === state.gameId);
  if (!game) {
    game = {
      gameId: state.gameId,
      seasonId: state.seasonId,
      titre: frameEntry.titre,
      postedAt: state.startedAt,
      results: [],
    };
    history.games.push(game);
  }
  const existing = game.results.find((r) => r.discordId === discordId);
  if (!existing) {
    game.results.push({ discordId, pseudo: username, score, solvedAt });
  }
  await writeHistory(history);
  return history;
}

// ── Classements ──────────────────────────────────────────────────

export function computeGameRanking(state) {
  return Object.entries(state.participants)
    .filter(([, p]) => p.solved)
    .map(([discordId, p]) => ({ discordId, username: p.username, score: p.score, solvedAt: p.solvedAt }))
    .sort((a, b) => b.score - a.score || new Date(a.solvedAt) - new Date(b.solvedAt));
}

export function computeSeasonRanking(history, seasonId) {
  const totals = new Map();
  for (const game of history.games) {
    if (game.seasonId !== seasonId) continue;
    for (const r of game.results) {
      const entry = totals.get(r.discordId) || { discordId: r.discordId, pseudo: r.pseudo, totalScore: 0 };
      entry.totalScore += r.score;
      entry.pseudo = r.pseudo;
      totals.set(r.discordId, entry);
    }
  }
  return [...totals.values()].sort(
    (a, b) => b.totalScore - a.totalScore || a.pseudo.localeCompare(b.pseudo),
  );
}

export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}
