import { fetchCurrentRace, fetchClan } from '../backend/services/clashApi.js';
import dotenv from 'dotenv';
dotenv.config();

const tag = 'LRQP20V9';

async function test() {
  try {
    const race = await fetchCurrentRace(tag);
    console.log('Current Race Clans:');
    race.clans.forEach(c => {
      console.log(`- Name: ${c.name}, Tag: "${c.tag}"`);
    });
    
    if (race.clans.length > 1) {
      const rival = race.clans.find(c => !c.tag.includes(tag));
      console.log(`\nTesting fetchClan for rival tag: "${rival.tag}"`);
      const clanData = await fetchClan(rival.tag);
      console.log(`Result: ${clanData ? 'Success' : 'Failed'} (Name: ${clanData?.name})`);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
