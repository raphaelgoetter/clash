import { fetchRaceLog } from '../backend/services/clashApi.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const tag = '#Y8JUPC9C';
  try {
    const log = await fetchRaceLog(tag);
    const lastWeek = log[0];
    const standing = lastWeek.standings.find(s => s.clan.tag.toUpperCase() === tag.toUpperCase());
    console.log('Clan:', standing.clan.name);
    console.log('Participants sample:', standing.clan.participants.slice(0, 2));
    const totalDecks = standing.clan.participants.reduce((s, p) => s + (p.decksUsed || 0), 0);
    console.log('Total Decks:', totalDecks);
    console.log('Daily Average:', totalDecks / 4);
  } catch (e) {
    console.error(e);
  }
}
run();
