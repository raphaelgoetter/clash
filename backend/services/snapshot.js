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
 * Record today's decksUsed values for the given clan.
 * @param {string} clanTag
 * @param {{tag:string,decksUsed:number}[]} participantData
 *        array of objects (e.g. from raceLog.standings[0].clan.participants)
 */
export async function recordSnapshot(clanTag, participantData, week = null) {
  if (!participantData || participantData.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const map = {};
  participantData.forEach((p) => {
    map[p.tag] = p.decksUsed || 0;
  });

  const history = await loadSnapshots(clanTag);
  // if last entry has same date, replace it
  if (history.length && history[history.length - 1].date === today) {
    history[history.length - 1].decks = map;
    if (week) history[history.length - 1].week = week;
  } else {
    const entry = { date: today, decks: map };
    if (week) entry.week = week;
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
  return history.filter((h) => h.week === week);
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
