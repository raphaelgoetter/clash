#!/usr/bin/env node
// Force Sunday snapshot values using player's battle log (war battles).

import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import { fetchBattleLog } from '../backend/services/clashApi.js';
import { warResetOffsetMs } from '../backend/services/analysisService.js';
import { readFile, writeFile } from 'fs/promises';

function warDayKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const key = new Date(d.getTime() - warResetOffsetMs(d));
  if (Number.isNaN(key.getTime())) return null;
  return key.toISOString().slice(0, 10);
}

async function main() {
  const tag = '#UYP0YCQ9';
  const log = await fetchBattleLog(tag);
  const counts = {};
  for (const b of log) {
    if (!b.battleTime) continue;
    const key = warDayKey(b.battleTime);
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log('war day counts (last 25 battles)', counts);

  const sundayKey = '2026-03-15';
  const count = Math.min(4, counts[sundayKey] || 0);
  console.log('computed sunday decks for', tag, count);

  const path = './data/snapshots/Y8JUPC9C.json';
  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw);
  const week = data.find((w) => w.week === 'S130W2');
  if (!week) throw new Error('week S130W2 missing');
  const day = week.days.find((d) => d.realDay === sundayKey);
  if (!day) throw new Error('sunday day missing');

  day.decks = day.decks || {};
  day.decks[tag] = count;
  day.snapshotTime = new Date().toISOString();

  await writeFile(path, JSON.stringify(data, null, 2));
  console.log('updated snapshot sunday count:', day.decks[tag]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
