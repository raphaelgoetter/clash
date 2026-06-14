import assert from "assert";
import fs from "fs/promises";
import {
  analyzePlayer,
  buildDailyActivity,
  computeIsNewPlayer,
  computeWarScore,
  computeWarReliabilityFallback,
  filterWarBattles,
  hasDuelOnWarDay,
  expandDuelRounds,
  summarizeWarDecks,
  summarizeWarDecksForTension,
  warDayKey,
  warResetOffsetMs,
} from "./analysisService.js";
import { summarizeDecks } from "./battleLogUtils.js";

console.log("Running analysisService computeIsNewPlayer + war-score tests...");

const testCases = [
  {
    name: "full history not new",
    input: {
      warHistory: {
        weeks: [{ isCurrent: false, decksUsed: 16 }],
        streakInCurrentClan: 3,
        totalWeeks: 3,
      },
      warScore: { isFallback: false },
    },
    expected: false,
  },
  {
    name: "current week only should be new",
    input: {
      warHistory: {
        weeks: [{ isCurrent: true, decksUsed: 8 }],
        streakInCurrentClan: 1,
        totalWeeks: 1,
      },
      warScore: { isFallback: false },
    },
    expected: true,
  },
  {
    name: "fallback warScore should be new",
    input: {
      warHistory: {
        weeks: [{ isCurrent: false, decksUsed: 10 }],
        streakInCurrentClan: 1,
        totalWeeks: 2,
      },
      warScore: { isFallback: true },
    },
    expected: true,
  },
  {
    name: "new clan arrival by streak/total weeks should be new",
    input: {
      warHistory: {
        weeks: [{ isCurrent: false, decksUsed: 12 }],
        streakInCurrentClan: 1,
        totalWeeks: 2,
      },
      warScore: { isFallback: false },
    },
    expected: true,
  },
  {
    name: "stable history not new",
    input: {
      warHistory: {
        weeks: [
          { isCurrent: false, decksUsed: 16 },
          { isCurrent: false, decksUsed: 16 },
        ],
        streakInCurrentClan: 3,
        totalWeeks: 3,
      },
      warScore: { isFallback: false },
    },
    expected: false,
  },
  {
    name: "stable history with fallback should not be new",
    input: {
      warHistory: {
        weeks: [
          { isCurrent: false, decksUsed: 16 },
          { isCurrent: false, decksUsed: 16 },
        ],
        streakInCurrentClan: 3,
        totalWeeks: 3,
      },
      warScore: { isFallback: true },
    },
    expected: false,
  },
  {
    name: "family transfer not new",
    input: {
      warHistory: {
        weeks: [
          { isCurrent: false, decksUsed: 8 },
          { isCurrent: false, decksUsed: 8 },
        ],
        streakInCurrentClan: 1,
        streakInFamily: 3,
        totalWeeks: 3,
      },
      warScore: { isFallback: false },
    },
    expected: false,
  },
];

for (const tc of testCases) {
  const result = computeIsNewPlayer(tc.input.warHistory, tc.input.warScore);
  assert.strictEqual(
    result,
    tc.expected,
    `${tc.name} failed: got ${result}, expected ${tc.expected}`,
  );
  console.log(`✓ ${tc.name}`);
}

const t1 = new Date("2026-03-29T09:07:00.000Z"); // 11:07 Paris CEST
assert.strictEqual(
  warResetOffsetMs(),
  34800000,
  "warResetOffsetMs should be exactly 9:40 UTC",
);
assert.strictEqual(
  warDayKey(t1),
  "2026-03-28",
  "warDayKey should stay on saturday before 9:40 UTC reset",
);

const t2 = new Date("2026-03-29T09:50:00.000Z"); // 11:50 Paris CEST
assert.strictEqual(
  warDayKey(t2),
  "2026-03-29",
  "warDayKey should be sunday after 9:40 UTC reset",
);

const clanBeforeReset = new Date("2026-03-29T09:42:00.000Z"); // avant 09:44 UTC pour LRQP20V9
assert.strictEqual(
  warDayKey(clanBeforeReset, "LRQP20V9"),
  "2026-03-28",
  "warDayKey should still be saturday before clan-specific 09:44 UTC reset",
);

const clanAfterReset = new Date("2026-03-29T09:50:00.000Z"); // après 09:44 UTC pour LRQP20V9
assert.strictEqual(
  warDayKey(clanAfterReset, "LRQP20V9"),
  "2026-03-29",
  "warDayKey should switch to sunday after clan-specific 09:44 UTC reset",
);

