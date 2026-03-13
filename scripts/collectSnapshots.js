#!/usr/bin/env node
// Script to fetch race log for permitted clans and update snapshot files.

// read .env when run locally (GitHub action will supply KEY via env)
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import { ALLOWED_CLANS } from '../backend/routes/clan.js';
import { fetchCurrentRace, fetchRaceLog } from '../backend/services/clashApi.js';
import { recordSnapshot } from '../backend/services/snapshot.js';

(async() => {
  const key = process.env.CLASH_API_KEY;
  if (!key) {
    console.error('CLASH_API_KEY must be set');
    process.exit(1);
  }

  for (const clanTag of ALLOWED_CLANS) {
    try {
      console.log('Fetching current race for', clanTag);
      const [race, raceLog] = await Promise.all([fetchCurrentRace(clanTag), fetchRaceLog(clanTag)]);
      if (race?.periodType !== 'warDay') {
        console.log(`Skipping snapshot for ${clanTag} (periodType: ${race?.periodType ?? 'unknown'})`);
        continue;
      }
      const participants = race.clan?.participants || [];
      if (participants.length > 0) {
        // seasonId absent de currentriverrace → dérivé depuis le race log
        const currSection = race.sectionIndex ?? 0;
        let seasonId = raceLog?.[0]?.seasonId;
        if (seasonId !== undefined && currSection <= (raceLog[0]?.sectionIndex ?? -1)) seasonId += 1;
        const weekId = seasonId != null ? `S${seasonId}W${currSection + 1}` : `W${currSection + 1}`;
        await recordSnapshot(clanTag, participants, weekId);
        console.log(`Recorded snapshot for ${clanTag} week ${weekId} (${participants.length} players)`);
      } else {
        console.log('No participants for', clanTag);
      }
    } catch (err) {
      console.error('Error processing', clanTag, err.message || err);
    }
  }
})();
