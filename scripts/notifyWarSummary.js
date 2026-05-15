#!/usr/bin/env node
// notifyWarSummary.js
// Poste un embed résumé de la journée de GDC qui vient de se terminer dans
// chaque channel de clan. Doit être exécuté après le reset UTC du clan.
//
// Usage :
//   node scripts/notifyWarSummary.js           — mode normal (poste sur Discord)
//   node scripts/notifyWarSummary.js --dry-run — affiche l'embed sans poster

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import { ALLOWED_CLANS } from "../backend/routes/clan.js";
import {
  computeCurrentWeekId,
  warResetOffsetMs,
} from "../backend/services/dateUtils.js";
import {
  fetchRaceLog,
  fetchCurrentRace,
} from "../backend/services/clashApi.js";
import { loadSnapshots } from "../backend/services/snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "clan-cache",
);
const LOG_FILE = path.join(__dirname, "..", "data", "war-summary-log.json");
const CLINCH_LOG_FILE = path.join(
  __dirname,
  "..",
  "data",
  "war-clinch-log.json",
);

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLAN_FILTER = (() => {
  const idx = process.argv.indexOf("--clan");
  return idx !== -1
    ? process.argv[idx + 1]?.replace(/^#/, "").toUpperCase()
    : null;
})();

// ── Déduplication ────────────────────────────────────────────
// Format : { "LRQP20V9": "saturday:2026-04-04", ... }

async function loadLog() {
  if (!existsSync(LOG_FILE)) return {};
  try {
    return JSON.parse(await readFile(LOG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function loadClinchLog() {
  if (!existsSync(CLINCH_LOG_FILE)) return {};
  try {
    return JSON.parse(await readFile(CLINCH_LOG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveClinchLog(clinchLog) {
  if (DRY_RUN) return;
  await writeFile(CLINCH_LOG_FILE, JSON.stringify(clinchLog, null, 2));
}

async function markPosted(log, tag, warDay, realDay) {
  log[tag] = `${warDay}:${realDay}`;
  if (!DRY_RUN) await writeFile(LOG_FILE, JSON.stringify(log, null, 2));
}

function alreadyPosted(log, tag, warDay, realDay) {
  return log[tag] === `${warDay}:${realDay}`;
}

const WAR_DAYS = ["thursday", "friday", "saturday", "sunday"];
const WAR_DAY_NUMBER = { thursday: 1, friday: 2, saturday: 3, sunday: 4 };
const WAR_DAY_FR = {
  thursday: "jeudi",
  friday: "vendredi",
  saturday: "samedi",
  sunday: "dimanche",
};

/**
 * Retourne la journée GDC qui vient de se terminer (à appeler après le reset UTC).
 * On recule de 90 minutes pour se trouver avant le reset et identifier la journée écoulée.
 * Exemples :
 *   10:05 UTC vendredi → 08:35 UTC vendredi (avant reset) → jeudi GDC (J1)
 *   10:05 UTC lundi    → 08:35 UTC lundi    (avant reset) → dimanche GDC (J4)
 */
function getEndedWarDay(now = new Date(), clanTag = null) {
  const resetUtcMs = warResetOffsetMs(clanTag);
  const dayUtcStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  let currentResetUtc = dayUtcStart + resetUtcMs;
  if (now.getTime() < currentResetUtc) {
    currentResetUtc -= MS_PER_DAY;
  }

  const endedDayUtc = currentResetUtc - MS_PER_DAY;
  const endedDayDate = new Date(endedDayUtc);

  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const warDay = names[endedDayDate.getUTCDay()];
  if (!WAR_DAYS.includes(warDay)) return null;

  const y = endedDayDate.getUTCFullYear();
  const mo = String(endedDayDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(endedDayDate.getUTCDate()).padStart(2, "0");
  return { warDay, realDay: `${y}-${mo}-${d}` };
}

/**
 * Charge le fichier snapshot JSON pour un clan (lecture directe depuis le disque).
 */
/**
 * Lit le nom du clan depuis le cache persisté.
 */
async function readClanName(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return `#${tag}`;
  const raw = await readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  return data.clan?.name ?? `#${tag}`;
}

function normalizePlayerTag(tag) {
  if (!tag) return "";
  const normalized = tag.startsWith("#") ? tag.slice(1) : tag;
  return `#${normalized.toUpperCase()}`;
}

const ROLE_FR = {
  member: "membre",
  elder: "aîné",
  coLeader: "co-leader",
  leader: "leader",
};

async function readClanMemberNames(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return {};
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    const members = {};

    const membersRaw = data.membersRaw || {};
    for (const [playerTag, playerData] of Object.entries(membersRaw)) {
      const normTag = normalizePlayerTag(playerTag);
      members[normTag] = {
        name: playerData?.profile?.name || normTag,
        role: null,
      };
    }

    // data.members est la source de vérité pour l'appartenance actuelle au clan.
    // Ne pas utiliser uncomplete.players : cette liste peut contenir des ex-membres
    // qui n'ont pas joué leurs decks avant de quitter, ce qui fausserait la liste
    // des combats manquants.
    const membersList = Array.isArray(data.members) ? data.members : [];
    for (const member of membersList) {
      const playerTag = normalizePlayerTag(member?.tag);
      if (!playerTag) continue;
      members[playerTag] = {
        name: members[playerTag]?.name || member.name || playerTag,
        role: member.role ?? members[playerTag]?.role ?? null,
      };
    }

    return members;
  } catch {
    return {};
  }
}

/**
 * Calcule le total de points d'une journée GDC depuis _cumulFame.
 * Que ce soit en warDay ou en colosseum, _cumulFame est cumulatif sur toute la semaine
 * (le champ `fame` de l'API /currentriverrace s'accumule du J1 au J4 sans jamais
 * se remettre à zéro entre les jours). Pour obtenir les points du jour seul, on
 * soustrait systématiquement le cumul du jour précédent.
 */
function sumValues(map) {
  return Object.values(map ?? {}).reduce((a, b) => a + b, 0);
}

function computeDailyFame(dayEntry, prevDayEntry) {
  const todayCumul = sumValues(dayEntry._cumulFame);
  if (!prevDayEntry) return todayCumul;
  const prevCumul = sumValues(prevDayEntry._cumulFame);
  return Math.max(0, todayCumul - prevCumul);
}

const DECKS_MAX_WEEK = 800; // 50 membres × 4 decks × 4 jours

/** Formate un entier avec séparateur de milliers français : 88400 → "88 400". */
function fmt(n) {
  return Math.round(n).toLocaleString("fr-FR");
}

/**
 * Calcule le bilan de la semaine depuis l'ensemble des journées.
 * Retourne { totalFameWeek, totalDecksWeek, avgDecksPerDay, isColosseum, completeDays }
 *   - Colosseum : totalFameWeek = _cumulFame du dernier jour (cumul natif)
 *   - warDay    : totalFameWeek = somme des _cumulFame de chaque journée
 *   - Les journées sans snapshot sont ignorées du calcul de points mais comptées 0 en decks.
 */
function computeWeeklySummary(allDays) {
  const isColosseum = allDays.some((d) => d.periodType === "colosseum");

  // Decks : somme de chaque journée.
  // On privilégie le détail `decks` quand il existe, car il reflète le total réel.
  // Si `decks` est vide, on retombe sur `snapshotCount`.
  const decksByDay = allDays.map((d) => {
    const deckSum = Object.values(d.decks ?? {}).reduce((a, b) => a + b, 0);
    if (deckSum > 0) return deckSum;
    const snapshotCount = Number.isFinite(d.snapshotCount)
      ? d.snapshotCount
      : null;
    return snapshotCount != null && snapshotCount > 0 ? snapshotCount : 0;
  });
  const totalDecksWeek = decksByDay.reduce((a, b) => a + b, 0);
  const avgDecksPerDay = totalDecksWeek / allDays.length;

  // Points
  let totalFameWeek = null;
  const daysWithFame = allDays.filter(
    (d) => Object.keys(d._cumulFame ?? {}).length > 0,
  );

  if (daysWithFame.length > 0) {
    // warDay et colosseum : _cumulFame est cumulatif toute la semaine →
    // le dernier jour disponible contient déjà le total de la semaine.
    const lastWithFame = daysWithFame[daysWithFame.length - 1];
    totalFameWeek = Object.values(lastWithFame._cumulFame).reduce(
      (a, b) => a + b,
      0,
    );
  }

  return {
    totalFameWeek,
    totalDecksWeek,
    avgDecksPerDay,
    isColosseum,
    completeDays: daysWithFame.length,
  };
}

/** Formate un delta signé avec émoji de tendance. */
function fmtDelta(delta) {
  if (delta > 0) return `(+${fmt(delta)})`;
  if (delta < 0) return `(${fmt(delta)})`;
  return "(stable)";
}

/** Formate un rang en français : 1 → "1er", 2 → "2e", etc. */
function fmtRank(n) {
  return n === 1 ? "1er" : `${n}e`;
}

function computeDay3ClinchProof(race, ownClanTag) {
  const isWarDay =
    race?.periodType === "warDay" ||
    race?.state === "warDay" ||
    race?.state === "overtime" ||
    race?.state === "full" ||
    (typeof race?.periodIndex === "number" &&
      race.periodIndex >= 0 &&
      race.periodIndex <= 3);
  if (!isWarDay) return { known: false, isClinched: false };
  if (!Array.isArray(race?.clans) || race.clans.length === 0)
    return { known: false, isClinched: false };

  const ownTag = normalizeClanTag(ownClanTag);
  const MAX_FAME_DAY4 = 200 * 200; // 200 decks max sur J4, 200 fame max/deck

  const group = race.clans
    .map((clan) => {
      const participants = Array.isArray(clan?.participants)
        ? clan.participants
        : [];
      if (participants.length === 0) return null;
      const currentFame = participants.reduce((s, p) => s + (p.fame ?? 0), 0);
      const decksToday = participants.reduce(
        (s, p) => s + (p.decksUsedToday ?? 0),
        0,
      );
      return {
        tag: normalizeClanTag(clan?.tag),
        currentFame,
        decksToday,
      };
    })
    .filter(Boolean);

  if (group.length === 0) return { known: false, isClinched: false };
  const own = group.find((c) => c.tag === ownTag);
  if (!own) return { known: false, isClinched: false };

  const rivals = group.filter((c) => c.tag !== ownTag);
  if (rivals.length === 0) return { known: false, isClinched: false };

  // Condition de preuve: aucun deck joué en J4 au moment de la mesure.
  const cleanJ3Snapshot = group.every((c) => c.decksToday === 0);
  if (!cleanJ3Snapshot) return { known: false, isClinched: false };

  const bestRivalReachable = Math.max(
    ...rivals.map((c) => c.currentFame + MAX_FAME_DAY4),
  );
  const margin = own.currentFame - bestRivalReachable;
  return {
    known: true,
    isClinched: margin > 0,
    margin,
  };
}

function normalizeClanTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

/**
 * Détecte si le clan est déjà mathématiquement gagnant en warDay.
 * Règle stricte : currentFame(clan) > max(maxReachableFame(rivaux)).
 */
function computeClinchedWinInfo(race, ownClanTag) {
  const isWarDay =
    race?.periodType === "warDay" ||
    race?.state === "warDay" ||
    race?.state === "overtime" ||
    race?.state === "full" ||
    (typeof race?.periodIndex === "number" &&
      race.periodIndex >= 0 &&
      race.periodIndex <= 3);
  if (!isWarDay) return null;
  if (!Array.isArray(race?.clans) || race.clans.length === 0) return null;

  const MAX_WEEKLY_DECKS = 800; // 50*4*4
  const MAX_FAME_PER_DECK = 200;
  const ownTag = normalizeClanTag(ownClanTag);

  const group = race.clans
    .map((clan) => {
      const parts = Array.isArray(clan?.participants) ? clan.participants : [];
      if (parts.length === 0) return null;

      const currentFame = parts.reduce((s, p) => s + (p.fame ?? 0), 0);
      const decksUsedWeekly = parts.reduce((s, p) => s + (p.decksUsed ?? 0), 0);
      const remainingDecks = Math.max(0, MAX_WEEKLY_DECKS - decksUsedWeekly);
      const maxReachableFame = currentFame + remainingDecks * MAX_FAME_PER_DECK;

      return {
        tag: normalizeClanTag(clan?.tag),
        currentFame,
        maxReachableFame,
      };
    })
    .filter(Boolean);

  if (group.length === 0) return null;
  const own = group.find((c) => c.tag === ownTag);
  if (!own) return null;

  const rivals = group.filter((c) => c.tag !== ownTag);
  if (rivals.length === 0) return null;

  const bestRivalReachable = Math.max(...rivals.map((c) => c.maxReachableFame));
  const margin = own.currentFame - bestRivalReachable;

  return {
    isClinchedWin: margin > 0,
    margin,
    ownCurrentFame: own.currentFame,
    bestRivalReachable,
  };
}

async function sendDiscordEmbed(tag, channelId, token, embed) {
  if (DRY_RUN) {
    console.log(
      `\n[${tag}] ── DRY-RUN ── embed pour le channel ${channelId ?? "(non configuré)"} :`,
    );
    console.log(JSON.stringify({ embeds: [embed] }, null, 2));
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }
}

/**
 * Construit et envoie l'embed Discord du résumé GDC pour un clan.
 *
 * @param {string} tag
 * @param {string} clanName
 * @param {object} dayEntry           - snapshot de la journée terminée
 * @param {object|null} prevDayEntry      - snapshot de la veille (J-1)
 * @param {object|null} prevPrevDayEntry  - snapshot de l'avant-veille (J-2, pour calcul delta colosseum)
 * @param {object[]} allWeekDays      - les 4 journées de la semaine (pour le bilan J4)
 * @param {number|null} clanRank      - classement final (GDC classique J4 uniquement)
 */
async function postWarSummary(
  tag,
  clanName,
  dayEntry,
  prevDayEntry,
  prevPrevDayEntry,
  allWeekDays,
  earlyWinByDay3,
  clanRank = null,
  trophyChange = null,
  apiWeekFame = null, // clan.fame depuis raceLog[0] (cumul total pts de bataille semaine)
  apiWeekDecks = null, // sum(participants[].decksUsed) depuis raceLog[0]
) {
  const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
  const token = process.env.DISCORD_TOKEN;
  const { warDay } = dayEntry;
  const isLastDay = warDay === "sunday";

  // Appel live à /currentriverrace pour obtenir le cumul de fame exact après le reset.
  // Le snapshot disque est pris ~1h avant le reset et peut manquer les dernières minutes.
  // Après le reset, 0 deck n'a encore été joué dans la nouvelle journée → pl.fame est
  // le cumul exact de la journée qui vient de se terminer.
  let liveTodayCumul = null;
  let livePrevCumul = null;
  let liveBoatAttackers = [];
  let liveBoatTotal = 0;
  let clinchedInfo = null;
  let apiDayFame = null; // pointsEarned depuis periodLogs (source de vérité J1-J3)
  try {
    const race = await fetchCurrentRace(tag);
    const participants = race?.clan?.participants ?? [];
    if (participants.length > 0) {
      liveTodayCumul = participants.reduce((s, p) => s + (p.fame ?? 0), 0);
      liveBoatAttackers = participants
        .filter((p) => (p.boatAttacks ?? 0) > 0)
        .map((p) => ({
          name: p.name,
          tag: p.tag,
          boatAttacks: p.boatAttacks ?? 0,
        }));
      liveBoatTotal = liveBoatAttackers.reduce((s, p) => s + p.boatAttacks, 0);
    }
    clinchedInfo = computeClinchedWinInfo(race, tag);
    // Cumul du jour précédent depuis le snapshot (pour calculer le delta du jour)
    if (prevDayEntry && Object.keys(prevDayEntry._cumulFame ?? {}).length > 0) {
      livePrevCumul = Object.values(prevDayEntry._cumulFame).reduce(
        (a, b) => a + b,
        0,
      );
    }
    // periodLogs : source de vérité directe pour les pts de la journée terminée (J1-J3).
    // periodLogs[WAR_DAY_NUMBER[warDay] - 1] = entrée du jour concerné (ordre chronologique).
    // Absent pour J4 après le reset lundi → apiDayFame restera null, fallback snapshot.
    const periodLogIndex = WAR_DAY_NUMBER[warDay] - 1;
    const periodLog = race?.periodLogs?.[periodLogIndex];
    const ownTagNorm = `#${tag}`.toUpperCase();
    const periodLogItem = periodLog?.items?.find(
      (item) => (item.clan?.tag ?? "").toUpperCase() === ownTagNorm,
    );
    if (periodLogItem?.pointsEarned != null) {
      apiDayFame = periodLogItem.pointsEarned;
    }
  } catch (_) {
    // Appel live échoué — on tombera sur le calcul snapshot ci-dessous
  }

  // Totaux du jour
  const totalDecks = Object.values(dayEntry.decks ?? {}).reduce(
    (a, b) => a + b,
    0,
  );

  // Snapshot pré-reset (T-2 min) : source de vérité exacte.
  // _cumulFamePreReset est le cumul hebdomadaire capturé avant tout deck de la nouvelle journée.
  const cumulFamePreReset = dayEntry._cumulFamePreReset ?? null;
  const hasPreResetSnapshot =
    Boolean(dayEntry.snapshotPreResetTime) &&
    cumulFamePreReset !== null &&
    Object.keys(cumulFamePreReset).length > 0;

  const hasFameData =
    liveTodayCumul !== null ||
    hasPreResetSnapshot ||
    Object.keys(dayEntry._cumulFame ?? {}).length > 0;

  let totalFame;
  let isExactFame = false;
  if (!isLastDay && hasPreResetSnapshot) {
    // J1-J3 : snapshot pré-reset (cumulFamePreReset) = source de vérité la plus fiable.
    // periodLogs[n].pointsEarned peut inclure des pts de la nouvelle journée déjà en cours
    // au moment de l'appel live (si le clan a commencé à jouer avant que le résumé soit posté).
    // Le snapshot pré-reset est capturé à T−2 min, avant tout deck de la journée suivante.
    totalFame = computeDailyFame(
      { ...dayEntry, _cumulFame: cumulFamePreReset },
      prevDayEntry,
    );
    isExactFame = true;
  } else if (apiDayFame !== null) {
    // periodLogs disponible : source de vérité pour J1-J3 quand le snapshot pré-reset manque,
    // et pour J4 après le reset lundi.
    totalFame = apiDayFame;
    isExactFame = true;
  } else if (
    isLastDay &&
    hasPreResetSnapshot &&
    prevDayEntry?._cumulFamePreReset &&
    Object.keys(prevDayEntry._cumulFamePreReset).length > 0
  ) {
    // J4 exact : cumul pré-reset J4 − cumul pré-reset J3 (tous deux depuis currentriverrace = clanScore exact).
    totalFame = Math.max(
      0,
      sumValues(cumulFamePreReset) - sumValues(prevDayEntry._cumulFamePreReset),
    );
    isExactFame = true;
  } else if (
    isLastDay &&
    apiWeekFame !== null &&
    prevDayEntry?._cumulFamePreReset &&
    Object.keys(prevDayEntry._cumulFamePreReset).length > 0
  ) {
    // Fallback J4 : raceLog total semaine − cumul J3 pré-reset snapshot.
    totalFame = Math.max(
      0,
      apiWeekFame - sumValues(prevDayEntry._cumulFamePreReset),
    );
    isExactFame = true;
  } else if (hasPreResetSnapshot) {
    // On substitue _cumulFamePreReset à _cumulFame dans computeDailyFame :
    // même formule delta vs J-1, insensible au live post-reset (déjà contaminé par J+1).
    // Compatible Colisée : si prevDayEntry est null, retourne le cumul natif.
    totalFame = computeDailyFame(
      { ...dayEntry, _cumulFame: cumulFamePreReset },
      prevDayEntry,
    );
    isExactFame = true;
  } else {
    const snapshotFame = hasFameData
      ? computeDailyFame(dayEntry, prevDayEntry)
      : null;
    totalFame = snapshotFame;

    if (liveTodayCumul !== null && livePrevCumul !== null) {
      const liveDelta = Math.max(0, liveTodayCumul - livePrevCumul);
      const snapshotTotalCumul = sumValues(dayEntry._cumulFame);

      // /currentriverrace peut déjà pointer vers la nouvelle journée après reset.
      // On n'utilise le cumul live que s'il est au moins aussi élevé que le dernier
      // snapshot du jour terminé, sinon le snapshot reste la source de vérité.
      if (liveTodayCumul >= snapshotTotalCumul) {
        totalFame = liveDelta;
      } else if (snapshotFame === null) {
        totalFame = liveDelta;
      }
    }
  }

  // Totaux du jour précédent (pour les deltas)
  const prevDecks =
    prevDayEntry && Object.keys(prevDayEntry.decks ?? {}).length > 0
      ? Object.values(prevDayEntry.decks).reduce((a, b) => a + b, 0)
      : null;
  const prevFame =
    prevDayEntry && Object.keys(prevDayEntry._cumulFame ?? {}).length > 0
      ? computeDailyFame(prevDayEntry, prevPrevDayEntry)
      : null;

  // Bilan de semaine (J4 uniquement)
  let weekly = isLastDay ? computeWeeklySummary(allWeekDays) : null;
  if (weekly && !weekly.isColosseum) {
    if (hasPreResetSnapshot) {
      // Cumul hebdo exact capturé à T-2 min : plus précis que la somme des deltas journaliers.
      weekly = { ...weekly, totalFameWeek: sumValues(cumulFamePreReset) };
    } else if (liveTodayCumul !== null) {
      const snapshotTotalCumul = sumValues(dayEntry._cumulFame);
      if (liveTodayCumul >= snapshotTotalCumul) {
        weekly = { ...weekly, totalFameWeek: liveTodayCumul };
      }
    }
  }

  // Override avec données directes de raceLog (dimanche uniquement).
  // apiWeekFame = sum(participants[].fame) depuis raceLog[0], apiWeekDecks = sum(decksUsed).
  // On n'écrase PAS totalFameWeek si un snapshot pré-reset existe : il vient de currentriverrace
  // (= clanScore exact) et est plus fiable que le raceLog qui archive l'état au reset.
  if (weekly) {
    if (apiWeekFame !== null && !hasPreResetSnapshot)
      weekly = { ...weekly, totalFameWeek: apiWeekFame };
    if (apiWeekDecks !== null) {
      weekly = {
        ...weekly,
        totalDecksWeek: apiWeekDecks,
        avgDecksPerDay:
          allWeekDays.length > 0
            ? apiWeekDecks / allWeekDays.length
            : weekly.avgDecksPerDay,
      };
    }
  }

  // Couleur selon la tendance (fame en priorité, decks en fallback)
  let color = 0x5865f2; // bleu neutre (J1 ou données insuffisantes)
  if (totalFame !== null && prevFame !== null) {
    color = totalFame >= prevFame ? 0x57f287 : 0xed4245;
  } else if (prevDecks !== null) {
    color = totalDecks >= prevDecks ? 0x57f287 : 0xed4245;
  }

  const fields = [];

  // ── Résumé du jour ──
  const isColosseum = dayEntry.periodType === "colosseum";

  if (hasFameData) {
    if (totalFame === null) {
      throw new Error(
        `Données de fame incomplètes pour ${tag} (${dayEntry.realDay})`,
      );
    }
    let line;
    if (
      isLastDay &&
      totalFame === 0 &&
      (earlyWinByDay3 === true || clinchedInfo?.isClinchedWin === true)
    ) {
      line = "0 pts (victoire acquise.)";
    } else {
      // ≈ uniquement si la valeur est estimée (snapshot horaire) ; exact si pré-reset disponible
      line = `${isExactFame ? "" : "≈"}${fmt(totalFame)} pts`;
      // En Colisée le score journalier fluctue selon les matchs — le delta n'est pas significatif
      if (prevFame !== null && !isColosseum)
        line += ` ${fmtDelta(totalFame - prevFame)}`;
    }
    fields.push({
      name: "<:trophy:1498645869224792105> Points marqués",
      value: line,
      inline: false,
    });
  }

  {
    let line = `${fmt(totalDecks)} decks`;
    if (prevDecks !== null) line += ` ${fmtDelta(totalDecks - prevDecks)}`;
    fields.push({
      name: "<:cards:1493711279121104926> Decks joués",
      value: line,
      inline: false,
    });
  }

  {
    const memberNames = await readClanMemberNames(tag);
    // Itérer sur les membres actuels du cache : inclut les membres absents du
    // snapshot (0 decks), exclut les ex-membres (riko, les Goetter…) qui ne sont
    // plus dans data.members/membersRaw mais pourraient traîner dans d'autres listes.
    const missingPlayers = Object.entries(memberNames)
      .map(([tagNorm, { name, role }]) => {
        const decksCount = Number(dayEntry.decks?.[tagNorm]) || 0;
        return {
          tag: tagNorm,
          name,
          role,
          missing: Math.max(0, 4 - decksCount),
        };
      })
      .filter((p) => p.missing > 0)
      .sort(
        (a, b) => b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
      );

    const totalMissingDecks = missingPlayers.reduce(
      (sum, player) => sum + player.missing,
      0,
    );

    if (totalMissingDecks > 0) {
      if (totalMissingDecks < 30) {
        const lines = missingPlayers.map((player) => {
          const playerUrl = `https://trustroyale.vercel.app/fr/player/${player.tag.replace(/^#/, "")}`;
          const roleFr = ROLE_FR[player.role] ?? player.role ?? null;
          const roleLabel = roleFr ? ` · ${roleFr}` : "";
          return `- [${player.name}](${playerUrl}) (x${player.missing})${roleLabel}`;
        });
        const value = lines.join("\n");
        fields.push({
          name: "<:eyeclosed:1504138067580158053> Combats manquants",
          value: value,
          inline: false,
        });
      } else {
        fields.push({
          name: `Combats manquants (${fmt(totalMissingDecks)})`,
          value: "\u200b",
          inline: false,
        });
      }
    }
  }

  if (liveBoatTotal > 0) {
    const boatNames = liveBoatAttackers
      .map((p) => {
        const plTag = p.tag.startsWith("#") ? p.tag : `#${p.tag}`;
        const playerUrl = `https://trustroyale.vercel.app/fr/player/${plTag.replace(/^#/, "")}`;
        return `[${p.name}](${playerUrl})`;
      })
      .join(", ");
    fields.push({
      name: "<:boat:1495083435612438729> Attaques bateau (cumul)",
      value: `${liveBoatTotal} attaque${liveBoatTotal > 1 ? "s" : ""} — ${boatNames}`,
      inline: false,
    });
  }

  if (clinchedInfo?.isClinchedWin) {
    fields.push({
      name: "<:topplayers:1493708397407899648> Statut de la course",
      value: `✅ Victoire mathématiquement assurée (avance minimale garantie: ${fmt(clinchedInfo.margin)} pts).`,
      inline: false,
    });
  } else if (earlyWinByDay3 === true) {
    fields.push({
      name: "<:topplayers:1493708397407899648> Statut de la course",
      value:
        "✅ Victoire acquise dès le samedi — J4 ne rapporte aucun point supplémentaire.",
      inline: false,
    });
  }

  // Footer : date de publication réelle du constat (après le reset GDC).
  const postDate = new Date();
  const postParis = new Date(
    postDate.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const pd = String(postParis.getDate()).padStart(2, "0");
  const pm = String(postParis.getMonth() + 1).padStart(2, "0");
  const py = postParis.getFullYear();
  const ph = String(postParis.getHours()).padStart(2, "0");
  const pmin = String(postParis.getMinutes()).padStart(2, "0");
  const postDayFR = [
    "dimanche",
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
  ][postParis.getDay()];
  const postDateFR = `${postDayFR} ${pd}/${pm}/${py} à ${ph}h${pmin}`;

  // Calcul de l'écart entre le snapshot utilisé et le reset de fin de journée GDC.
  // La journée GDC débute à realDay+resetOffset et se termine le lendemain au même offset.
  const snapshotTs =
    dayEntry.snapshotPreResetTime ?? dayEntry.snapshotTime ?? null;
  let snapshotGapText = "";
  if (snapshotTs && dayEntry.realDay) {
    const resetOffsetMs = warResetOffsetMs(tag);
    const dayUtcStart = Date.parse(`${dayEntry.realDay}T00:00:00Z`);
    // Fin de la journée GDC = lendemain au même heure de reset
    const endOfWarDayMs = dayUtcStart + 24 * 60 * 60 * 1000 + resetOffsetMs;
    const gapMin = Math.round((Date.parse(snapshotTs) - endOfWarDayMs) / 60000);
    snapshotGapText = `Écart snapshot/reset : ${gapMin >= 0 ? "+" : ""}${gapMin} min`;
  }

  const dailyEmbed = {
    title: `<:stats:1499284927894650950> ${clanName} · Résumé GDC`,
    description: `Journée ${WAR_DAY_NUMBER[warDay]} (${WAR_DAY_FR[warDay]})`,
    color,
    fields,
    footer: {
      text: `Constat fait le ${postDateFR}${snapshotGapText ? `\n${snapshotGapText}` : ""}`,
    },
  };

  if (!channelId) {
    console.log(
      `[${tag}] DISCORD_CHANNEL_MEMBERS_${tag} non configuré — résumé ignoré.`,
    );
    return;
  }
  if (!token) {
    console.log(`[${tag}] DISCORD_TOKEN non configuré — résumé ignoré.`);
    return;
  }

  await sendDiscordEmbed(tag, channelId, token, dailyEmbed);

  if (weekly) {
    const weeklyFields = [];
    if (weekly.totalFameWeek !== null) {
      const fameLabel = weekly.isColosseum
        ? "<:trophy:1498645869224792105> Points totaux (Colisée)"
        : "<:trophy:1498645869224792105> Points totaux";
      weeklyFields.push({
        name: fameLabel,
        value: `${apiWeekFame !== null ? "" : "≈"}${fmt(weekly.totalFameWeek)} pts`,
        inline: false,
      });
    } else {
      throw new Error(
        `Bilan de semaine incomplet pour ${tag} (${dayEntry.realDay})`,
      );
    }

    const pct = Math.round((weekly.totalDecksWeek / DECKS_MAX_WEEK) * 100);
    weeklyFields.push({
      name: "<:cards:1493711279121104926> Decks semaine",
      value: `${fmt(weekly.totalDecksWeek)} / ${fmt(DECKS_MAX_WEEK)} (${pct}%)`,
      inline: false,
    });

    weeklyFields.push({
      name: "<:battle:1493710671244689449> Moyenne / jour",
      value: `${weekly.avgDecksPerDay.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} decks`,
      inline: false,
    });

    if (liveBoatTotal > 0) {
      const boatNames = liveBoatAttackers.map((p) => p.name).join(", ");
      weeklyFields.push({
        name: "<:boat:1495083435612438729> Attaques bateau",
        value: `${liveBoatTotal} attaque${liveBoatTotal > 1 ? "s" : ""} — ${boatNames}`,
        inline: false,
      });
    }

    if (clanRank !== null) {
      const rankValue =
        clanRank === 1
          ? `${fmtRank(clanRank)} / 5 — ✅ Première place`
          : `${fmtRank(clanRank)} / 5`;
      weeklyFields.push({
        name: "<:topplayers:1493708397407899648> Classement",
        value: rankValue,
        inline: false,
      });
    }

    if (trophyChange !== null) {
      const sign = trophyChange >= 0 ? "+" : "";
      weeklyFields.push({
        name: "<:topplayers:1493708397407899648> Trophées de guerre",
        value: `${sign}${trophyChange}`,
        inline: false,
      });
    }

    const weeklyEmbed = {
      title: `<:stats:1499284927894650950> ${clanName} · Bilan de la semaine`,
      description: `Résumé de la semaine${allWeekDays[0]?.week ? ` ${allWeekDays[0].week}` : ""}`,
      color,
      fields: weeklyFields,
      footer: { text: `Constat fait le ${postDateFR}` },
    };

    await sendDiscordEmbed(tag, channelId, token, weeklyEmbed);
  }

  const fameStr = totalFame !== null ? `${fmt(totalFame)} pts` : "pts N/A";
  console.log(
    `[${tag}] Résumé GDC posté — J${WAR_DAY_NUMBER[warDay]} (${fameStr}, ${fmt(totalDecks)} decks).`,
  );
}

export { computeWeeklySummary };

async function main() {
  const now = new Date();
  const log = await loadLog();
  const clinchLog = await loadClinchLog();

  for (const tag of ALLOWED_CLANS) {
    if (CLAN_FILTER && tag !== CLAN_FILTER) continue;
    try {
      const endedDay = getEndedWarDay(now, tag);
      if (!endedDay) {
        console.log(
          `[${tag}] Pas de journée GDC terminée à cette heure — ignoré.`,
        );
        continue;
      }
      const { warDay, realDay } = endedDay;

      // Vérification anti-doublon
      if (!FORCE && alreadyPosted(log, tag, warDay, realDay)) {
        console.log(
          `[${tag}] Résumé déjà posté pour ${warDay} ${realDay} — ignoré. (--force pour forcer)`,
        );
        continue;
      }

      const [snapshots, clanName] = await Promise.all([
        loadSnapshots(tag),
        readClanName(tag),
      ]);

      if (!snapshots.length) {
        console.log(`[${tag}] Pas de snapshots disponibles — résumé ignoré.`);
        continue;
      }

      // Chercher la semaine contenant ce realDay
      // On rejette les entrées périmées : snapshotTime < gdcPeriod.start signifie que
      // le snapshot a été pris AVANT le début de la journée GDC (ex. semaine précédente
      // avec les mêmes dates réelles) et ne doit pas être utilisé.
      let dayEntry = null;
      let prevDayEntry = null;
      let prevPrevDayEntry = null;
      let allWeekDays = [];
      let selectedWeekId = null;

      for (const week of snapshots) {
        const dayIdx = (week.days ?? []).findIndex(
          (d) => d.realDay === realDay,
        );
        if (dayIdx === -1) continue;
        const candidate = week.days[dayIdx];
        // Rejeter si le snapshot précède le début de la période GDC (entrée périmée)
        if (
          candidate.snapshotTime &&
          candidate.gdcPeriod?.start &&
          candidate.snapshotTime < candidate.gdcPeriod.start
        )
          continue;
        dayEntry = candidate;
        prevDayEntry = dayIdx > 0 ? week.days[dayIdx - 1] : null;
        prevPrevDayEntry = dayIdx > 1 ? week.days[dayIdx - 2] : null;
        allWeekDays = week.days ?? [];
        selectedWeekId = week.week ?? null;
        break;
      }

      if (!dayEntry?.snapshotTime) {
        console.log(
          `[${tag}] Pas de snapshot pour ${realDay} (${warDay}) — résumé ignoré.`,
        );
        continue;
      }

      const hasData =
        Object.keys(dayEntry.decks ?? {}).length > 0 ||
        Object.keys(dayEntry._cumulFame ?? {}).length > 0;
      if (!hasData) {
        console.log(`[${tag}] Snapshot vide pour ${realDay} — résumé ignoré.`);
        continue;
      }

      // Classement final : uniquement J4, après le reset
      let clanRank = null;
      let trophyChange = null;
      let apiWeekFame = null; // clan.fame depuis raceLog[0] = cumul total pts de bataille semaine
      let apiWeekDecks = null; // sum(participants[].decksUsed) depuis raceLog[0]
      let earlyWinByDay3 = null;

      // Sur le run post-reset de J3 (warDay = saturday), on tente d'établir une preuve
      // rigoureuse en lisant le groupe avant tout deck J4.
      if (warDay === "saturday" && process.env.CLASH_API_KEY) {
        try {
          const [raceLog, currentRace] = await Promise.all([
            fetchRaceLog(tag),
            fetchCurrentRace(tag),
          ]);
          const weekId = computeCurrentWeekId(currentRace, raceLog);
          if (weekId) {
            const key = `${tag}:${weekId}`;
            const proof = computeDay3ClinchProof(currentRace, tag);
            clinchLog[key] = {
              known: proof.known === true,
              isClinched:
                proof.known === true ? proof.isClinched === true : null,
              computedAt: new Date().toISOString(),
            };
            await saveClinchLog(clinchLog);
          }
        } catch (err) {
          console.warn(`[${tag}] Preuve J3 indisponible : ${err.message}`);
        }
      }

      if (warDay === "sunday" && process.env.CLASH_API_KEY) {
        try {
          const raceLog = await fetchRaceLog(tag);
          const standing = (raceLog[0]?.standings ?? []).find(
            (s) => s.clan?.tag === `#${tag}`,
          );
          clanRank = standing?.rank ?? null;
          trophyChange = standing?.trophyChange ?? null;
          // sum(participants[].fame) = source de vérité pour le cumul pts de bataille semaine.
          // clan.fame dans raceLog est inconsistant (parfois = position bateau 10000, parfois = sum).
          // clan.clanScore dans raceLog = trophées de guerre (~3000-5000), ne pas utiliser.
          if (standing?.clan?.participants != null) {
            apiWeekFame = standing.clan.participants.reduce(
              (s, p) => s + (p.fame ?? 0),
              0,
            );
            apiWeekDecks = standing.clan.participants.reduce(
              (s, p) => s + (p.decksUsed ?? 0),
              0,
            );
          }
        } catch (err) {
          console.warn(`[${tag}] Classement indisponible : ${err.message}`);
        }

        if (selectedWeekId) {
          const key = `${tag}:${selectedWeekId}`;
          const proof = clinchLog[key];
          if (proof?.known === true) {
            earlyWinByDay3 = proof.isClinched === true;
          }
        }
      }

      await postWarSummary(
        tag,
        clanName,
        dayEntry,
        prevDayEntry,
        prevPrevDayEntry,
        allWeekDays,
        earlyWinByDay3,
        clanRank,
        trophyChange,
        apiWeekFame,
        apiWeekDecks,
      );
      await markPosted(log, tag, warDay, realDay);
    } catch (err) {
      console.error(`[${tag}] Erreur : ${err.message}`);
    }
  }

  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}