const duelBattleLog = [
  {
    type: "riverRaceDuelColosseum",
    battleTime: "20260530T123350.000Z",
    team: [{ rounds: [{ crowns: 1 }, { crowns: 2 }] }],
    opponent: [{ rounds: [{ crowns: 0 }, { crowns: 1 }] }],
  },
  { type: "riverRacePvP", battleTime: "20260530T123845.000Z" },
];
assert.strictEqual(
  hasDuelOnWarDay(duelBattleLog, "LRQP20V9", "2026-05-30"),
  true,
  "hasDuelOnWarDay should detect riverRaceDuelColosseum entries",
);
assert.strictEqual(
  filterWarBattles(duelBattleLog).length,
  2,
  "filterWarBattles should keep duel colosseum battles",
);
assert.strictEqual(
  expandDuelRounds([duelBattleLog[0]]).length,
  2,
  "expandDuelRounds should expand duel colosseum rounds",
);

const tensionDecks = summarizeWarDecksForTension(
  [
    {
      type: "riverRacePvp",
      battleTime: "20260611T100000.000Z",
      team: [
        {
          cards: [
            { id: "1", name: "A" },
            { id: "2", name: "B" },
            { id: "3", name: "C" },
            { id: "4", name: "D" },
            { id: "5", name: "E" },
            { id: "6", name: "F" },
            { id: "7", name: "G" },
            { id: "8", name: "H" },
          ],
          crowns: 3,
        },
      ],
      opponent: [{ name: "X", crowns: 0 }],
    },
    {
      type: "riverRaceDuel",
      battleTime: "20260612T100000.000Z",
      team: [
        {
          cards: [
            { id: "11", name: "K" },
            { id: "12", name: "L" },
            { id: "13", name: "M" },
            { id: "14", name: "N" },
            { id: "15", name: "O" },
            { id: "16", name: "P" },
            { id: "17", name: "Q" },
            { id: "18", name: "R" },
          ],
          rounds: [{ crowns: 1 }, { crowns: 0 }, { crowns: 1 }],
        },
      ],
      opponent: [
        {
          name: "Aegon Targaryen",
          rounds: [{ crowns: 0 }, { crowns: 1 }, { crowns: 0 }],
        },
      ],
    },
  ],
  8,
  null,
  "LRQP20V9",
);
assert.strictEqual(
  tensionDecks.length,
  4,
  "summarizeWarDecksForTension should return one entry per duel round",
);
assert.strictEqual(
  tensionDecks[1].matches?.[0]?.score,
  "1-0",
  "The first duel round should be scored 1-0",
);
assert.strictEqual(
  tensionDecks[2].matches?.[0]?.score,
  "0-1",
  "The second duel round should be scored 0-1",
);
assert.strictEqual(
  tensionDecks[3].matches?.[0]?.score,
  "1-0",
  "The third duel round should be scored 1-0",
);

const multiDayTensionDecks = summarizeWarDecksForTension(
  [
    {
      type: "riverRacePvp",
      battleTime: "20260611T100000.000Z",
      team: [{ cards: [{ id: "1", name: "A" }], crowns: 3 }],
      opponent: [{ name: "X", crowns: 0 }],
    },
    {
      type: "riverRacePvp",
      battleTime: "20260612T100000.000Z",
      team: [{ cards: [{ id: "2", name: "B" }], crowns: 2 }],
      opponent: [{ name: "Y", crowns: 1 }],
    },
  ],
  8,
  null,
  "LRQP20V9",
);
assert.ok(
  multiDayTensionDecks.length >= 2,
  "summarizeWarDecksForTension should include multiple day entries",
);
assert.ok(
  multiDayTensionDecks.some(
    (deck) => deck.matches?.[0]?.dayKey === "2026-06-12",
  ),
  "Tension summary should contain the newest day",
);
assert.ok(
  multiDayTensionDecks.some(
    (deck) => deck.matches?.[0]?.dayKey === "2026-06-11",
  ),
  "Tension summary should contain the older day",
);

const warDeckSummary = summarizeWarDecks(
  [
    {
      type: "riverRacePvP",
      battleTime: "20260530T120000.000Z",
      team: [
        {
          cards: [
            { id: "1001", name: "Valkyrie" },
            { id: "1002", name: "Bowler" },
            { id: "1003", name: "Fireball" },
            { id: "1004", name: "Miner" },
            { id: "1005", name: "Zap" },
            { id: "1006", name: "Poison" },
            { id: "1007", name: "Musketeer" },
            { id: "1008", name: "Tesla" },
          ],
          crowns: 3,
        },
      ],
      opponent: [{ crowns: 0 }],
    },
    {
      type: "riverRacePvP",
      battleTime: "20260530T121000.000Z",
      team: [
        {
          cards: [
            { id: "1008", name: "Tesla" },
            { id: "1007", name: "Musketeer" },
            { id: "1006", name: "Poison" },
            { id: "1005", name: "Zap" },
            { id: "1004", name: "Miner" },
            { id: "1003", name: "Fireball" },
            { id: "1002", name: "Bowler" },
            { id: "1001", name: "Valkyrie" },
          ],
          crowns: 0,
        },
      ],
      opponent: [{ crowns: 1 }],
    },
    {
      type: "riverRaceDuel",
      battleTime: "20260530T122000.000Z",
      team: [
        {
          cards: [
            { id: "2001", name: "Knight" },
            { id: "2002", name: "Archers" },
            { id: "2003", name: "Goblin Gang" },
            { id: "2004", name: "Log" },
            { id: "2005", name: "Cannon" },
            { id: "2006", name: "Ice Spirit" },
            { id: "2007", name: "Skeletons" },
            { id: "2008", name: "Hog Rider" },
          ],
          rounds: [{ crowns: 1 }],
        },
      ],
      opponent: [{ rounds: [{ crowns: 0 }] }],
    },
  ],
  4,
);

