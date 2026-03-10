// ============================================================
// snapshot.js — helper for recording daily decksUsed snapshots from a
// river race log. File-based storage under data/snapshots.
// ============================================================

import fs from 'fs/promises';
import path from 'path';

const SNAP_DIR = path.resolve(new URL('../../data/snapshots', import.meta.url));
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
export async function recordSnapshot(clanTag, participantData) {
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
  } else {
    history.push({ date: today, decks: map });
  }

  // purge old (>RETENTION_DAYS)
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const filtered = history.filter((h) => new Date(h.date).getTime() >= cutoff);
  await saveSnapshots(clanTag, filtered);
}

/**
 * Return saved snapshot history for a clan, oldest first.
 */
export async function getSnapshots(clanTag) {
  const history = await loadSnapshots(clanTag);
  return history;
}
