#!/usr/bin/env node
// Script to fetch race log for permitted clans and update snapshot files.

// read .env when run locally (GitHub action will supply KEY via env)
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import { ALLOWED_CLANS } from '../backend/routes/clan.js';
import { fetchRaceLog } from '../backend/services/clashApi.js';
import { recordSnapshot } from '../backend/services/snapshot.js';

(async() => {
  const key = process.env.CLASH_API_KEY;
  if (!key) {
    console.error('CLASH_API_KEY must be set');
    process.exit(1);
  }

  for (const clanTag of ALLOWED_CLANS) {
    try {
      console.log('Fetching race log for', clanTag);
      const races = await fetchRaceLog(clanTag);
      if (Array.isArray(races) && races.length > 0) {
        const standing = races[0].standings.find((s) => s.clan?.tag === clanTag);
        const participants = standing?.clan?.participants || [];
        await recordSnapshot(clanTag, participants);
        console.log(`Recorded snapshot for ${clanTag} (${participants.length} players)`);
      } else {
        console.log('No race log entries for', clanTag);
      }
    } catch (err) {
      console.error('Error processing', clanTag, err.message || err);
    }
  }
})();
