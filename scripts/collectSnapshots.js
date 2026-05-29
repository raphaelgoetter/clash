#!/usr/bin/env node
// Script to fetch race log for permitted clans and update snapshot files.

// read .env when run locally (GitHub action will supply KEY via env)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { ALLOWED_CLANS } from "../backend/routes/clan.js";
import {
  fetchCurrentRace,
  fetchRaceLog,
  fetchBattleLog,
} from "../backend/services/clashApi.js";
import { recordSnapshot } from "../backend/services/snapshot.js";
import {
  computeCurrentWeekId,
  computePrevWeekId,
} from "../backend/services/dateUtils.js";

async function buildBattleLogsByTag(participants = []) {
  const activeParticipants = participants.filter(
    (p) => (p.decksUsedToday ?? 0) > 0,
  );
  const entries = await Promise.all(
    activeParticipants.map(async (participant) => {
      try {
        return [participant.tag, await fetchBattleLog(participant.tag)];
      } catch (_) {
        return [participant.tag, null];
      }
    }),
  );
  return Object.fromEntries(entries.filter(([, log]) => Array.isArray(log)));
}

(async () => {
  const key = process.env.CLASH_API_KEY;
  if (!key) {
    console.error("CLASH_API_KEY must be set");
    process.exit(1);
  }

  const snapshotType = process.env.SNAPSHOT_TYPE || "auto";
  for (const clanTag of ALLOWED_CLANS) {
    try {
      console.log("Fetching current race for", clanTag);
      const [race, raceLog] = await Promise.all([
        fetchCurrentRace(clanTag),
        fetchRaceLog(clanTag),
      ]);
      const participants = race.clan?.participants || [];
      if (participants.length === 0) {
        console.log("No participants for", clanTag);
        continue;
      }

      // Utiliser les fonctions canoniques pour calculer le weekId.
      // 'warDay' et 'colosseum' sont des périodes GDC actives : semaine courante.
      // En période d'entraînement (lundi→mercredi), on enregistre la semaine
      // précédente (déjà terminée).
      const WAR_ACTIVE_TYPES = ["warDay", "colosseum"];
      let weekId = null;
      if (!WAR_ACTIVE_TYPES.includes(race?.periodType)) {
        weekId = computePrevWeekId(raceLog);
      } else {
        weekId = computeCurrentWeekId(race, raceLog);
      }

      const battleLogsByTag = await buildBattleLogsByTag(participants);

      await recordSnapshot(clanTag, participants, weekId, {
        snapshotType,
        periodType: race.periodType,
        battleLogsByTag,
      });
      console.log(
        `Recorded snapshot for ${clanTag} week ${weekId} (${participants.length} players) [type=${snapshotType}, periodType=${race.periodType}]`,
      );
    } catch (err) {
      console.error("Error processing", clanTag, err.message || err);
    }
  }
})();
