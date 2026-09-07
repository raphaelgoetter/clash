// ============================================================
// championPredictions.js — Pronostics GDC (Champion de la semaine)
// Couche métier : lecture/écriture données, top 5, gestion des sessions
//
// Sessions & votes : Upstash Redis (même instance et mêmes conventions que
// backend/services/robinson.js) — espace de clés `predictions:*`. Le vote
// est enregistré via HSETNX (comme robinson.js recordVote) : une écriture
// atomique par votant, jamais de lire-modifier-écrire sur un objet partagé —
// contrairement à l'ancien stockage en blob JSON unique, où deux votes
// concurrents (même du même clan, ou de deux clans différents puisque tout
// tenait dans un seul fichier) pouvaient s'écraser l'un l'autre (lost
// update) et faire disparaître silencieusement des votes déjà comptés.
//
// Registre des champions (historique) : reste sur Vercel Blob, inchangé —
// écrit uniquement par le cron hebdomadaire (autoEndPredictions.js), donc
// jamais concurrent en pratique.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchClanMembers } from "./clashApi.js";
import { getOrSet, invalidate } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

const CHAMPION_REGISTRY_FILE = "champion-registry.json";

// Construction paresseuse (pas au chargement du module) — voir robinson.js
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
// [champ1, valeur1, champ2, valeur2, ...] et non un objet.
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

function sessionMetaKey(key) {
  return `predictions:session:${key}`;
}
function votesKey(key) {
  return `predictions:votes:${key}`;
}
function voteNamesKey(key) {
  return `predictions:vote_names:${key}`;
}
function clanSessionsKey(clanTag) {
  return `predictions:clan_sessions:${clanTag}`;
}

// Détail des votants (discordId, discordName, challengerTag) d'une session —
// une seule lecture des deux hash, jamais mutée en place.
async function listSessionVotes(key) {
  const [votes, names] = await Promise.all([
    hgetallRaw(votesKey(key)),
    hgetallRaw(voteNamesKey(key)),
  ]);
  return Object.entries(votes).map(([discordId, challengerTag]) => ({
    discordId,
    challengerTag,
    discordName: names[discordId] || null,
  }));
}

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
    if (delay) await new Promise(r => setTimeout(r, delay));
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

// ── Helpers métier ────────────────────────────────────────────

/**
 * Associe à chaque vrai champion de la semaine la liste des votants qui
 * l'avaient deviné. Si le champion n'était pas dans la liste des
 * challengers proposés, on ne peut relier les votes "__other__" à lui que
 * s'il est le SEUL vrai champion de la semaine (pas d'ex-æquo) — sinon
 * c'est ambigu, le vote "Autre" pourrait viser n'importe quel joueur, pas
 * forcément l'un des champions ex-æquo.
 * @param {Array<{tag:string,name:string,fame:number}>} realChampions
 * @param {Array<{tag:string}>} challengers
 * @param {Array<{challengerTag:string,discordId:string,discordName:string}>} votes
 * @returns {Array<{tag:string,name:string,fame:number,voters:{discordId:string,discordName:string}[]}>}
 */
export function computeChampionVoters(realChampions, challengers, votes) {
  if (!Array.isArray(realChampions)) return [];

  return realChampions.map((c) => {
    const isListed = challengers.some((ch) => ch.tag === c.tag);
    const voterTag = isListed ? c.tag : (realChampions.length === 1 ? "__other__" : null);
    // discordId conservé (pas seulement discordName) pour permettre à
    // l'appelant de résoudre le pseudo Discord ACTUEL à l'affichage (voir
    // discordUsers.js) — le pseudo stocké ici n'est qu'un repli figé.
    const voters = voterTag
      ? votes
          .filter((v) => v.challengerTag === voterTag)
          .map((v) => ({ discordId: v.discordId, discordName: v.discordName }))
      : [];
    return { ...c, voters, voterTag };
  });
}

/**
 * Ensemble des challengerTag (ou "__other__") qui correspondent à un vrai
 * champion de la semaine, pour distinguer visuellement (ex. couronne) les
 * lignes de vote qui étaient réellement le champion de celles qui ne
 * l'étaient pas — indépendamment du nombre de votes reçus.
 * @param {Array<{tag:string,name:string,fame:number}>|null} realChampions
 * @param {Array<{tag:string}>} challengers
 * @returns {Set<string>}
 */
