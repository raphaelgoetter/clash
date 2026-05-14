import { fetchCurrentRace } from '../backend/services/clashApi.js';

async function main() {
  try {
    const result = await fetchCurrentRace('YPUJGCPP');
    console.log('isWarPeriod:', result.isWarPeriod);
    console.log('currentRace state/periodIndex/periodType:', result.currentRace?.state, result.currentRace?.periodIndex, result.currentRace?.periodType);
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
