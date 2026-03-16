// ============================================================
// snapshot.js — helper for recording daily decksUsed snapshots from a
// river race log. File-based storage under data/snapshots.
// ============================================================

import fs from 'fs/promises';
import path from 'path';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = path.resolve(__dirname, '..', '..', 'data', 'snapshots');
const RETENTION_DAYS = 60;

async function ensureDirectory() {
  try {
    await fs.mkdir(SNAP_DIR, { recursive: true });
  } catch (_) {}
}

function snapshotFilename(clanTag) {
  // sanitize tag (# replaced by empty)
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, '');
  return path.join(SNAP_DIR, `${clean}.json`);
}

function convertLegacySnapshots(raw) {
  // Legacy format: array of { week, date, warDay, decks, _cumul, ... }
  // Convert to new format: [{ week, days: [{ warDay, realDay, snapshots:[...], decks: {...} }] }]
  const byWeek = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const week = entry.week ?? 'unknown';
    const dayKey = entry.date;
    const warDay = entry.warDay ?? getWarDayName(dayKey);
    const takenAt = entry._snapshotTakenAt ?? entry._generatedAt ?? `${dayKey}T12:00:00Z`;
    const weekObj = byWeek.get(week) ?? { week, days: [] };
    weekObj.days.push({
      warDay,
      realDay: dayKey,
      snapshots: [{ type: 'legacy', takenAt, decks: entry.decks ?? {} }],
      decks: { ...(entry.decks ?? {}) },
    });
    byWeek.set(week, weekObj);
  }
  return Array.from(byWeek.values()).map((w) => {
    const week = {
      week: w.week,
      days: w.days,
    };
    return fillWeekDays(week);
  });
}

function normalizeSnapshots(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];

  // Already new format (weeks with days array)
  if (raw[0].week && Array.isArray(raw[0].days)) {
    return raw;
  }

  // Legacy format (flat list) -> convert
  return convertLegacySnapshots(raw);
}

async function loadSnapshots(clanTag) {
  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  try {
    const txt = await fs.readFile(file, 'utf-8');
    const raw = JSON.parse(txt);
    return normalizeSnapshots(raw);
  } catch (err) {
    return [];
  }
}

async function saveSnapshots(clanTag, weeks) {
  // Strip internal-only fields (_cumul) before writing to disk.
  const sanitized = (weeks || []).map((w) => ({
    ...w,
    days: (w.days || []).map((d) => {
      const { _cumul, ...rest } = d;
      return rest;
    }),
  }));

  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  await fs.writeFile(file, JSON.stringify(sanitized, null, 2));
}

/**
 * Return a (Paris-local) date string YYYY-MM-DD for a given Date.
 */
