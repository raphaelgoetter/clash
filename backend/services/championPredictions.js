// ============================================================
// championPredictions.js — Pronostics GDC (Champion de la semaine)
// Couche métier : lecture/écriture données, top 5, gestion des sessions
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRaceLog, fetchClanMembers } from "./clashApi.js";
import { computePrevWeekId, computeCurrentWeekId } from "./dateUtils.js";
import { getOrSet, invalidate } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

const PREDICTIONS_FILE = "champion-predictions.json";
const HISTORY_FILE = "champion-history.json";

export const CLAN_MAP = {
  1: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
  la: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
  2: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
  les: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
  3: { index: 2, name: "Les Revoltes", tag: "QU9UQJRL" },
};

function resolveClan(clanVal) {
  return CLAN_MAP[String(clanVal).trim().toLowerCase()] ?? CLAN_MAP["1"];
}

function predictionsFilePath() {
  return path.join(DATA_DIR, PREDICTIONS_FILE);
}

function historyFilePath() {
  return path.join(DATA_DIR, HISTORY_FILE);
}

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
  } catch {
    // read-only filesystem (Vercel) — ignore
  }
}

async function writeJsonSafe(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Vercel Blob (persistance entre instances serverless) ─────

const BLOB_STORE = !!process.env.BLOB_READ_WRITE_TOKEN;

async function readFromBlob(path) {
  try {
    const { get } = await import("@vercel/blob");
    const blob = await get(path);
    if (!blob) return null;
    return await blob.json();
  } catch {
    return null;
  }
}

async function writeToBlob(path, data) {
  const { put } = await import("@vercel/blob");
  await put(path, JSON.stringify(data), {
    access: "public",
    contentType: "application/json",
  });
}

// ── Prédictions ───────────────────────────────────────────────

async function readPredictions() {
  if (BLOB_STORE) {
    const blob = await readFromBlob(PREDICTIONS_FILE);
    if (blob) return blob;
  }
  const { value } = await getOrSet(
    "champion:predictions",
    () => readJsonSafe(predictionsFilePath()) || {},
    30 * 1000,
  );
  return value;
}

async function writePredictions(data) {
  if (BLOB_STORE) {
    await writeToBlob(PREDICTIONS_FILE, data);
  } else {
    await writeJsonSafe(predictionsFilePath(), data);
  }
  invalidate("champion:predictions");
}

// ── Historique ────────────────────────────────────────────────

async function readHistory() {
  if (BLOB_STORE) {
    const blob = await readFromBlob(HISTORY_FILE);
    if (blob) return blob;
  }
  const { value } = await getOrSet(
    "champion:history",
    () => readJsonSafe(historyFilePath()) || [],
    30 * 1000,
  );
  return value;
}

async function writeHistory(data) {
  if (BLOB_STORE) {
    await writeToBlob(HISTORY_FILE, data);
  } else {
    await writeJsonSafe(historyFilePath(), data);
  }
  invalidate("champion:history");
}

// ── Helpers métier ────────────────────────────────────────────

export function formatParisDate(utcDate) {
  const d = new Date(
    utcDate.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  const mois = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
  ];
  const jour = jours[d.getDay()];
  const date = d.getDate();
  const moisNom = mois[d.getMonth()];
  const heure = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${jour} ${date} ${moisNom} à ${heure}h${minute}`;
}

export function formatParisTime(utcDate) {
  const d = new Date(
    utcDate.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const heure = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${heure}h${minute}`;
}

export async function getTopScorers(clanTag, limit = 9) {
  const cleanTag = clanTag.replace(/^#/, "").toUpperCase();
  const raceLog = await fetchRaceLog(cleanTag);
  if (!Array.isArray(raceLog) || raceLog.length === 0) return [];

  const lastRace = raceLog[0];
  if (!Array.isArray(lastRace?.standings)) return [];

  const standing = lastRace.standings.find(
    (s) => s?.clan?.tag?.toUpperCase() === `#${cleanTag}`,
  );
  const participants = standing?.clan?.participants;
  if (!Array.isArray(participants)) return [];

  // Filtrer : ne garder que les joueurs actuellement dans le clan
  const currentMembers = await fetchClanMembers(cleanTag).catch(() => []);
  const currentTags = new Set(currentMembers.map((m) => m.tag?.toUpperCase()));
  const activeParticipants = currentTags.size > 0
    ? participants.filter((p) => currentTags.has(p.tag?.toUpperCase()))
    : participants;

  const sorted = [...activeParticipants]
    .sort((a, b) => (b.fame || 0) - (a.fame || 0));

  return sorted.slice(0, limit).map((p) => ({
    tag: p.tag,
    name: p.name || p.tag,
    fame: p.fame || 0,
    decksUsed: p.decksUsed || 0,
  }));
}

export async function getRealChampion(clanTag, weekId) {
  const cleanTag = clanTag.replace(/^#/, "").toUpperCase();
  const raceLog = await fetchRaceLog(cleanTag);
  if (!Array.isArray(raceLog) || raceLog.length === 0) return null;

  // Si weekId fourni, chercher l'entrée correspondante (semaine terminée)
  if (weekId) {
    const match = weekId.match(/^S(\d+)W(\d+)$/);
    if (!match) return null;
    const seasonId = Number(match[1]);
    const weekNum = Number(match[2]);

    const entry = raceLog.find(
      (e) => e.seasonId === seasonId && e.sectionIndex + 1 === weekNum,
    );
    if (!entry || !Array.isArray(entry?.standings)) return null;

    const standing = entry.standings.find(
      (s) => s?.clan?.tag?.toUpperCase() === `#${cleanTag}`,
    );
    const participants = standing?.clan?.participants;
    if (!Array.isArray(participants)) return null;

    const sorted = [...participants].sort((a, b) => (b.fame || 0) - (a.fame || 0));
    const top = sorted[0];
    if (!top) return null;

    return {
      tag: top.tag,
      name: top.name || top.tag,
      fame: top.fame || 0,
      decksUsed: top.decksUsed || 0,
    };
  }

  // Fallback : pas de weekId → dernier race log
  const top = await getTopScorers(clanTag, 1);
  return top[0] || null;
}

export function sessionKey(clanTag, weekId) {
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  return `${clean}:${weekId}`;
}

// ── Sessions de vote ──────────────────────────────────────────

export async function openSession(clanTag, weekId, seasonId, sectionIndex, challengers, endsAt) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);

  if (predictions[key]) {
    throw new Error("Une session de vote existe déjà pour cette semaine.");
  }

  predictions[key] = {
    clanTag: clanTag.replace(/^#/, "").toUpperCase(),
    weekId,
    seasonId,
    sectionIndex,
    startedAt: new Date().toISOString(),
    endsAt,
    challengers,
    votes: [],
  };

  await writePredictions(predictions);
  return predictions[key];
}

export async function castVote(clanTag, weekId, discordId, discordName, challengerTag) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  const session = predictions[key];

  if (!session) {
    throw new Error("Aucune session de vote ouverte pour cette semaine.");
  }

  if (new Date() > new Date(session.endsAt)) {
    throw new Error("La période de vote est terminée.");
  }

  const already = session.votes.find((v) => v.discordId === discordId);
  if (already) {
    throw new Error("Vous avez déjà voté.");
  }

  const valid = session.challengers.some((c) => c.tag === challengerTag) || challengerTag === "__other__";
  if (!valid) {
    throw new Error("Challenger invalide.");
  }

  session.votes.push({
    discordId,
    discordName,
    challengerTag,
    votedAt: new Date().toISOString(),
  });

  await writePredictions(predictions);
  return true;
}

export async function getVoteCounts(clanTag, weekId) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  const session = predictions[key];

  if (!session) return null;

  const counts = {};
  for (const c of session.challengers) {
    counts[c.tag] = { name: c.name, votes: 0 };
  }
  counts["__other__"] = { name: "Autre", votes: 0 };
  for (const v of session.votes) {
    if (counts[v.challengerTag]) {
      counts[v.challengerTag].votes++;
    }
  }

  return {
    session,
    counts,
    totalVotes: session.votes.length,
  };
}

