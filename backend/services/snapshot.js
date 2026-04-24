// ============================================================
// snapshot.js — helper for recording daily decksUsed snapshots from a
// river race log. File-based storage under data/snapshots.
// ============================================================

import fs from "fs/promises";
import path from "path";

import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { parisOffsetMs, warResetOffsetMs } from "./dateUtils.js";
const SNAP_DIR = path.resolve(__dirname, "..", "..", "data", "snapshots");
const RETENTION_DAYS = 60;

async function ensureDirectory() {
  try {
    await fs.mkdir(SNAP_DIR, { recursive: true });
  } catch (_) {}
}

function snapshotFilename(clanTag) {
  // sanitize tag (# replaced by empty)
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  return path.join(SNAP_DIR, `${clean}.json`);
}

function convertLegacySnapshots(raw, clanTag = null) {
  // Legacy format: array of { week, date, warDay, decks, _cumul, ... }
  // Convert to new format: [{ week, days: [{ warDay, realDay, snapshots:[...], decks: {...} }] }]
  const byWeek = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const week = entry.week ?? "unknown";
    const dayKey = entry.date;
    const warDay = entry.warDay ?? getWarDayName(dayKey);
    const takenAt =
      entry._snapshotTakenAt ?? entry._generatedAt ?? `${dayKey}T12:00:00Z`;
    const weekObj = byWeek.get(week) ?? { week, days: [] };
    weekObj.days.push({
      warDay,
      realDay: dayKey,
      snapshots: [{ type: "legacy", takenAt, decks: entry.decks ?? {} }],
      decks: { ...(entry.decks ?? {}) },
    });
    byWeek.set(week, weekObj);
  }
  return Array.from(byWeek.values()).map((w) => {
    const week = {
      week: w.week,
      days: w.days,
    };
    return fillWeekDays(week, clanTag);
  });
}

function normalizeSnapshots(raw, clanTag = null) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];

  // Already new format (weeks with days array)
  if (raw[0].week && Array.isArray(raw[0].days)) {
    // Ensure each week has a full set of days + computed metadata (gdcPeriod, etc.)
    return raw.map((w) => fillWeekDays(w, clanTag));
  }

  // Legacy format (flat list) -> convert
  return convertLegacySnapshots(raw, clanTag);
}

async function loadSnapshots(clanTag) {
  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  try {
    const txt = await fs.readFile(file, "utf-8");
    const raw = JSON.parse(txt);
    return normalizeSnapshots(raw, clanTag);
  } catch (err) {
    return [];
  }
}

async function saveSnapshots(clanTag, weeks) {
  // _cumul est persisté sur disque : il sert à calculer le delta quotidien
  // au run suivant (baseCumul = _cumul du jour précédent). Le stripper
  // provoquait rawDaily = cumulatif total au lieu du vrai delta du jour.
  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  await fs.writeFile(file, JSON.stringify(weeks || [], null, 2));
}

/**
 * Return a (Paris-local) date string YYYY-MM-DD for a given Date.
 */
