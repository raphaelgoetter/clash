#!/usr/bin/env node
// refreshClanCache.js — update persisted clan analysis cache (data/analysis-cache + frontend/public/clan-cache)

import dotenv from 'dotenv';
import path from 'path';
import { ALLOWED_CLANS, buildClanAnalysis } from '../backend/routes/clan.js';
import { saveCache } from '../backend/services/analysisCache.js';
import fs from 'fs/promises';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const PUBLIC_DIR = path.resolve(process.cwd(), 'frontend', 'public', 'clan-cache');

async function ensurePublicDir() {
  try { await fs.mkdir(PUBLIC_DIR, { recursive: true }); } catch (_) {}
}

async function main() {
  await ensurePublicDir();

  for (const tag of ALLOWED_CLANS) {
    const clean = tag.replace(/[^A-Za-z0-9]/g, '');
    const statusTag = `#${tag}`;
    try {
      const payload = await buildClanAnalysis(statusTag);
      await saveCache(tag, payload);
      await fs.writeFile(path.join(PUBLIC_DIR, `${clean}.json`), JSON.stringify(payload, null, 2));
      console.log(`✓ refreshed cache for ${tag}`);
    } catch (err) {
      console.error(`✗ failed cache for ${tag}:`, err.message || err);
    }
  }
}

main().catch((err) => {
  console.error('refreshClanCache failed', err);
  process.exit(1);
});
