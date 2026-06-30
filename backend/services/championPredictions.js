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
const CHAMPION_REGISTRY_FILE = "champion-registry.json";

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

function championRegistryFilePath() {
  return path.join(DATA_DIR, CHAMPION_REGISTRY_FILE);
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
  } catch {}
}

async function writeJsonSafe(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Blob helpers ───────────────────────────────────────────

function useBlob() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function readFromBlob(path) {
  try {
    const { list } = await import("@vercel/blob");
    const prefix = path.replace(/\.json$/, "_");
    for (const delay of [0, 300, 700]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      const result = await list({ prefix, limit: 10 });
      const blobs = result.blobs;
      if (blobs?.length) {
        blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        return await fetchBlob(blobs[0].url);
      }
    }
    return null;
  } catch (err) {
    console.warn(`[Blob] Lecture échouée ${path}:`, err.message);
    return null;
  }
}

async function fetchBlob(url) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json();
}

let writeVersion = 0;

async function writeToBlob(path, data) {
  try {
    const { put } = await import("@vercel/blob");
    writeVersion = Date.now();
    data._wv = writeVersion;
    await put(path, JSON.stringify(data), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: true,
      cacheControlMaxAge: 0,
    });
  } catch (err) {
    console.error(`[Blob] Écriture échouée ${path}:`, err.message);
    const filePath = path === PREDICTIONS_FILE
      ? predictionsFilePath()
      : championRegistryFilePath();
    try {
      await writeJsonSafe(filePath, data);
      console.warn("[Blob] Données sauvegardées dans le fichier local en fallback");
    } catch (fileErr) {
      console.error("[Blob] Fallback fichier échoué aussi:", fileErr.message);
      throw err;
    }
  }
}

async function waitForConsistency(path) {
  for (const delay of [500, 1000, 2000]) {
    await new Promise(r => setTimeout(r, delay));
    const data = await readFromBlob(path);
    if (data && data._wv === writeVersion) return;
  }
  console.warn(`[Blob] Cohérence non vérifiée pour ${path}`);
}

// ── Prédictions ───────────────────────────────────────────────

async function readPredictions() {
  if (useBlob()) {
    const blob = await readFromBlob(PREDICTIONS_FILE);
    if (blob) return blob;
    return {};
  }
  const { value } = await getOrSet(
    "champion:predictions",
    () => readJsonSafe(predictionsFilePath()) || {},
    30 * 1000,
  );
  return value;
}

async function writePredictions(data) {
  if (useBlob()) {
    await writeToBlob(PREDICTIONS_FILE, data);
    await waitForConsistency(PREDICTIONS_FILE);
    invalidate("champion:predictions");
    return;
  }
  await writeJsonSafe(predictionsFilePath(), data).catch(() => {});
  invalidate("champion:predictions");
}

// ── Registre des champions ────────────────────────────────────

async function readChampionRegistry() {
  if (useBlob()) {
    const blob = await readFromBlob(CHAMPION_REGISTRY_FILE);
    if (blob) return blob;
    return [];
  }
  const { value } = await getOrSet(
    "champion:registry",
    () => readJsonSafe(championRegistryFilePath()) || [],
    30 * 1000,
  );
  return value;
}

async function writeChampionRegistry(data) {
  if (useBlob()) {
    await writeToBlob(CHAMPION_REGISTRY_FILE, data);
    await waitForConsistency(CHAMPION_REGISTRY_FILE);
    invalidate("champion:registry");
    return;
  }
  await writeJsonSafe(championRegistryFilePath(), data).catch(() => {});
  invalidate("champion:registry");
}

// ── Helpers métier ────────────────────────────────────────────

export function formatParisDate(utcDate) {
  const d = new Date(
    utcDate.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  return `${d.getDate()} ${jours[d.getDay()]} ${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;
}

function ordinal(n) {
  return `${n}${n === 1 ? "ʳᵉʳ" : "ᵉ"}`;
}

function formatFame(fame) {
  if (fame >= 1000000) return `${(fame / 1000000).toFixed(1)}M`;
  if (fame >= 1000) return `${(fame / 1000).toFixed(0)}k`;
  return String(fame);
}

function sessionKey(clanTag, weekId) {
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  return `${clean}:${weekId}`;
}

export async function getTopScorers(clanTag, limit = 8) {
  const members = await fetchClanMembers(clanTag);
  if (!Array.isArray(members)) return [];

  const scored = members
    .filter((m) => m?.currentFame > 0)
    .sort((a, b) => (b.currentFame || 0) - (a.currentFame || 0))
    .slice(0, limit);

  return scored.map((m) => ({
    tag: m.tag,
    name: m.name,
    fame: m.currentFame || 0,
  }));
}

// ── Gestion des sessions ─────────────────────────────────────

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
  let predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  let session = predictions[key];

  // Retry avec backoff si la session n'est pas trouvée (délai de purge CDN)
  if (!session) {
    for (const ms of [500, 1000]) {
      await new Promise(r => setTimeout(r, ms));
      predictions = await readPredictions();
      session = predictions[key];
      if (session) break;
    }
  }

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
  const totalVotes = session.votes.length;

  return {
    counts: voteMap,
    totalVotes,
    session,
  };
}

export async function getRealChampion(clanTag, weekId) {
  const raceLog = await fetchRaceLog(clanTag);
  if (!Array.isArray(raceLog)) return null;

  for (const race of raceLog) {
    if (!race.periodLogs) continue;
    for (const period of race.periodLogs) {
      if (!period.periodPoints) continue;
      const periodWeekId = period.periodId || computePrevWeekId(raceLog);
      if (periodWeekId !== weekId) continue;
      const top = period.periodPoints
        .filter((p) => p?.fame > 0)
        .sort((a, b) => (b.fame || 0) - (a.fame || 0));
      if (top.length > 0) {
        return { tag: top[0].tag, name: top[0].name, fame: top[0].fame };
      }
    }
  }
  return null;
}

export async function closeSessionAndArchive(clanTag, weekId, realChampion) {
  const predictions = await readPredictions();
  const key = sessionKey(clanTag, weekId);
  const session = predictions[key];

  if (!session) {
    console.error(`[Blob] Session introuvable — clé=${key} clans=${Object.keys(predictions).join(",")}`);
    throw new Error("Aucune session trouvée.");
  }

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

  if (realChampion) {
    const registry = await readChampionRegistry();
    registry.push({
      clanTag: session.clanTag,
      weekId: session.weekId,
      seasonId: session.seasonId,
      sectionIndex: session.sectionIndex,
      champion: { tag: realChampion.tag, name: realChampion.name, fame: realChampion.fame },
    });
    await writeChampionRegistry(registry);
  }

  delete predictions[key];
  await writePredictions(predictions);

  return {
    session,
    voteResult: sorted,
    winnerTag,
    totalVotes: session.votes.length,
  };
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
  const registry = await readChampionRegistry();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  return registry
    .filter((e) => e.clanTag === clean)
    .sort((a, b) => b.weekId - a.weekId)
    .slice(0, limit);
}

export { resolveClan };
