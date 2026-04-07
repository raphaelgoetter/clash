#!/usr/bin/env node
// refreshClanCache.js — update persisted clan analysis cache (frontend/public/clan-cache)

import dotenv from 'dotenv';
import path from 'path';
import { ALLOWED_CLANS, buildClanAnalysis } from '../backend/routes/clan.js';
import { saveClanCache } from '../backend/services/clanCache.js';
import fs from 'fs/promises';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function ensurePublicDir() {
  try { await fs.mkdir(path.resolve(process.cwd(), 'frontend', 'public', 'clan-cache'), { recursive: true }); } catch (_) {}
}

async function main() {
  await ensurePublicDir();

  for (const tag of ALLOWED_CLANS) {
    const clean = tag.replace(/[^A-Za-z0-9]/g, '');
    const statusTag = `#${tag}`;
    try {
      const payload = await buildClanAnalysis(statusTag, { forceRefresh: true });
      await saveClanCache(tag, payload);
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
