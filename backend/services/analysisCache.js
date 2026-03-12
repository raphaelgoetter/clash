// ============================================================
// analysisCache.js — persistent cache for clan analysis payloads
// stored under data/analysis-cache/<tag>.json so they survive cold starts
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'analysis-cache');

async function ensureDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (_) {}
}

function cacheFilename(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, '');
  return path.join(CACHE_DIR, `${clean}.json`);
}

export async function loadCache(clanTag) {
  await ensureDir();
  const file = cacheFilename(clanTag);
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return JSON.parse(txt);
  } catch (err) {
    return null;
  }
}

export async function saveCache(clanTag, data) {
  await ensureDir();
  const file = cacheFilename(clanTag);
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch (_) {}
}


