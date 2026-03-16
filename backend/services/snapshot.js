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

async function loadSnapshots(clanTag) {
  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return JSON.parse(txt);
  } catch (err) {
    return [];
  }
}

async function saveSnapshots(clanTag, arr) {
  await ensureDirectory();
  const file = snapshotFilename(clanTag);
  await fs.writeFile(file, JSON.stringify(arr, null, 2));
}

/**
 * Offset en ms entre UTC et heure de Paris pour une date donnée.
 */
function parisOffsetMs(date = new Date()) {
  const p = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const u = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return p - u;
}

/**
 * Retourne la clé jour (YYYY-MM-DD) correspondant au jour de guerre (reset à 10h40 Paris).
 */
function getWarDayKey(date = new Date()) {
  const warResetMs = (10 * 60 + 40) * 60 * 1000 - parisOffsetMs(date);
  return new Date(date.getTime() - warResetMs).toISOString().slice(0, 10);
}

function getWarDayName(warDayKey) {
  // warDayKey is already adjusted for the GDC reset (10:40 Paris), so the
  // day-of-week aligns with the war day.
  const dow = new Date(warDayKey).getUTCDay(); // 0=Sun, 1=Mon, ..., 4=Thu
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return names[dow] ?? null;
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
export async function recordSnapshot(clanTag, participantData, week = null) {
  if (!participantData || participantData.length === 0) return;
  const today = getWarDayKey();

  // Cumul hebdomadaire actuel depuis l'API currentriverrace
  const currentCumul = {};
  participantData.forEach((p) => {
    currentCumul[p.tag] = p.decksUsed || 0;
  });

  const history = await loadSnapshots(clanTag);

  // Entrée existante pour aujourd'hui (même semaine) — peut être null si premier appel du jour
  const existingToday = history.find((h) => h.week === week && h.date === today) ?? null;

  // Baseline stable du jour :
  //  - Si une entrée existe déjà aujourd'hui → on conserve son _baseCumul (figé au 1er appel)
  //  - Sinon → cumul du dernier snapshot de la même semaine (jour précédent)
  const prevDayEntry = history
    .filter((h) => h.week === week && h.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop() ?? null;
  const baseCumul = existingToday?._baseCumul ?? prevDayEntry?._cumul ?? {};

  // Combats du jour = cumul actuel − baseline du début de journée, plafonné à 4
  const daily = {};
  for (const tag of Object.keys(currentCumul)) {
    daily[tag] = Math.min(4, Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0)));
  }

  // When called multiple times in the same day, keep the most up-to-date values.
  // RoyaleAPI can lag; we merge by taking the maximum seen per player.
  const mergeMaps = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = Math.max(out[k] ?? 0, v);
    }
    return out;
  };

  const entry = {
    date: today,
    warDay: getWarDayName(today),
    decks: daily,
    _cumul: currentCumul,
    _baseCumul: baseCumul,
    _generatedAt: new Date().toISOString(),
    _snapshotTakenAt: new Date().toISOString(),
  };
  if (week) entry.week = week;

  const todayIdx = history.findIndex((h) => h.week === week && h.date === today);
  if (todayIdx !== -1) {
    const existing = history[todayIdx];
    history[todayIdx] = {
      ...existing,
      warDay: entry.warDay,
      decks: mergeMaps(existing.decks, entry.decks),
      _cumul: mergeMaps(existing._cumul, entry._cumul),
      _baseCumul: mergeMaps(existing._baseCumul, entry._baseCumul),
      _generatedAt: new Date().toISOString(),
    };
  } else {
    history.push(entry);
  }

  // purge old (>RETENTION_DAYS)
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const filtered = history.filter((h) => new Date(h.date).getTime() >= cutoff);
  await saveSnapshots(clanTag, filtered);
}

/**
 * Return snapshot entries matching a particular week identifier (or all if
 * week is null). Returned array is sorted ascending by date.
 */
export async function getSnapshotsForWeek(clanTag, week = null) {
  const history = await loadSnapshots(clanTag);
  if (week == null) return history;
  return history
    .filter((h) => h.week === week)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Return saved snapshot history for a clan, oldest first.
 */
export async function getSnapshots(clanTag) {
  const history = await loadSnapshots(clanTag);
  return history;
}

/**
 * Return true if we already recorded a snapshot for today (UTC).
 */
export async function hasSnapshotForToday(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  return history[history.length - 1].date === today;
}

/**
 * Return the date string of the most recent snapshot, or null if none exists.
 * The format is ISO (YYYY-MM-DD) which is convenient for comparison on the
 * frontend.
 */
export async function getLastSnapshotDate(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return null;
  return history[history.length - 1].date;
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
export { getWarDayKey, getWarDayName, warDayNameFromKey };