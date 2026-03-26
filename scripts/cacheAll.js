#!/usr/bin/env node
// Script to precompute and persist analysis for all allowed clans.
// Usage: npm run cache

import dotenv from 'dotenv';
import path from 'path';
import { ALLOWED_CLANS, buildClanAnalysis } from '../backend/routes/clan.js';
import { saveCache } from '../backend/services/analysisCache.js';
import fs from 'fs/promises';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// when running build on Vercel we want to embed results in public/
const PUBLIC_DIR = path.resolve(process.cwd(), 'frontend', 'public', 'clan-cache');
async function ensurePublicDir() {
  try { await fs.mkdir(PUBLIC_DIR, { recursive: true }); } catch {};
}

(async function main(){
  console.log('Refreshing analysis cache for clans', ALLOWED_CLANS.join(', '));
  await ensurePublicDir();
  for (const tag of ALLOWED_CLANS) {
    try {
      const payload = await buildClanAnalysis(tag);
      await saveCache(tag, payload);
      // also dump static JSON for frontend/public (will be deployed)
      const clean = tag.replace(/[^A-Za-z0-9]/g,'');
      const file = path.join(PUBLIC_DIR, `${clean}.json`);
      await fs.writeFile(file, JSON.stringify(payload, null, 2));

      console.log(`  ✓ cached ${tag}`);
    } catch (err) {
      console.error(`  ✗ failed ${tag}:`, err.message);
    }
  }
  console.log('done');
})();
