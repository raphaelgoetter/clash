// ============================================================
// clanCache.js — cache de données clan statiques pour le frontend
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'clan-cache');

async function ensureDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (_) {}
}

function cacheFilename(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, '');
  return path.join(CACHE_DIR, `${clean}.json`);
}

function stripClanCachePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const {
    lastWarSummary,
    warSnapshotDays,
    currentWarDays,
    // these are war/day specific and must be kept in snapshots or live API only
    ...rest
  } = payload;

  if (Array.isArray(rest.members)) {
    rest.members = rest.members.map((member) => {
      if (!member || typeof member !== 'object') return member;
      const { warDays, warDecks, ...memberRest } = member;
      return memberRest;
    });
  }

  return rest;
}

export async function loadClanCache(clanTag) {
  await ensureDir();
  const file = cacheFilename(clanTag);
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return JSON.parse(txt);
  } catch (err) {
    return null;
  }
}

export async function saveClanCache(clanTag, payload) {
  await ensureDir();
  const file = cacheFilename(clanTag);
  const data = stripClanCachePayload(payload);
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch (_) {}
}