export async function closeSessionAndArchive(clanTag, weekId, realChampion) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  const session = predictions[key];

  if (!session) {
    throw new Error("Aucune session trouvée.");
  }

  // Comput des votes
  const voteMap = {};
  for (const c of session.challengers) {
    voteMap[c.tag] = 0;
  }
  voteMap["__other__"] = 0;
  for (const v of session.votes) {
    if (voteMap[v.challengerTag] !== undefined) {
      voteMap[v.challengerTag]++;
    }
  }

  const sorted = Object.entries(voteMap)
    .map(([tag, count]) => ({ challengerTag: tag, votes: count }))
    .sort((a, b) => b.votes - a.votes);

  const winnerTag = sorted.length > 0 ? sorted[0].challengerTag : null;

  // Archivage dans l'historique
  const history = await readHistory();
  history.push({
    clanTag: session.clanTag,
    weekId: session.weekId,
    seasonId: session.seasonId,
    sectionIndex: session.sectionIndex,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    challengers: session.challengers,
    realChampion: realChampion
      ? { tag: realChampion.tag, name: realChampion.name, fame: realChampion.fame }
      : null,
    winnerChallengerTag: winnerTag,
    totalVotes: session.votes.length,
    voteResult: sorted,
  });

  await writeHistory(history);

  // Nettoyage de la session en cours
  delete predictions[key];
  await writePredictions(predictions);

  return {
    session,
    voteResult: sorted,
    winnerTag,
    totalVotes: session.votes.length,
  };
}

export async function getSessionData(clanTag, weekId) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  return predictions[key] || null;
}

export async function getActiveSessionByClan(clanTag) {
  const predictions = await readPredictions();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  const now = new Date();
  for (const [key, session] of Object.entries(predictions)) {
    if (session.clanTag === clean && new Date(session.endsAt) > now) {
      return { session, key, weekId: session.weekId };
    }
  }
  // Fallback : retourne la session la plus récente même si expirée
  let latest = null;
  for (const [key, session] of Object.entries(predictions)) {
    if (session.clanTag === clean) {
      if (!latest || new Date(session.startedAt) > new Date(latest.session.startedAt)) {
        latest = { session, key, weekId: session.weekId };
      }
    }
  }
  return latest;
}

export async function getHistory(clanTag, limit = 10) {
  const history = await readHistory();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  return history
    .filter((h) => h.clanTag === clean)
    .sort((a, b) => {
      const sa = a.seasonId || 0;
      const sb = b.seasonId || 0;
      if (sa !== sb) return sb - sa;
      return (b.sectionIndex || 0) - (a.sectionIndex || 0);
    })
    .slice(0, limit);
}

// ── Initialisation des fichiers ───────────────────────────────

export async function ensureDataFiles() {
  const initPredictions = {};
  const initHistory = [];
  await writeJsonSafe(predictionsFilePath(), initPredictions).catch(() => {});
  await writeJsonSafe(historyFilePath(), initHistory).catch(() => {});
}

export { resolveClan };
