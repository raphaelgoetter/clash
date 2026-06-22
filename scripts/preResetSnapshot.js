#!/usr/bin/env node
// preResetSnapshot.js
// Prend une "photo" instantanée des données GDC pour chaque clan, 2 minutes
// avant son reset journalier. Le script est lancé par GitHub Actions à 08:00 UTC
// (ven–lun), attend précisément jusqu'à T−2 min de chaque reset, puis appelle
// l'API Clash Royale en moins d'une seconde.
//
// Usage :
//   node scripts/preResetSnapshot.js              — mode normal
//   node scripts/preResetSnapshot.js --dry-run    — affiche les timings sans appel API

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { ALLOWED_CLANS } from "../backend/routes/clan.js";
import {
  fetchCurrentRace,
  fetchRaceLog,
  fetchBattleLog,
} from "../backend/services/clashApi.js";
import { recordSnapshot } from "../backend/services/snapshot.js";
import {
  CLAN_RESET_TIMES,
  computeCurrentWeekId,
  computePrevWeekId,
} from "../backend/services/dateUtils.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PRE_RESET_LEAD_MS = 2 * 60 * 1000; // 2 minutes avant le reset

async function buildBattleLogsByTag(participants = []) {
  const entries = await Promise.all(
    participants.map(async (participant) => {
      try {
        return [participant.tag, await fetchBattleLog(participant.tag)];
      } catch (_) {
        return [participant.tag, null];
      }
    }),
  );
  return Object.fromEntries(entries.filter(([, log]) => Array.isArray(log)));
}

/** Retourne le timestamp UTC (ms) du prochain reset journalier d'un clan, le jour courant. */
function todayResetUtcMs(clanTag, now = new Date()) {
  const cfg = CLAN_RESET_TIMES[String(clanTag).replace("#", "").toUpperCase()];
  const h = cfg?.h ?? 9;
  const m = cfg?.m ?? 40;
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return utcMidnight + (h * 60 + m) * 60 * 1000;
}

/** Retourne le nom anglais du jour courant (UTC). */
function utcDayName(now = new Date()) {
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return names[now.getUTCDay()];
}

/** Attend jusqu'au timestamp cible (ms). */
function sleepUntil(targetMs) {
  const delay = targetMs - Date.now();
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Attend un délai fixe en ms. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takePreResetSnapshot(clanTag) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 10_000; // 10s entre chaque tentative

  let race = null;
  let raceLog = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(
      `[${clanTag}] Appel API pré-reset (tentative ${attempt}/${MAX_ATTEMPTS})...`,
    );
    try {
      [race, raceLog] = await Promise.all([
        fetchCurrentRace(clanTag),
        fetchRaceLog(clanTag),
      ]);
    } catch (err) {
      console.warn(
        `[${clanTag}] Erreur API tentative ${attempt}: ${err.message}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        console.log(
          `[${clanTag}] Nouvel essai dans ${RETRY_DELAY_MS / 1000}s...`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }

    const participants = race?.clan?.participants ?? [];
    if (participants.length === 0) {
      console.warn(
        `[${clanTag}] Aucun participant (tentative ${attempt}) — ${attempt < MAX_ATTEMPTS ? `nouvel essai dans ${RETRY_DELAY_MS / 1000}s...` : "snapshot ignoré."}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return;
    }

    // API OK, on sort de la boucle
    break;
  }

  const participants = race?.clan?.participants ?? [];
  if (participants.length === 0) return;

  const WAR_ACTIVE_TYPES = ["warDay", "colosseum"];
  const weekId = !WAR_ACTIVE_TYPES.includes(race?.periodType)
    ? computePrevWeekId(raceLog)
    : computeCurrentWeekId(race, raceLog);

  const decksTotal = participants.reduce(
    (s, p) => s + (p.decksUsedToday ?? 0),
    0,
  );
  const fameTotal = participants.reduce((s, p) => s + (p.fame ?? 0), 0);
  const battleLogsByTag = await buildBattleLogsByTag(participants);
  console.log(
    `[${clanTag}] ${participants.length} participants — decks aujourd'hui: ${decksTotal}, fame cumulée: ${fameTotal} — weekId: ${weekId}`,
  );

  if (DRY_RUN) {
    console.log(
      `[${clanTag}] DRY-RUN — snapshot non enregistré (periodType: ${race?.periodType}).`,
    );
    return;
  }

  await recordSnapshot(clanTag, participants, weekId, {
    snapshotType: "pre-reset",
    periodType: race?.periodType,
    battleLogsByTag,
    periodLogs: race?.periodLogs,
    periodPoints: race?.clan?.periodPoints,
  });
  console.log(`[${clanTag}] Snapshot pré-reset enregistré.`);
}

async function main() {
  const key = process.env.CLASH_API_KEY;
  if (!key) {
    console.error("CLASH_API_KEY doit être défini.");
    process.exit(1);
  }

  const now = new Date();
  const today = utcDayName(now);

  // Le cron (war-summary.yml) est la seule source de vérité sur les jours d'exécution.
  // Pas de guard ici : si le script tourne un jour sans reset GDC, les clans auront
  // msUntilReset < 0 et seront simplement sautés.

  // Construire la liste des clans triés par heure de reset (le plus tôt d'abord).
  const clansWithReset = ALLOWED_CLANS.map((tag) => {
    const cleanTag = tag.replace("#", "").toUpperCase();
    const resetMs = todayResetUtcMs(cleanTag, now);
    const targetMs = resetMs - PRE_RESET_LEAD_MS;
    return { tag: cleanTag, resetMs, targetMs };
  }).sort((a, b) => a.targetMs - b.targetMs);

  console.log(`Matin de reset : ${today}. Planning des snapshots pré-reset :`);
  for (const { tag, resetMs, targetMs } of clansWithReset) {
    const resetTime = new Date(resetMs).toISOString();
    const snapTime = new Date(targetMs).toISOString();
    console.log(
      `  [${tag}] reset: ${resetTime} → snapshot prévu: ${snapTime} (T−2 min)`,
    );
  }

  for (const { tag, targetMs, resetMs } of clansWithReset) {
    const msUntilTarget = targetMs - Date.now();
    const msUntilReset = resetMs - Date.now();

    if (msUntilReset < 0) {
      // Le reset est déjà passé (script lancé trop tard pour ce clan).
      console.warn(
        `[${tag}] Reset déjà passé (il y a ${Math.round(-msUntilReset / 1000)}s) — snapshot sauté.`,
      );
      continue;
    }

    if (msUntilTarget > 0) {
      console.log(
        `[${tag}] Attente de ${Math.round(msUntilTarget / 1000)}s jusqu'à T−2 min...`,
      );
      await sleepUntil(targetMs);
    }

    const takenAt = new Date().toISOString();
    console.log(`[${tag}] ⏱ Snapshot déclenché à ${takenAt}`);

    try {
      await takePreResetSnapshot(tag);
    } catch (err) {
      console.error(
        `[${tag}] Échec définitif après ${3} tentatives:`,
        err.message,
      );
    }
  }

  console.log("Tous les snapshots pré-reset traités.");
  process.exit(0);
}

main();
