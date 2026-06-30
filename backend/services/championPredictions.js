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
  } catch {
    // read-only filesystem (Vercel) — ignore
  }
}

async function writeJsonSafe(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Vercel Blob (persistance entre instances serverless) ─────

function useBlob() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function readFromBlob(path) {
  try {
    const { list } = await import("@vercel/blob");
    const prefix = path.replace(/\.json$/, "_");

    for (const delay of [0, 500, 1500]) {
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

async function writeToBlob(path, data) {
  try {
    const { put, list, del } = await import("@vercel/blob");
    const result = await put(path, JSON.stringify(data), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: true,
      cacheControlMaxAge: 0,
    });
    // Nettoyage safe : supprimer les anciens blobs seulement
    // une fois que le nouveau est indexé par list()
    try {
      const prefix = path.replace(/\.json$/, "_");
      for (const delay of [0, 300, 700]) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        const old = await list({ prefix, limit: 20 });
        const hasNew = old.blobs.some(b => b.url === result.url);
        if (hasNew) {
          const stale = old.blobs.map(b => b.url).filter(u => u !== result.url);
          if (stale.length > 0) await del(stale);
          break;
        }
      }
    } catch {}
  } catch (err) {
    console.error(`[Blob] Écriture échouée ${path}:`, err.message);
    // Fallback fichier local (dev uniquement)
    const filePath = path === PREDICTIONS_FILE
      ? predictionsFilePath()
      : championRegistryFilePath();
    try {
      await writeJsonSafe(filePath, data);
      console.warn("[Blob] Données sauvegardées dans le fichier local en fallback");
    } catch (fileErr) {
      console.error("[Blob] Fallback fichier échoué aussi:", fileErr.message);
      throw err; // Propager l'erreur Blob pour la rendre visible
    }
  }
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
    console.error(`[Blob] Session introuvable — clé=${key} clans=${Object.keys(predictions).join(",")}`);
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

  // Enregistrer le champion dans le registre
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
  const registry = await readChampionRegistry();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  return registry
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
  // Uniquement utile en dev local — sur Vercel, Blob ou la lecture seule du bundle suffisent
  await writeJsonSafe(predictionsFilePath(), {}).catch(() => {});
  await writeJsonSafe(championRegistryFilePath(), []).catch(() => {});
}

export { resolveClan };