assert.strictEqual(
  warDeckSummary.length,
  2,
  "summarizeWarDecks should merge identical deck signatures",
);
assert.strictEqual(
  warDeckSummary[0].plays,
  2,
  "summarizeWarDecks should count both plays of the same deck",
);
assert.strictEqual(
  warDeckSummary[0].winRate,
  50,
  "summarizeWarDecks should compute the right winrate",
);
assert.strictEqual(
  warDeckSummary[1].label,
  "Deck 2",
  "summarizeWarDecks should number the second deck",
);
assert.strictEqual(
  warDeckSummary[0].matches[0].dayKey,
  "2026-05-30",
  "summarizeWarDecks should preserve the GDC dayKey on matches",
);

const allBattleDeckSummary = summarizeDecks(
  [
    {
      type: "pvp",
      battleTime: "20260530T120000.000Z",
      team: [
        {
          cards: [
            { id: "1001", name: "Valkyrie" },
            { id: "1002", name: "Bowler" },
            { id: "1003", name: "Fireball" },
            { id: "1004", name: "Miner" },
            { id: "1005", name: "Zap" },
            { id: "1006", name: "Poison" },
            { id: "1007", name: "Musketeer" },
            { id: "1008", name: "Tesla" },
          ],
          crowns: 3,
        },
      ],
      opponent: [{ crowns: 0 }],
    },
    {
      type: "pvp",
      battleTime: "20260530T121000.000Z",
      team: [
        {
          cards: [
            { id: "1008", name: "Tesla" },
            { id: "1007", name: "Musketeer" },
            { id: "1006", name: "Poison" },
            { id: "1005", name: "Zap" },
            { id: "1004", name: "Miner" },
            { id: "1003", name: "Fireball" },
            { id: "1002", name: "Bowler" },
            { id: "1001", name: "Valkyrie" },
          ],
          crowns: 0,
        },
      ],
      opponent: [{ crowns: 1 }],
    },
  ],
  4,
);
assert.strictEqual(
  allBattleDeckSummary.length,
  1,
  "summarizeDecks should count all combat types and merge identical deck signatures",
);
assert.strictEqual(
  allBattleDeckSummary[0].plays,
  2,
  "summarizeDecks should count both plays of the same deck across all combats",
);
assert.strictEqual(
  allBattleDeckSummary[0].winRate,
  50,
  "summarizeDecks should compute winrate across all combats",
);

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
    false,
  );
  const avgEntry = warScore.breakdown.find(
    (entry) => entry.label === "Avg Score",
  );
  assert.ok(avgEntry, `Avg Score entry exists for avgFame ${tc.avgFame}`);
  assert.strictEqual(
    avgEntry.score,
    tc.expected,
    `avgFame ${tc.avgFame} should give ${tc.expected}, got ${avgEntry.score}`,
  );
}
console.log("✓ computeWarScore Avg Score thresholds test passed.");

const stabilityFamilyScore = computeWarScore(
  { trophies: 5000, totalDonations: 1000, badges: [] },
  {
    avgFame: 2000,
    streakInCurrentClan: 1,
    streakInFamily: 5,
    weeks: [],
    totalWeeks: 5,
  },
  null,
  null,
  false,
);
const stabilityEntry = stabilityFamilyScore.breakdown.find(
  (entry) => entry.label === "Stability",
);
assert.ok(stabilityEntry, "Stability entry exists for family streak test");
assert.strictEqual(
  stabilityEntry.score,
  8,
  `Family streak of 5 should cap stability at 8, got ${stabilityEntry.score}`,
);
assert.ok(
  stabilityEntry.detail.includes("in this clan or family"),
  `Expected stability detail to mention clan or family, got ${stabilityEntry.detail}`,
);
console.log("✓ computeWarScore family stability test passed.");

