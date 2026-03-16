#!/usr/bin/env node
// Rewrite existing snapshot files into the new structured week/day format.
// This ensures each week has exactly 4 days (thu–sun) with a realDay, and the
// snapshot times are stored as requested.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSnapshotsForWeek } from '../backend/services/snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = path.resolve(__dirname, '..', 'data', 'snapshots');

function groupByWeek(flatDays) {
  const map = new Map();
  for (const day of flatDays) {
    const week = day.week ?? 'unknown';
    if (!map.has(week)) map.set(week, []);
    map.get(week).push(day);
  }
  return map;
}

async function fixFile(filePath, clanTag) {
  // Load the existing snapshots via the service helper (normalises legacy format)
  const flat = await getSnapshotsForWeek(clanTag, null);
  const weeks = groupByWeek(flat);

  const output = Array.from(weeks.entries()).map(([week, days]) => {
    const sorted = days
      .slice()
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return {
      week,
      days: sorted.map((d) => ({
        warDay: d.warDay,
        realDay: d.date ?? null,
        snapshotTime: d.snapshotTime ?? null,
        snapshotBackupTime: d.snapshotBackupTime ?? null,
        decks: d.decks ?? {},
      })),
    };
  });

  await fs.writeFile(filePath, JSON.stringify(output, null, 2));
  console.log('Fixed', path.basename(filePath), '→', output.length, 'weeks');
}

(async () => {
  const files = await fs.readdir(SNAP_DIR);
  const snaps = files.filter((f) => f.endsWith('.json'));
  for (const f of snaps) {
    // Derive clan tag from filename (strip .json)
    const clanTag = `#${path.basename(f, '.json')}`;
    await fixFile(path.join(SNAP_DIR, f), clanTag);
  }
})();
