import assert from 'assert';
import fs from 'fs/promises';
import { analyzePlayer, buildDailyActivity, computeIsNewPlayer, computeWarScore, computeWarReliabilityFallback, warDayKey, warResetOffsetMs } from './analysisService.js';

console.log('Running analysisService computeIsNewPlayer + war-score tests...');

const testCases = [
  {
    name: 'full history not new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 16 }], streakInCurrentClan: 3, totalWeeks: 3 }, warScore: { isFallback: false } },
    expected: false,
  },
  {
    name: 'current week only should be new',
    input: { warHistory: { weeks: [{ isCurrent: true, decksUsed: 8 }], streakInCurrentClan: 1, totalWeeks: 1 }, warScore: { isFallback: false } },
    expected: true,
  },
  {
    name: 'fallback warScore should be new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 10 }], streakInCurrentClan: 1, totalWeeks: 2 }, warScore: { isFallback: true } },
    expected: true,
  },
  {
    name: 'new clan arrival by streak/total weeks should be new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 12 }], streakInCurrentClan: 1, totalWeeks: 2 }, warScore: { isFallback: false } },
    expected: true,
  },
  {
    name: 'stable history not new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 16 }, { isCurrent: false, decksUsed: 16 }], streakInCurrentClan: 3, totalWeeks: 3 }, warScore: { isFallback: false } },
    expected: false,
  },
];

for (const tc of testCases) {
  const result = computeIsNewPlayer(tc.input.warHistory, tc.input.warScore);
  assert.strictEqual(result, tc.expected, `${tc.name} failed: got ${result}, expected ${tc.expected}`);
  console.log(`✓ ${tc.name}`);
}

const t1 = new Date('2026-03-29T09:07:00.000Z'); // 11:07 Paris CEST
assert.strictEqual(warResetOffsetMs(), 34800000, 'warResetOffsetMs should be exactly 9:40 UTC');
assert.strictEqual(warDayKey(t1), '2026-03-28', 'warDayKey should stay on saturday before 9:40 UTC reset');

const t2 = new Date('2026-03-29T09:50:00.000Z'); // 11:50 Paris CEST
assert.strictEqual(warDayKey(t2), '2026-03-29', 'warDayKey should be sunday after 9:40 UTC reset');

// new Avg Score behavior (linear 1000→3000 fame) for all players
const scoreCases = [
  { avgFame: 0, expected: 0 },
  { avgFame: 999, expected: 0 },
  { avgFame: 1000, expected: 0 },
  { avgFame: 1500, expected: 2.5 },
  { avgFame: 3000, expected: 10 },
  { avgFame: 4000, expected: 10 },
];
for (const tc of scoreCases) {
  const warScore = computeWarScore(
    { trophies: 5000, totalDonations: 1000, badges: [] },
    { avgFame: tc.avgFame, streakInCurrentClan: 0, weeks: [], totalWeeks: 0 },
    null,
    null,
    false
  );
  const avgEntry = warScore.breakdown.find((entry) => entry.label === 'Avg Score');
  assert.ok(avgEntry, `Avg Score entry exists for avgFame ${tc.avgFame}`);
  assert.strictEqual(avgEntry.score, tc.expected, `avgFame ${tc.avgFame} should give ${tc.expected}, got ${avgEntry.score}`);
}
console.log('✓ computeWarScore Avg Score thresholds test passed.');

const fallback = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  { streakInCurrentClan: 1, isFamilyTransfer: true, transferFromClan: '#TEST', transferWeek: { label: 'S123W4' } }
);
assert.ok(typeof fallback.summary === 'string' && fallback.summary.length > 0, 'fallback summary should be present');
assert.ok(typeof fallback.breakdown[0].explanation === 'string' && fallback.breakdown[0].explanation.length > 0, 'war activity explanation should be present');
console.log('✓ fallback warScore summary/explanation test passed.');

// New test: dailyActivity should count all battles, not only war battles
const gameNow = new Date().toISOString();
const sampleBattleLog = [
  { battleTime: gameNow, type: 'pvp' },
  { battleTime: gameNow, type: 'pathoflegend' },
  { battleTime: gameNow, type: 'riverracepvp' },
  { battleTime: gameNow, type: 'challenge' },
];
const result = analyzePlayer({ name: 'test', tag: '#TEST', clan: null, trophies: 0, bestTrophies: 0, expLevel: 1, totalDonations: 0, donations: 0, badges: [] }, sampleBattleLog);
assert.strictEqual(result.activityIndicators.totalBattles, 4, 'totalBattles should include all fights');
assert.strictEqual(result.activityIndicators.totalWarBattles, 1, 'totalWarBattles should include only war fights');
const sumActivity = result.recentActivity.dailyActivity.reduce((sum, d) => sum + d.count, 0);
assert.strictEqual(sumActivity, 4, 'dailyActivity should count all battles');
console.log('✓ analyzePlayer dailyActivity all-battles test passed.');

// New cache regression test: ensure legacy backend/data/analysis-cache folder is not used.
(async function() {
  try {
    await fs.access(new URL('../data/analysis-cache', import.meta.url), fs.constants.F_OK);
    throw new Error('Legacy backend/data/analysis-cache directory should not exist');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('✓ legacy backend/data/analysis-cache directory not found as expected');
    } else {
      throw err;
    }
  }
})();

console.log('All computeIsNewPlayer tests passed.');