export function getChampionChallengerTags(realChampions, challengers) {
  if (!Array.isArray(realChampions)) return new Set();
  return new Set(
    computeChampionVoters(realChampions, challengers, [])
      .map((c) => c.voterTag)
      .filter(Boolean),
  );
}

export function computeNextPredictionsStart(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(8, 0, 0, 0);
  let daysUntilTuesday = (2 - next.getUTCDay() + 7) % 7;
  if (daysUntilTuesday === 0 && next <= now) daysUntilTuesday = 7;
  next.setUTCDate(next.getUTCDate() + daysUntilTuesday);
  return next;
}

export function formatParisDate(utcDate) {
  const d = new Date(
    utcDate.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  const mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;
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

  const currentMembers = await fetchClanMembers(cleanTag).catch(() => []);
  const currentNameByTag = new Map(
    currentMembers.map((m) => [m.tag?.toUpperCase(), m.name]),
  );
  const currentTags = new Set(currentNameByTag.keys());
  const activeParticipants = currentTags.size > 0
    ? participants.filter((p) => currentTags.has(p.tag?.toUpperCase()))
    : participants;

  const sorted = [...activeParticipants]
    .sort((a, b) => (b.fame || 0) - (a.fame || 0));

  return sorted.slice(0, limit).map((p) => ({
    tag: p.tag,
    name: currentNameByTag.get(p.tag?.toUpperCase()) || p.name || p.tag,
    fame: p.fame || 0,
    decksUsed: p.decksUsed || 0,
  }));
}

// ── Gestion des sessions ─────────────────────────────────────

export async function openSession(clanTag, weekId, seasonId, sectionIndex, challengers, endsAt) {
  const redis = getRedis();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  const key = sessionKey(clanTag, weekId);

  const session = {
    clanTag: clean,
    weekId,
    seasonId,
    sectionIndex,
    startedAt: new Date().toISOString(),
    endsAt,
    challengers,
  };

  // SETNX : garantit qu'une session concurrente ne peut pas écraser celle-ci
  // (équivalent du check `if (predictions[key])` de l'ancienne implémentation,
  // mais atomique).
  const wasSet = Number(await redis.setnx(sessionMetaKey(key), toJson(session)));
  if (!wasSet) {
    throw new Error("Une session de vote existe déjà pour cette semaine.");
  }
  await redis.sadd(clanSessionsKey(clean), weekId);
  return session;
}

export async function castVote(clanTag, weekId, discordId, discordName, challengerTag) {
  const redis = getRedis();
  const key = sessionKey(clanTag, weekId);
  const session = fromJson(await redis.get(sessionMetaKey(key)));

  if (!session) {
    throw new Error("Aucune session de vote ouverte pour cette semaine.");
  }

  if (new Date() > new Date(session.endsAt)) {
    throw new Error("La période de vote est terminée.");
  }

  const valid = session.challengers.some((c) => c.tag === challengerTag) || challengerTag === "__other__";
  if (!valid) {
    throw new Error("Challenger invalide.");
  }

  // HSETNX : enregistre le vote seulement si ce discordId n'a pas encore de
  // champ dans le hash — écriture atomique, aucun risque qu'un vote
  // concurrent écrase celui-ci (contrairement à l'ancien read-modify-write
  // sur le blob JSON complet).
  const wasSet = Number(await redis.hsetnx(votesKey(key), discordId, challengerTag));
  if (!wasSet) {
    throw new Error("Vous avez déjà voté.");
  }
  if (discordName) {
    await redis.hset(voteNamesKey(key), { [discordId]: discordName });
  }
  return true;
}

export async function getVoteCounts(clanTag, weekId) {
  const key = sessionKey(clanTag, weekId);
  const session = fromJson(await getRedis().get(sessionMetaKey(key)));

  if (!session) return null;

  const votes = await listSessionVotes(key);

  const voteMap = {};
  for (const c of session.challengers) {
    voteMap[c.tag] = { name: c.name || c.tag, votes: 0 };
  }
  voteMap["__other__"] = { name: "Autre joueur", votes: 0 };
  for (const v of votes) {
    if (voteMap[v.challengerTag]) {
      voteMap[v.challengerTag].votes++;
    }
  }

  return {
    counts: voteMap,
    totalVotes: votes.length,
    session: { ...session, votes },
  };
}

export async function getRealChampion(clanTag, weekId) {
  const cleanTag = clanTag.replace(/^#/, "").toUpperCase();
  const raceLog = await fetchRaceLog(cleanTag);
  if (!Array.isArray(raceLog)) return null;

  const race = raceLog.find(
    (r) => r?.seasonId != null && r?.sectionIndex != null
      && `S${r.seasonId}W${r.sectionIndex + 1}` === weekId,
  );
  if (!race || !Array.isArray(race.standings)) return null;

  const standing = race.standings.find(
    (s) => s?.clan?.tag?.toUpperCase() === `#${cleanTag}`,
  );
  const participants = standing?.clan?.participants;
  if (!Array.isArray(participants)) return null;

  const scored = participants
    .filter((p) => p?.fame > 0)
    .sort((a, b) => (b.fame || 0) - (a.fame || 0));
  if (scored.length === 0) return null;

  const topFame = scored[0].fame;
  return scored.filter((p) => p.fame === topFame).map((p) => ({
    tag: p.tag, name: p.name, fame: p.fame,
  }));
}

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

export async function closeSessionAndArchive(clanTag, weekId, realChampion) {
  const redis = getRedis();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  const key = sessionKey(clanTag, weekId);
  const session = fromJson(await redis.get(sessionMetaKey(key)));

  if (!session) {
    console.error(`[Predictions] Session introuvable — clé=${key}`);
    throw new Error("Aucune session trouvée.");
  }

  const votes = await listSessionVotes(key);
  session.votes = votes;

  const voteMap = {};
  for (const c of session.challengers) {
    voteMap[c.tag] = 0;
  }
  voteMap["__other__"] = 0;
  for (const v of votes) {
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
      champions: realChampion.map((c) => ({ tag: c.tag, name: c.name, fame: c.fame })),
    });
    await writeChampionRegistry(registry);
  }

  await redis.del(sessionMetaKey(key), votesKey(key), voteNamesKey(key));
  await redis.srem(clanSessionsKey(clean), weekId);

  return {
    session,
    voteResult: sorted,
    winnerTag,
    totalVotes: votes.length,
  };
}