function parisDateKey(date = new Date()) {
  const p = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const y = p.getFullYear();
  const m = String(p.getMonth() + 1).padStart(2, '0');
  const d = String(p.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * For a given timestamp, return the war day (thu/fri/sat/sun) and the corresponding
 * local calendar date (Paris) for that war day.
 *
 * A war day runs from 10:40 Paris until the next day 10:40 Paris.
 */
function getWarDayInfo(date = new Date()) {
  const paris = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const resetMs = (10 * 60 + 40) * 60 * 1000;
  const msOfDay = paris.getHours() * 3600000 + paris.getMinutes() * 60000 + paris.getSeconds() * 1000 + paris.getMilliseconds();

  // Before reset (10:40 Paris), we are still in the current war day.
  // After reset, the war day increments.
  if (msOfDay >= resetMs) {
    paris.setDate(paris.getDate() + 1);
  }

  const dow = paris.getDay(); // 0=Sun..6=Sat
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const warDay = names[dow];
  const warDays = ['thursday', 'friday', 'saturday', 'sunday'];
  if (!warDays.includes(warDay)) return null;

  return {
    warDay,
    realDay: parisDateKey(paris),
  };
}

function getWarDayName(warDayKey) {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const d = new Date(`${warDayKey}T12:00:00Z`);
  return names[d.getUTCDay()] ?? null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const WAR_DAYS = ['thursday', 'friday', 'saturday', 'sunday'];

function mergeMaps(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v ?? 0);
  }
  return out;
}

function makeEmptyDay(warDay, realDay = null) {
  return {
    warDay,
    realDay,
    snapshotTime: null,
    snapshotBackupTime: null,
    decks: {},
  };
}

function fillWeekDays(week) {
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

    const day = existing ? { ...existing } : makeEmptyDay(wd, realDay);
    day.warDay = wd;
    day.realDay = realDay;

    // Ensure mandatory fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day._cumul = day._cumul ?? {};

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
export async function recordSnapshot(clanTag, participantData, week = null, options = {}) {
  if (!participantData || participantData.length === 0) return;

  const now = options.now ? new Date(options.now) : new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));

  const resetMs = (10 * 60 + 40) * 60 * 1000;
  const msOfDay =
    paris.getHours() * 3600000 +
    paris.getMinutes() * 60000 +
    paris.getSeconds() * 1000 +
    paris.getMilliseconds();
  // Before reset → primary snapshot (captures the final decks of the day)
  // After reset  → backup snapshot (should be empty/zeroed)
  const snapshotType = msOfDay < resetMs ? 'primary' : 'backup';

  const warInfo = getWarDayInfo(now);
  if (!warInfo) return; // outside of war period (mon-wed after reset)

  const { warDay, realDay } = warInfo;

  // weekly cumulative totals from currentriverrace
  const currentCumul = {};
  participantData.forEach((p) => {
    currentCumul[p.tag] = p.decksUsed || 0;
  });

  const history = await loadSnapshots(clanTag);

  const weekId = week ?? 'unknown';
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
    const day = existingDay
      ? { ...existingDay }
      : makeEmptyDay(wd, null);

    // Infer the real calendar date for each war day based on the current war day.
    if (baseIndex !== -1) {
      day.realDay = new Date(baseDate.getTime() + (idx - baseIndex) * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
    }

    // Ensure required fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day._cumul = day._cumul ?? {};

    return day;
  });

  const dayEntry = weekEntry.days[baseIndex];
  if (!dayEntry) return; // should not happen

  // Ensure the real day matches the computed one (Paris date of the war day)
  dayEntry.realDay = realDay;

  // Determine decks for this snapshot (delta since yesterday)
  const prevDay = weekEntry.days[WAR_DAYS.indexOf(warDay) - 1];
  const baseCumul = prevDay?._cumul ?? {};

  const daily = {};
  for (const tag of Object.keys(currentCumul)) {
    daily[tag] = Math.min(4, Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0)));
  }

  dayEntry.decks = mergeMaps(dayEntry.decks, daily);

  if (snapshotType === 'primary') {
    dayEntry.snapshotTime = now.toISOString();
  } else {
    dayEntry.snapshotBackupTime = now.toISOString();
  }

  dayEntry._cumul = mergeMaps(dayEntry._cumul ?? {}, currentCumul);


  // purge old (>RETENTION_DAYS)
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const filtered = history.filter((w) =>
    w.days.some((d) => d.realDay && new Date(d.realDay).getTime() >= cutoff)
  );

  await saveSnapshots(clanTag, filtered);
}

/**
 * Return snapshot entries matching a particular week identifier (or all if
 * week is null). Returned array is sorted ascending by date.
 */
export async function getSnapshotsForWeek(clanTag, week = null) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return [];

  const formatDay = (weekId, d) => ({
    week: weekId,
    date: d.realDay,
    warDay: d.warDay,
    decks: d.decks,
    snapshotTime: d.snapshotTime ?? null,
    snapshotBackupTime: d.snapshotBackupTime ?? null,
  });

  if (week == null) {
    return history
      .flatMap((w) => (w.days ?? []).map((d) => formatDay(w.week, d)))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }

  const weekEntry = history.find((w) => w.week === week);
  if (!weekEntry) return [];
  return (weekEntry.days ?? [])
    .map((d) => formatDay(weekEntry.week, d))
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
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
  return history.some((w) => (w.days ?? []).some((d) => d.realDay === today));
}

/**
 * Return the date string of the most recent snapshot, or null if none exists.
 * The format is ISO (YYYY-MM-DD) which is convenient for comparison on the
 * frontend.
 */
export async function getLastSnapshotDate(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return null;
  const allDays = history.flatMap((w) => w.days ?? []);
  const dates = allDays
    .map((d) => d.realDay)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// expose the directory path so callers can inspect or do manual operations
export const SNAP_DIR_PATH = SNAP_DIR; // absolute path used internally

function warDayNameFromKey(warDayKey) {
  if (!warDayKey) return null;
  const [y, m, d] = warDayKey.split('-').map(Number);
  if (!y || !m || !d) return null;
  // Interpret the key as a local date (Paris) and compute weekday.
  // Using UTC noon avoids DST issues and ensures day-of-week matches local date.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return names[dow] ?? null;
}

// Expose helpers for computing the war day label (used by UI summaries)
export { getWarDayInfo, getWarDayName, warDayNameFromKey };