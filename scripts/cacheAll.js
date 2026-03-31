#!/usr/bin/env node
// Script to precompute and persist analysis for all allowed clans.
// Save analysis to frontend/public/clan-cache (single authoritative clan cache).
// Usage: npm run cache

import dotenv from 'dotenv';
import path from 'path';
import { ALLOWED_CLANS, buildClanAnalysis } from '../backend/routes/clan.js';
import { saveClanCache } from '../backend/services/clanCache.js';
import fs from 'fs/promises';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function ensurePublicDir() {
  try { await fs.mkdir(path.resolve(process.cwd(), 'frontend', 'public', 'clan-cache'), { recursive: true }); } catch {};
}

(async function main(){
  console.log('Refreshing analysis cache for clans', ALLOWED_CLANS.join(', '));
  await ensurePublicDir();
  for (const tag of ALLOWED_CLANS) {
    try {
      const payload = await buildClanAnalysis(tag);
      await saveClanCache(tag, payload);

      console.log(`  ✓ cached ${tag}`);
    } catch (err) {
      console.error(`  ✗ failed ${tag}:`, err.message);
    }
  }
  console.log('done');
})();
