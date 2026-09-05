#!/usr/bin/env node
// refreshClanCache.js — update persisted clan analysis cache (Upstash Redis)

import dotenv from "dotenv";
import path from "path";
import { ALLOWED_CLANS, buildClanAnalysis } from "../backend/routes/clan.js";
import { saveClanCache } from "../backend/services/clanCache.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main() {
  for (const tag of ALLOWED_CLANS) {
    const statusTag = `#${tag}`;
    try {
      const payload = await buildClanAnalysis(statusTag, {
        forceRefresh: true,
        includeRaceGroup: true,
      });
      await saveClanCache(tag, payload);
      console.log(`✓ refreshed cache for ${tag}`);
    } catch (err) {
      console.error(`✗ failed cache for ${tag}:`, err.message || err);
    }
  }
}

main().catch((err) => {
  console.error("refreshClanCache failed", err);
  process.exit(1);
});