function parisDateKey(date = new Date()) {
  const p = new Date(
    date.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const y = p.getFullYear();
  const m = String(p.getMonth() + 1).padStart(2, "0");
  const d = String(p.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Build a UTC timestamp representing `YYYY-MM-DD` at `hh:mm` in Paris local time.
 */
function parisTimeUtcMs(dateKey, hour = 0, minute = 0) {
  const [y, m, d] = (dateKey ?? "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const utcMs = Date.UTC(y, m - 1, d, hour, minute);
  // Compute offset for midday to avoid DST boundary issues
  const offset = parisOffsetMs(new Date(`${dateKey}T12:00:00Z`));
  return utcMs - offset;
}

/**
 * Retourne le timestamp UTC (ms) correspondant au début d'une journée GDC.
 * Par défaut 09:40 UTC ; peut être surchargé par clan (ex. Y8JUPC9C → 09:52 UTC).
 */
function warPeriodStartUtcMs(realDay, clanTag = null) {
  const [y, m, d] = (realDay ?? "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const offsetMs = warResetOffsetMs(clanTag);
  const h = Math.floor(offsetMs / 3_600_000);
  const min = (offsetMs % 3_600_000) / 60_000;
  return Date.UTC(y, m - 1, d, h, min, 0);
}

/**
 * For a given timestamp, return the war day (thu/fri/sat/sun) and the corresponding
 * local calendar date (Paris) for that war day.
 *
 * A war day runs from the clan's reset UTC until the next day exactly 24h later.
 */
function getWarDayInfo(date = new Date(), clanTag = null) {
  const paris = new Date(
    date.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const utc = new Date(date.toISOString());
  const resetUtcMs = warResetOffsetMs(clanTag);
  const msOfDayUtc =
    utc.getUTCHours() * 3600000 +
    utc.getUTCMinutes() * 60000 +
    utc.getUTCSeconds() * 1000 +
    utc.getUTCMilliseconds();

  // Before reset, on est toujours sur la journée précédente.
  // Après reset, on passe à la journée suivante.
  if (msOfDayUtc < resetUtcMs) {
    paris.setDate(paris.getDate() - 1);
  }

  const dow = paris.getDay(); // 0=Sun..6=Sat
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const warDay = names[dow];
  const warDays = ["thursday", "friday", "saturday", "sunday"];
  if (!warDays.includes(warDay)) return null;

  return {
    warDay,
    realDay: parisDateKey(paris),
  };
}

function getWarDayName(warDayKey) {
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const d = new Date(`${warDayKey}T12:00:00Z`);
  return names[d.getUTCDay()] ?? null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const WAR_DAYS = ["thursday", "friday", "saturday", "sunday"];

function mergeMaps(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v ?? 0);
  }
  return out;
}

function clampDeckValues(decks = {}) {
  const normalized = Object.entries(decks)
    .filter(([, v]) => Number.isFinite(v) && v >= 0)
    .map(([k, v]) => [k, Math.min(4, Math.max(0, Math.round(v)))]);

  // Keep top 50 contributors to avoid impossible sums (>200) and membership overflow.
  const prioritized = normalized
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50);

  return Object.fromEntries(prioritized);
}

function makeEmptyDay(warDay, realDay = null, clanTag = null) {
  const gdcPeriod = realDay
    ? {
        start: new Date(warPeriodStartUtcMs(realDay, clanTag)).toISOString(),
        end: new Date(
          warPeriodStartUtcMs(realDay, clanTag) + MS_PER_DAY - 1,
        ).toISOString(),
      }
    : null;

  return {
    warDay,
    realDay,
    gdcPeriod,
    snapshotTime: null,
    snapshotBackupTime: null,
    decks: {},
    hourlyCumul: [],
    _cumulFame: {},
    periodType: null,
  };
}

function fillWeekDays(week, clanTag = null) {
  // Ensure week.days contains exactly one entry per war day (thu→sun), ordered.
  const byWarDay = new Map((week.days ?? []).map((d) => [d.warDay, d]));

  // Try to infer a reference date if any day has a realDay.
  let refWarDay = null;
  let refRealDay = null;
  for (const wd of WAR_DAYS) {
    const d = byWarDay.get(wd);
    if (d?.realDay) {
      refWarDay = wd;
      refRealDay = d.realDay;
      break;
    }
  }

  const refIndex = refWarDay ? WAR_DAYS.indexOf(refWarDay) : -1;
  const refDate = refRealDay ? new Date(`${refRealDay}T12:00:00Z`) : null;

  const days = WAR_DAYS.map((wd, idx) => {
    const existing = byWarDay.get(wd);
    let realDay = existing?.realDay ?? null;
    if (!realDay && refDate && refIndex !== -1) {
      const delta = idx - refIndex;
      realDay = new Date(refDate.getTime() + delta * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
    }

    const day = existing ? { ...existing } : makeEmptyDay(wd, realDay, clanTag);
    day.warDay = wd;
    day.realDay = realDay;

    // Fenêtre temporelle UTC de la journée GDC : reset UTC → lendemain même heure.
    if (realDay) {
      const startMs = warPeriodStartUtcMs(realDay, clanTag);
      const endMs = startMs ? startMs + MS_PER_DAY - 1 : null;
      day.gdcPeriod =
        startMs && endMs
          ? {
              start: new Date(startMs).toISOString(),
              end: new Date(endMs).toISOString(),
            }
          : null;
    }

    // Ensure mandatory fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day.hourlyCumul = day.hourlyCumul ?? [];
    day._cumul = day._cumul ?? {};
    day._cumulFame = day._cumulFame ?? {};
    day.periodType = day.periodType ?? null;

    return day;
  });

  week.days = days;
  return week;
}

/**
 * Enregistre les combats GDC du jour pour chaque participant.
 * `decks` = combats effectués aujourd'hui seulement (0–4 par joueur).
 * `_cumul` = total hebdo depuis l'API (conservé pour calculer le delta du jour suivant).
 *
 * @param {string} clanTag
 * @param {{tag:string,decksUsed:number}[]} participantData
 *        participants de /currentriverrace (decksUsed = cumul depuis jeudi)
 */
export async function recordSnapshot(
  clanTag,
  participantData,
  week = null,
  options = {},
) {
  if (!participantData || participantData.length === 0) return;

  const now = options.now ? new Date(options.now) : new Date();
  const paris = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );

  const resetUtcMs = warResetOffsetMs(clanTag);
  const msOfDayUtc =
    now.getUTCHours() * 3600000 +
    now.getUTCMinutes() * 60000 +
    now.getUTCSeconds() * 1000 +
    now.getUTCMilliseconds();
  // Before reset → primary snapshot (captures the final decks of the day)
  // After reset  → backup snapshot (should be empty/zeroed)
  const snapshotType = msOfDayUtc < resetUtcMs ? "primary" : "backup";

  const warInfo = getWarDayInfo(now, clanTag);
  if (!warInfo) return; // outside of war period (mon-wed after reset)

  const { warDay, realDay } = warInfo;

  // weekly cumulative totals from currentriverrace
  const currentCumul = {};
  const currentCumulFame = {};
  participantData.forEach((p) => {
    currentCumul[p.tag] = p.decksUsed || 0;
    currentCumulFame[p.tag] = p.fame || 0;
  });

  const history = await loadSnapshots(clanTag);

  const weekId = week ?? "unknown";
  let weekEntry = history.find((w) => w.week === weekId);
  if (!weekEntry) {
    weekEntry = { week: weekId, days: [] };
    history.push(weekEntry);
  }

  // Ensure we have exactly four ordered war days (thu→sun).
  const existing = new Map((weekEntry.days ?? []).map((d) => [d.warDay, d]));
  const baseDate = new Date(`${realDay}T12:00:00Z`);
  const baseIndex = WAR_DAYS.indexOf(warDay);

  weekEntry.days = WAR_DAYS.map((wd, idx) => {
    const existingDay = existing.get(wd);
    const day = existingDay ? { ...existingDay } : makeEmptyDay(wd, null);

    // Infer the real calendar date for each war day based on the current war day.
    if (baseIndex !== -1) {
      day.realDay = new Date(
        baseDate.getTime() + (idx - baseIndex) * MS_PER_DAY,
      )
        .toISOString()
        .slice(0, 10);
    }

    // Ensure required fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day._cumul = day._cumul ?? {};
    day._cumulFame = day._cumulFame ?? {};
    day.periodType = day.periodType ?? null;

    return day;
  });

  const dayEntry = weekEntry.days[baseIndex];
  if (!dayEntry) return; // should not happen

  // Ensure the real day matches the computed one (Paris date of the war day)
  dayEntry.realDay = realDay;

  // Fenêtre temporelle UTC de la journée GDC : reset UTC → lendemain même heure.
  if (realDay) {
    const startMs = warPeriodStartUtcMs(realDay, clanTag);
    const endMs = startMs ? startMs + MS_PER_DAY - 1 : null;
    dayEntry.gdcPeriod =
      startMs && endMs
        ? {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
          }
        : null;
  }

  // Determine decks for this snapshot (delta since yesterday)
  const prevDay = weekEntry.days[WAR_DAYS.indexOf(warDay) - 1];
  const baseCumul = prevDay?._cumul ?? {};

  const baseCumulHasData = Object.keys(baseCumul).length > 0;

  const rawDaily = {};
  const daily = {};
  for (const tag of Object.keys(currentCumul)) {
    const delta = Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0));
    rawDaily[tag] = delta;
    daily[tag] = Math.min(4, delta);
  }

  // Si baseCumul est fiable (non vide), on utilise le delta exact comme source
  // de vérité — cela permet de corriger des valeurs gonflées lors de runs
  // précédents où baseCumul était absent. Sinon, on garde le max (sécurité).
  dayEntry.decks = clampDeckValues(
    baseCumulHasData ? daily : mergeMaps(dayEntry.decks, daily),
  );
  dayEntry._cumul = mergeMaps(dayEntry._cumul ?? {}, currentCumul);
  dayEntry._cumulFame = mergeMaps(dayEntry._cumulFame ?? {}, currentCumulFame);
  dayEntry.periodType = options.periodType ?? dayEntry.periodType ?? null;

  // If we already have a primary snapshot for this war day, do not overwrite the
  // recorded decks when running after reset (backup snapshot). This ensures we
  // keep the last pre-reset state even if the workflow completes after the reset UTC.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const filtered = history.filter((w) =>
    w.days.some((d) => d.realDay && new Date(d.realDay).getTime() >= cutoff),
  );

  // Always record the time the snapshot script ran (helps debugging / ensures
  // the file is updated even if no deck changes occur).
  dayEntry.snapshotTime = now.toISOString();

  if (snapshotType === "backup") {
    dayEntry.snapshotBackupTime = now.toISOString();

    // Si on a un baseCumul valide : certains decks du backup peuvent appartenir
    // au jour précédent (joués dans les dernières secondes avant le reset).
    const prevIndex = (baseIndex + WAR_DAYS.length - 1) % WAR_DAYS.length;
    const prevDayEntry = weekEntry.days[prevIndex];
    if (baseCumulHasData && prevDayEntry) {
      for (const tag of Object.keys(rawDaily)) {
        const overflow = Math.max(0, rawDaily[tag] - 4);
        if (overflow <= 0) continue;

        // Transfer overflow to previous day (but clamp to 4)
        prevDayEntry.decks = mergeMaps(prevDayEntry.decks, {
          [tag]: Math.min(4, (prevDayEntry.decks?.[tag] ?? 0) + overflow),
        });

        // Keep max 4 for the current day (the rest is considered previous day)
        daily[tag] = Math.min(4, daily[tag]);
      }
      // Ensure `decks` does not grow beyond 50 players and remains inside 0-4 per player.
      prevDayEntry.decks = clampDeckValues(prevDayEntry.decks);
    }

    // Le snapshot backup est pris juste après le reset : currentCumulFame reflète
    // l'état exact de fin de journée GDC J-1. On l'écrit sur le jour précédent pour
    // permettre un calcul précis de la fame du jour courant.
    // ⚠️ Garde-fou : si le backup est pris plus de 90 min après le reset, p.fame a
    // déjà accumulé une partie du nouveau jour → ne pas contaminer le snapshot J-1.
    const minutesSinceReset = (msOfDayUtc - resetUtcMs) / 60000;
    if (prevDayEntry && minutesSinceReset <= 90) {
      prevDayEntry._cumulFame = mergeMaps(
        prevDayEntry._cumulFame ?? {},
        currentCumulFame,
      );
    } else if (minutesSinceReset > 90) {
      // Backup tardif : ne pas contaminer le snapshot J-1.
    }

    await saveSnapshots(clanTag, filtered);
    return;
  }

  dayEntry.decks = clampDeckValues(
    baseCumulHasData ? daily : mergeMaps(dayEntry.decks, daily),
  );

  if (snapshotType === "primary") {
    dayEntry.snapshotTime = now.toISOString();
  } else {
    dayEntry.snapshotBackupTime = now.toISOString();
  }

  dayEntry._cumul = mergeMaps(dayEntry._cumul ?? {}, currentCumul);
  dayEntry._cumulFame = mergeMaps(dayEntry._cumulFame ?? {}, currentCumulFame);
  dayEntry.periodType = options.periodType ?? dayEntry.periodType ?? null;

  // Historique intraday : un point par heure (dédoublonné sur 30 min) — primary seulement.
  dayEntry.hourlyCumul = dayEntry.hourlyCumul ?? [];
  const lastEntry = dayEntry.hourlyCumul[dayEntry.hourlyCumul.length - 1];
  const DEDUP_MS = 30 * 60 * 1000;
  if (
    !lastEntry ||
    now.getTime() - new Date(lastEntry.takenAt).getTime() >= DEDUP_MS
  ) {
    const dailyTotal = Object.keys(currentCumul).reduce(
      (s, tag) =>
        s + Math.min(4, Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0))),
      0,
    );
    dayEntry.hourlyCumul.push({
      takenAt: now.toISOString(),
      total: dailyTotal,
    });
  }

  await saveSnapshots(clanTag, filtered);
}

