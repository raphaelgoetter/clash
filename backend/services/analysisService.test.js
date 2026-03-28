import assert from 'assert';
import { computeIsNewPlayer, computeWarReliabilityFallback } from './analysisService.js';

console.log('Running analysisService computeIsNewPlayer tests...');

const testCases = [
  {
    name: 'family transfer should not be new',
    input: { warHistory: { weeks: [], streakInCurrentClan: 0, totalWeeks: 0 }, warScore: null, isFamilyTransfer: true },
    expected: false,
  },
  {
    name: 'full history not new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 16 }], streakInCurrentClan: 3, totalWeeks: 3 }, warScore: { isFallback: false }, isFamilyTransfer: false },
    expected: false,
  },
  {
    name: 'current week only should be new',
    input: { warHistory: { weeks: [{ isCurrent: true, decksUsed: 8 }], streakInCurrentClan: 1, totalWeeks: 1 }, warScore: { isFallback: false }, isFamilyTransfer: false },
    expected: true,
  },
  {
    name: 'fallback warScore should be new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 10 }], streakInCurrentClan: 1, totalWeeks: 2 }, warScore: { isFallback: true }, isFamilyTransfer: false },
    expected: true,
  },
  {
    name: 'new clan arrival by streak/total weeks should be new',
    input: { warHistory: { weeks: [{ isCurrent: false, decksUsed: 12 }], streakInCurrentClan: 1, totalWeeks: 2 }, warScore: { isFallback: false }, isFamilyTransfer: false },
    expected: true,
  },
];

for (const tc of testCases) {
  const result = computeIsNewPlayer(tc.input.warHistory, tc.input.warScore, tc.input.isFamilyTransfer);
  assert.strictEqual(result, tc.expected, `${tc.name} failed: got ${result}, expected ${tc.expected}`);
  console.log(`✓ ${tc.name}`);
}

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

console.log('All computeIsNewPlayer tests passed.');