export async function getSessionData(clanTag, weekId) {
  const key = sessionKey(clanTag, weekId);
  return fromJson(await getRedis().get(sessionMetaKey(key)));
}

export async function getActiveSessionByClan(clanTag) {
  const redis = getRedis();
  const clean = clanTag.replace(/^#/, "").toUpperCase();
  const weekIds = await redis.smembers(clanSessionsKey(clean));
  if (!Array.isArray(weekIds) || weekIds.length === 0) return null;

  const now = new Date();
  let latest = null;
  for (const weekId of weekIds) {
    const key = sessionKey(clean, weekId);
    const session = fromJson(await redis.get(sessionMetaKey(key)));
    if (!session) continue; // clé orpheline (set désynchronisé) — ignorée
    if (new Date(session.endsAt) > now) {
      return { session, key, weekId: session.weekId };
    }
    if (!latest || new Date(session.startedAt) > new Date(latest.session.startedAt)) {
      latest = { session, key, weekId: session.weekId };
    }
  }
  return latest;
}

export async function getHistory(clanTag, limit = 10, offset = 0) {
  const registry = await readChampionRegistry();
  const clean = clanTag.replace(/^#/, "").toUpperCase();

  // Une même semaine peut avoir été archivée plusieurs fois (backfill rejoué) :
  // on fusionne les entrées par weekId pour ne compter chaque semaine qu'une fois.
  // Les entrées les plus anciennes utilisent encore le schéma legacy `champion`
  // (objet unique) au lieu de `champions` (tableau) — on le normalise ici.
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

export { resolveClan };
