// Script pour comparer fame standings vs somme participants
import 'dotenv/config';
import { fetchRaceLog } from '../backend/services/clashApi.js';

const CLAN_TAG = '#Y8JUPC9C'; // Les Resistants

const log = await fetchRaceLog(CLAN_TAG);

for (let i = 0; i < Math.min(4, log.length); i++) {
  const entry = log[i];
  console.log(`\n=== raceLog[${i}] — S${entry.seasonId}W${entry.sectionIndex + 1} (${entry.createdDate}) ===`);
  
  for (const s of (entry.standings ?? [])) {
    const c = s.clan ?? {};
    const participants = c.participants ?? [];
    const sumFame = participants.reduce((sum, p) => sum + (p.fame ?? 0), 0);
    const sumRepairPoints = participants.reduce((sum, p) => sum + (p.repairPoints ?? 0), 0);
    const finishedRace = c.finishTime && !c.finishTime.startsWith('1969');
    
    console.log(`  rank=${s.rank} | ${c.name}`);
    console.log(`    standings.fame = ${c.fame}`);
    console.log(`    sum(participants.fame) = ${sumFame}`);
    console.log(`    sum(participants.repairPoints) = ${sumRepairPoints}`);
    console.log(`    fame + repairPoints = ${sumFame + sumRepairPoints}`);
    console.log(`    finishedRace = ${finishedRace} | participants = ${participants.length}`);
    
    // Vérifier les champs disponibles sur un participant
    if (i === 1 && s.rank === 1 && participants.length > 0) {
      console.log('    sample participant keys:', Object.keys(participants[0]));
      console.log('    sample participant:', JSON.stringify(participants[0]));
    }
  }
}