/**
 * Return snapshot entries matching a particular week identifier (or all if
 * week is null). Returned array is sorted ascending by date.
 */
export async function getSnapshotsForWeek(clanTag, week = null) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return [];

  // Un snapshot est valide si snapshotTime tombe le même jour calendaire que realDay
  // (captures pré-reset incluses), ou bien si un snapshotCount manuel a été fourni.
  // Les snapshots non GDC sont rejetés (periodType différent de warDay).
  const isValidSnapshot = (d) => {
    if (d.periodType != null && d.periodType !== "warDay") return false;
    if (!d.gdcPeriod?.start) return false;
    const hasValidTime =
      d.snapshotTime &&
      (d.snapshotTime.slice(0, 10) === d.realDay ||
        d.snapshotTime >= d.gdcPeriod.start);
    const hasManualCount = Number.isFinite(d.snapshotCount);
    return hasValidTime || hasManualCount;
  };

  const formatDay = (weekId, d) => ({
    week: weekId,
    date: d.realDay,
    warDay: d.warDay,
    decks: isValidSnapshot(d) ? d.decks : {},
    snapshotCount: isValidSnapshot(d) ? (d.snapshotCount ?? null) : null,
    // _cumulFame n'est utile que si le snapshot est valide : un snapshot pris
    // avant le reset GDC (periodType=training) contient des données de la semaine
    // précédente qui corrompent le calcul du delta de fame du jour.
    _cumulFame: isValidSnapshot(d) ? (d._cumulFame ?? {}) : {},
    hourlyCumul: d.hourlyCumul ?? [],
    snapshotTime: isValidSnapshot(d) ? (d.snapshotTime ?? null) : null,
    snapshotBackupTime: isValidSnapshot(d)
      ? (d.snapshotBackupTime ?? null)
      : null,
  });

  if (week == null) {
    return history
      .flatMap((w) => (w.days ?? []).map((d) => formatDay(w.week, d)))
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  const weekEntry = history.find((w) => w.week === week);
  if (!weekEntry) return [];
  return (weekEntry.days ?? [])
    .map((d) => ({
      ...formatDay(weekEntry.week, d),
      gdcPeriod: d.gdcPeriod ?? null,
    }))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/**
 * Return snapshots for multiple week identifiers in a single file read.
 * Retourne un objet { [weekId]: snap[] } pour chaque weekId demandé.
 */
export async function getSnapshotsForWeeks(clanTag, weeks) {
  const history = await loadSnapshots(clanTag);
  const result = Object.fromEntries(weeks.map((w) => [w, []]));
  if (!history.length) return result;

  // Même validation que getSnapshotsForWeek.
  const isValidSnapshot = (d) => {
    if (d.periodType != null && d.periodType !== "warDay") return false;
    if (!d.gdcPeriod?.start) return false;
    const hasValidTime =
      d.snapshotTime &&
      (d.snapshotTime.slice(0, 10) === d.realDay ||
        d.snapshotTime >= d.gdcPeriod.start);
    const hasManualCount = Number.isFinite(d.snapshotCount);
    return hasValidTime || hasManualCount;
  };

  const formatDay = (weekId, d) => ({
    week: weekId,
    date: d.realDay,
    warDay: d.warDay,
    decks: isValidSnapshot(d) ? d.decks : {},
    snapshotCount: isValidSnapshot(d) ? (d.snapshotCount ?? null) : null,
    // _cumulFame n'est utile que si le snapshot est valide : un snapshot pris
    // avant le reset GDC (periodType=training) contient des données de la semaine
    // précédente qui corrompent le calcul du delta de fame du jour.
    _cumulFame: isValidSnapshot(d) ? (d._cumulFame ?? {}) : {},
    hourlyCumul: d.hourlyCumul ?? [],
    snapshotTime: isValidSnapshot(d) ? (d.snapshotTime ?? null) : null,
    snapshotBackupTime: isValidSnapshot(d)
      ? (d.snapshotBackupTime ?? null)
      : null,
    gdcPeriod: d.gdcPeriod ?? null,
  });

  for (const weekEntry of history) {
    if (!result.hasOwnProperty(weekEntry.week)) continue;
    result[weekEntry.week] = (weekEntry.days ?? [])
      .map((d) => formatDay(weekEntry.week, d))
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }
  return result;
}

export async function getSnapshots(clanTag) {
  return getSnapshotsForWeek(clanTag, null);
}

/**
 * Return true if we already recorded a snapshot for today (UTC).
 */
export async function hasSnapshotForToday(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  return history.some((w) =>
    (w.days ?? []).some(
      (d) => d.realDay === today && (d.snapshotTime || d.snapshotBackupTime),
    ),
  );
}

/**
 * Return the date string of the most recent snapshot written, or null if none exists.
 * The format is ISO (YYYY-MM-DD) which is convenient for comparison on the frontend.
 */
export async function getLastSnapshotDate(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return null;

  const allDays = history.flatMap((w) => w.days ?? []);

  // Prefer the most recent day where a snapshot was taken (primary or backup),
  // not the inferred realDay range for the entire war week.
  const dates = allDays
    .filter((d) => d.realDay && (d.snapshotTime || d.snapshotBackupTime))
    .map((d) => d.realDay)
    .filter(Boolean)
    .sort();

  if (dates.length) return dates[dates.length - 1];

  // Fallback: if no day has a timestamp (shouldn't happen), use any realDay.
  const allRealDays = allDays
    .map((d) => d.realDay)
    .filter(Boolean)
    .sort();
  return allRealDays.length ? allRealDays[allRealDays.length - 1] : null;
}

// expose the directory path so callers can inspect or do manual operations
export const SNAP_DIR_PATH = SNAP_DIR; // absolute path used internally

function warDayNameFromKey(warDayKey) {
  if (!warDayKey) return null;
  const [y, m, d] = warDayKey.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Interpret the key as a local date (Paris) and compute weekday.
  // Using UTC noon avoids DST issues and ensures day-of-week matches local date.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return names[dow] ?? null;
}

// Expose helpers for computing the war day label (used by UI summaries)
export { getWarDayInfo, getWarDayName, warDayNameFromKey };
