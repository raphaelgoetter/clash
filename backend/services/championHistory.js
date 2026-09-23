// ============================================================
// championHistory.js — Registre des champions GDC passés (commande
// `/champion-history`).
//
// Historique : ce fichier existait sous backend/services/championPredictions.js,
// aux côtés d'un système de pronostics/votes (Redis) supprimé le 20/09/2026
// (commit 158c609f) car son workflow GitHub Actions committait sur `main` à
// chaque lancement/clôture de vote — cause du dépassement de Functions
// Storage Vercel. Le registre des champions ci-dessous n'a jamais fait partie
// du problème : il vit sur Vercel Blob (pas git), alimenté à la volée par la
// commande elle-même (voir backfillChampionRegistry, appelé depuis
// api/discord/_handlers/championHistory.js) — restauré tel quel sous un nom
// dédié pour ne plus laisser croire qu'un système de vote existe encore.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getOrSet, invalidate } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

const CHAMPION_REGISTRY_FILE = "champion-registry.json";

export const CLAN_MAP = {
  1: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
  la: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
  2: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
  les: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
  3: { index: 2, name: "Les Revoltes", tag: "QU9UQJRL" },
};

export function resolveClan(clanVal) {
  return CLAN_MAP[String(clanVal).trim().toLowerCase()] ?? CLAN_MAP["1"];
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

function tmpPath(name) {
  return `/tmp/${name}`;
}

function blobStoreId() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return token.split("_")[3] || null;
}

function blobUrlFor(relativePath) {
  const storeId = blobStoreId();
  if (!storeId) return null;
  return `https://${storeId}.private.blob.vercel-storage.com/${relativePath}`;
}

async function readFromBlob(relativePath) {
  const url = blobUrlFor(relativePath);
  if (!url) return null;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function writeToBlob(relativePath, data) {
  try {
    const { put } = await import("@vercel/blob");
    await put(relativePath, JSON.stringify(data), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
  } catch (err) {
    console.error(`[Blob] Écriture échouée ${relativePath}:`, err.message);
  }
}

// ── Registre des champions ────────────────────────────────────

export async function readChampionRegistry() {
  const local = await readJsonSafe(tmpPath(CHAMPION_REGISTRY_FILE));
  if (local) return local;

  if (useBlob()) {
    const data = await readFromBlob(CHAMPION_REGISTRY_FILE);
    if (data) {
      await writeJsonSafe(tmpPath(CHAMPION_REGISTRY_FILE), data).catch(() => {});
      return data;
    }
    return [];
  }
  const { value } = await getOrSet(
    "champion:registry",
    () => readJsonSafe(championRegistryFilePath()) || [],
    30 * 1000,
  );
  return value;
}

export async function writeChampionRegistry(data) {
  await writeJsonSafe(tmpPath(CHAMPION_REGISTRY_FILE), data).catch(() => {});
  if (useBlob()) {
    await writeToBlob(CHAMPION_REGISTRY_FILE, data);
  } else {
    await writeJsonSafe(championRegistryFilePath(), data).catch(() => {});
  }
  invalidate("champion:registry");
}

// Complète le registre à partir du race log réel (fetchRaceLog), appelé à
// chaque invocation de /champion-history — jamais de cron ni de commit git.
export async function backfillChampionRegistry(clanTag, raceLog) {
  if (!Array.isArray(raceLog) || raceLog.length === 0) return;

  const cleanTag = clanTag.replace(/^#/, "").toUpperCase();
  const registry = await readChampionRegistry();

  const clanEntries = registry.filter((e) => e.clanTag === cleanTag);
  const existingWeeks = new Set(clanEntries.map((e) => e.weekId));
  const staleWeeks = new Set(
    clanEntries.filter((e) => !e.champions && e.champion).map((e) => e.weekId),
  );

  const entriesToAdd = [];
  const weeksToRemove = new Set();

  for (const race of raceLog) {
    const weekId = `S${race.seasonId}W${race.sectionIndex + 1}`;
    if (existingWeeks.has(weekId) && !staleWeeks.has(weekId)) continue;

    const standing = (race.standings || []).find(
      (s) => s?.clan?.tag?.toUpperCase() === `#${cleanTag}`,
    );
    if (!standing) continue;

    const participants = standing.clan?.participants;
    if (!Array.isArray(participants) || participants.length === 0) continue;

    const scored = [...participants]
      .filter((p) => p?.fame > 0)
      .sort((a, b) => (b.fame || 0) - (a.fame || 0));
    if (scored.length === 0) continue;
    const topFame = scored[0].fame;
    const champions = scored.filter((p) => p.fame === topFame).map((p) => ({
      tag: p.tag, name: p.name || p.tag, fame: p.fame || 0,
    }));

    weeksToRemove.add(weekId);
    entriesToAdd.push({
      clanTag: cleanTag,
      weekId,
      seasonId: race.seasonId,
      sectionIndex: race.sectionIndex,
      champions,
    });
  }

  if (entriesToAdd.length === 0) return;

  const cleaned = registry.filter(
    (e) => !(e.clanTag === cleanTag && weeksToRemove.has(e.weekId)),
  );
  cleaned.push(...entriesToAdd);
  await writeChampionRegistry(cleaned);
  console.log(`[Backfill] ${entriesToAdd.length} semaine(s) traitées pour ${cleanTag}`);
}

// Historique paginé, trié du plus récent au plus ancien — calcule au passage
// le nombre total de titres (⭐) et la série en cours (🔥) de chaque champion.
export async function getHistory(clanTag, limit = 10, offset = 0) {
  const registry = await readChampionRegistry();
  const clean = clanTag.replace(/^#/, "").toUpperCase();

  // Une même semaine peut avoir été archivée plusieurs fois (backfill rejoué) :
  // on fusionne les entrées par weekId pour ne compter chaque semaine qu'une fois.
  const byWeek = new Map();
  for (const e of registry) {
    if (e.clanTag !== clean) continue;
    const rawChampions = e.champions || (e.champion ? [e.champion] : []);
    const existing = byWeek.get(e.weekId);
    if (!existing) {
      byWeek.set(e.weekId, { ...e, champions: [...rawChampions] });
      continue;
    }
    const seenTags = new Set(existing.champions.map((c) => c.tag));
    for (const c of rawChampions) {
      if (!seenTags.has(c.tag)) {
        existing.champions.push(c);
        seenTags.add(c.tag);
      }
    }
  }

  const chronological = [...byWeek.values()]
    .sort((a, b) => (a.seasonId - b.seasonId) || (a.sectionIndex - b.sectionIndex));

  const totalCount = {};
  for (const entry of chronological) {
    for (const c of entry.champions || []) {
      totalCount[c.tag] = (totalCount[c.tag] || 0) + 1;
    }
  }

  const streakByTag = {};
  for (const entry of chronological) {
    const currentTags = new Set((entry.champions || []).map((c) => c.tag));
    for (const c of entry.champions || []) {
      streakByTag[c.tag] = (streakByTag[c.tag] || 0) + 1;
      c.streak = streakByTag[c.tag];
      c.totalCount = totalCount[c.tag];
    }
    for (const tag of Object.keys(streakByTag)) {
      if (!currentTags.has(tag)) streakByTag[tag] = 0;
    }
  }

  const descending = [...chronological]
    .sort((a, b) => (b.seasonId - a.seasonId) || (b.sectionIndex - a.sectionIndex));

  return {
    entries: descending.slice(offset, offset + limit),
    hasMore: descending.length > offset + limit,
  };
}