const fallback = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  {
    streakInCurrentClan: 1,
    isFamilyTransfer: true,
    transferFromClan: "#TEST",
    transferWeek: { label: "S123W4" },
  },
);
assert.ok(
  typeof fallback.summary === "string" && fallback.summary.length > 0,
  "fallback summary should be present",
);
const warActivityEntry = fallback.breakdown.find(
  (entry) => entry.label === "War Activity",
);
assert.ok(
  warActivityEntry &&
    typeof warActivityEntry.explanation === "string" &&
    warActivityEntry.explanation.length > 0,
  "war activity explanation should be present",
);
console.log("✓ fallback warScore summary/explanation test passed.");

// New tests: General Activity war-ratio adjustment
const fallbackNoWar = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 28, gdc: 0, ladder: 28, challenge: 0 },
  null,
  false,
  0,
  null,
);
const gaNoWar = fallbackNoWar.breakdown.find(
  (b) => b.label === "General Activity",
);
assert.ok(gaNoWar, "General Activity entry exists for no-war case");
assert.ok(
  gaNoWar.score <= 4,
  `Expected General Activity <= 4 for 0% War (got ${gaNoWar.score})`,
);

const fallbackNoWarWithLastSeen = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  "2026-04-29T12:00:00.000Z",
  false,
  0,
  null,
);
assert.strictEqual(
  fallbackNoWarWithLastSeen.maxScore,
  36,
  `Expected fallback maxScore 36 when lastSeen is present, got ${fallbackNoWarWithLastSeen.maxScore}`,
);
assert.ok(
  fallbackNoWarWithLastSeen.breakdown.some((b) => b.label === "Last Seen"),
  "Expected Last Seen entry when lastSeen data is available",
);

const fallbackAllWar = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  Array.from({ length: 30 }, () => ({
    battleTime: new Date().toISOString(),
    type: "gdc",
  })),
  { total: 30, gdc: 30, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  null,
);
const gaAllWar = fallbackAllWar.breakdown.find(
  (b) => b.label === "General Activity",
);
assert.ok(gaAllWar, "General Activity entry exists for all-war case");
assert.strictEqual(
  gaAllWar.score,
  8,
  `Expected General Activity 8 for 100% War (got ${gaAllWar.score})`,
);
assert.strictEqual(
  fallbackAllWar.maxScore,
  33,
  `Expected fallback maxScore 33 when no last seen data and Discord is not counted, got ${fallbackAllWar.maxScore}`,
);
const cw2Entry = fallbackAllWar.breakdown.find((b) => b.label === "CW2 badge");
assert.ok(cw2Entry, "CW2 badge entry exists for all-war case");
assert.strictEqual(
  cw2Entry.max,
  10,
  `CW2 badge max should be 10, got ${cw2Entry.max}`,
);
const warActivityEntryAllWar = fallbackAllWar.breakdown.find(
  (b) => b.label === "War Activity",
);
assert.ok(warActivityEntryAllWar, "War Activity entry exists for all-war case");
assert.strictEqual(
  warActivityEntryAllWar.max,
  8,
  `War Activity max should be 8, got ${warActivityEntryAllWar.max}`,
);
console.log("✓ General Activity war-ratio adjustment tests passed.");

// New test: dailyActivity should count all battles, not only war battles
const gameNow = new Date().toISOString();
const sampleBattleLog = [
  { battleTime: gameNow, type: "pvp" },
  { battleTime: gameNow, type: "pathoflegend" },
  { battleTime: gameNow, type: "riverracepvp" },
  { battleTime: gameNow, type: "challenge" },
];
const result = analyzePlayer(
  {
    name: "test",
    tag: "#TEST",
    clan: null,
    trophies: 0,
    bestTrophies: 0,
    expLevel: 1,
    totalDonations: 0,
    donations: 0,
    badges: [],
  },
  sampleBattleLog,
);
assert.strictEqual(
  result.activityIndicators.totalBattles,
  4,
  "totalBattles should include all fights",
);
assert.strictEqual(
  result.activityIndicators.totalWarBattles,
  1,
  "totalWarBattles should include only war fights",
);
const sumActivity = result.recentActivity.dailyActivity.reduce(
  (sum, d) => sum + d.count,
  0,
);
assert.strictEqual(sumActivity, 4, "dailyActivity should count all battles");
console.log("✓ analyzePlayer dailyActivity all-battles test passed.");

// New cache regression test: ensure legacy backend/data/analysis-cache folder is not used.
(async function () {
  try {
    await fs.access(
      new URL("../data/analysis-cache", import.meta.url),
      fs.constants.F_OK,
    );
    throw new Error(
      "Legacy backend/data/analysis-cache directory should not exist",
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(
        "✓ legacy backend/data/analysis-cache directory not found as expected",
      );
    } else {
      throw err;
    }
  }
})();

console.log("All computeIsNewPlayer tests passed.");
