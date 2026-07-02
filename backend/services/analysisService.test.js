import assert from "assert";
import fs from "fs/promises";
import {
  analyzePlayer,
  buildDailyActivity,
  computeBattleMatchup,
  computeIsNewPlayer,
  computeWarScore,
  computeWarReliabilityFallback,
  filterWarBattles,
  hasDuelOnWarDay,
  expandDuelRounds,
  summarizeWarDecks,
  summarizeWarDecksForMatchup,
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

const matchupDecks = summarizeWarDecksForMatchup(
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
  matchupDecks.length,
  4,
  "summarizeWarDecksForMatchup should return one entry per duel round",
);
assert.strictEqual(
  matchupDecks[1].matches?.[0]?.score,
  "1-0",
  "The first duel round should be scored 1-0",
);
assert.strictEqual(
  matchupDecks[2].matches?.[0]?.score,
  "0-1",
  "The second duel round should be scored 0-1",
);
assert.strictEqual(
  matchupDecks[3].matches?.[0]?.score,
  "1-0",
  "The third duel round should be scored 1-0",
);

const extremeMatchupHigh = computeBattleMatchup(
  {
    type: "riverRacePvp",
    team: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 1,
          rarity: "common",
        })),
        crowns: 0,
      },
    ],
    opponent: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 16,
          rarity: "legendary",
        })),
        crowns: 0,
      },
    ],
  },
  { playerTourLevel: 10, opponentTourLevel: 13 },
);
assert.ok(
  extremeMatchupHigh >= 0.99,
  `Extreme disadvantage should produce a very high matchup, got ${extremeMatchupHigh}`,
);

const extremeMatchupLow = computeBattleMatchup(
  {
    type: "riverRacePvp",
    team: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 16,
          rarity: "legendary",
        })),
        crowns: 0,
      },
    ],
    opponent: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 1,
          rarity: "common",
        })),
        crowns: 0,
      },
    ],
  },
  { playerTourLevel: 13, opponentTourLevel: 10 },
);
assert.ok(
  extremeMatchupLow <= 0.01,
  `Extreme advantage should produce a very low matchup, got ${extremeMatchupLow}`,
);

const measuredMatchup = computeBattleMatchup(
  {
    type: "riverRacePvp",
    team: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 13,
          rarity: "rare",
        })),
        crowns: 0,
      },
    ],
    opponent: [
      {
        cards: Array.from({ length: 8 }, () => ({
          level: 15,
          rarity: "legendary",
        })),
        crowns: 3,
      },
    ],
  },
  { playerTourLevel: 13, opponentTourLevel: 15 },
);
assert.ok(
  measuredMatchup >= 0.8,
  `Une vraie grosse différence de deck/tour doit donner un matchup élevé, got ${measuredMatchup}`,
);

const rootLevelRoundDecks = summarizeWarDecksForMatchup(
  [
    {
      type: "riverRaceDuel",
      battleTime: "20260612T100000.000Z",
      rounds: [
        { crowns: 1, opponent: { crowns: 0 } },
        { crowns: 0, opponent: { crowns: 1 } },
        { crowns: 1, opponent: { crowns: 0 } },
      ],
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
        },
      ],
      opponent: [{ name: "Aegon Targaryen" }],
    },
  ],
  64,
  null,
  "LRQP20V9",
);
assert.strictEqual(
  rootLevelRoundDecks.length,
  3,
  "summarizeWarDecksForMatchup should expand root-level battle.rounds",
);
assert.strictEqual(
  rootLevelRoundDecks[0].matches?.[0]?.score,
  "1-0",
  "The first round should be scored 1-0 for root-level rounds",
);
assert.strictEqual(
  rootLevelRoundDecks[1].matches?.[0]?.score,
  "0-1",
  "The second round should be scored 0-1 for root-level rounds",
);
assert.strictEqual(
  rootLevelRoundDecks[2].matches?.[0]?.score,
  "1-0",
  "The third round should be scored 1-0 for root-level rounds",
);

const displaynoneCaseDecks = summarizeWarDecksForMatchup(
  [
    {
      type: "riverRacePvp",
      battleTime: "20260612T100000.000Z",
      team: [
        {
          cards: Array.from({ length: 24 }, (_, index) => ({
            id: String(index + 1),
            name: `C${index + 1}`,
          })),
          crowns: 2,
        },
      ],
      opponent: [{ name: "juaco041", crowns: 0 }],
    },
    {
      type: "riverRaceDuel",
      battleTime: "20260612T101000.000Z",
      team: [
        {
          cards: Array.from({ length: 24 }, (_, index) => ({
            id: String(index + 25),
            name: `D${index + 1}`,
          })),
          rounds: [{ crowns: 0 }, { crowns: 1 }, { crowns: 0 }],
        },
      ],
      opponent: [
        {
          name: "R-ANGELITO",
          rounds: [{ crowns: 3 }, { crowns: 0 }, { crowns: 1 }],
        },
      ],
    },
    {
      type: "riverRaceDuel",
      battleTime: "20260613T134400.000Z",
      team: [
        {
          cards: Array.from({ length: 24 }, (_, index) => ({
            id: String(index + 49),
            name: `E${index + 1}`,
          })),
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
  64,
  null,
  "LRQP20V9",
);
const j2Decks = displaynoneCaseDecks.filter(
  (deck) => deck.matches?.[0]?.dayKey === "2026-06-12",
);
assert.strictEqual(
  j2Decks.length,
  4,
  "J2 must include 4 decks when R-ANGELITO plays 3 rounds",
);
assert.deepStrictEqual(
  j2Decks.map((deck) => deck.matches?.[0]?.score),
  ["2-0", "0-3", "1-0", "0-1"],
  "J2 deck scores must preserve the 3-round duel against R-ANGELITO",
);
const j3Decks = displaynoneCaseDecks.filter(
  (deck) => deck.matches?.[0]?.dayKey === "2026-06-13",
);
assert.strictEqual(
  j3Decks.length,
  3,
  "J3 should include 3 duel decks for Aegon Targaryen",
);
assert.deepStrictEqual(
  j3Decks.map((deck) => deck.matches?.[0]?.score),
  ["1-0", "0-1", "1-0"],
  "J3 deck scores must preserve the 3-round duel against Aegon Targaryen",
);

const duelFirstDecks = summarizeWarDecksForMatchup(
  [
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
    {
      type: "riverRacePvp",
      battleTime: "20260612T110000.000Z",
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
  ],
  8,
  null,
  "LRQP20V9",
);
assert.deepStrictEqual(
  duelFirstDecks.map((deck) => deck.label),
  ["Deck 1", "Deck 2", "Deck 3", "Deck 4"],
  "Deck labels should remain sequential when the duel appears before the PvP match",
);
assert.strictEqual(
  duelFirstDecks[3].matches?.[0]?.score,
  "3-0",
  "The final PvP match should still be labeled Deck 4",
);

const multiDayMatchupDecks = summarizeWarDecksForMatchup(
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
  multiDayMatchupDecks.length >= 2,
  "summarizeWarDecksForMatchup should include multiple day entries",
);
assert.ok(
  multiDayMatchupDecks.some(
    (deck) => deck.matches?.[0]?.dayKey === "2026-06-12",
  ),
  "Matchup summary should contain the newest day",
);
assert.ok(
  multiDayMatchupDecks.some(
    (deck) => deck.matches?.[0]?.dayKey === "2026-06-11",
  ),
  "Matchup summary should contain the older day",
);

const multiDayLabels = summarizeWarDecksForMatchup(
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
assert.deepStrictEqual(
  multiDayLabels.map((deck) => deck.label),
  ["Deck 1", "Deck 1"],
  "Deck labels should restart at 1 for a new GDC day",
);

const sameDayLabels = summarizeWarDecksForMatchup(
  [
    {
      type: "riverRacePvp",
      battleTime: "20260612T100000.000Z",
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
      type: "riverRacePvp",
      battleTime: "20260612T101000.000Z",
      team: [
        {
          cards: [
            { id: "9", name: "I" },
            { id: "10", name: "J" },
            { id: "11", name: "K" },
            { id: "12", name: "L" },
            { id: "13", name: "M" },
            { id: "14", name: "N" },
            { id: "15", name: "O" },
            { id: "16", name: "P" },
          ],
          crowns: 2,
        },
      ],
      opponent: [{ name: "Y", crowns: 1 }],
    },
    {
      type: "riverRacePvp",
      battleTime: "20260612T102000.000Z",
      team: [
        {
          cards: [
            { id: "17", name: "Q" },
            { id: "18", name: "R" },
            { id: "19", name: "S" },
            { id: "20", name: "T" },
            { id: "21", name: "U" },
            { id: "22", name: "V" },
            { id: "23", name: "W" },
            { id: "24", name: "X" },
          ],
          crowns: 1,
        },
      ],
      opponent: [{ name: "Z", crowns: 2 }],
    },
    {
      type: "riverRacePvp",
      battleTime: "20260612T103000.000Z",
      team: [
        {
          cards: [
            { id: "25", name: "Y" },
            { id: "26", name: "Z" },
            { id: "27", name: "A2" },
            { id: "28", name: "B2" },
            { id: "29", name: "C2" },
            { id: "30", name: "D2" },
            { id: "31", name: "E2" },
            { id: "32", name: "F2" },
          ],
          crowns: 0,
        },
      ],
      opponent: [{ name: "W", crowns: 3 }],
    },
  ],
  8,
  null,
  "LRQP20V9",
);
assert.deepStrictEqual(
  sameDayLabels.map((deck) => deck.label),
  ["Deck 1", "Deck 2", "Deck 3", "Deck 4"],
  "Deck labels should restart at 1 for each new GDC day",
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

// New Points / Deck behavior (linear 100→180 pts/deck) for all players
const scoreCases = [
  { pointsPerDeck: 0, expected: 0 },
  { pointsPerDeck: 99, expected: 0 },
  { pointsPerDeck: 100, expected: 0 },
  { pointsPerDeck: 150, expected: 2.5 },
  { pointsPerDeck: 180, expected: 4 },
  { pointsPerDeck: 200, expected: 4 },
  { pointsPerDeck: 250, expected: 4 },
];
for (const tc of scoreCases) {
  const warScore = computeWarScore(
    { trophies: 5000, totalDonations: 1000, badges: [] },
    {
      weeks: [
        {
          decksUsed: 16,
          fame: tc.pointsPerDeck * 16,
        },
      ],
      avgFame: tc.pointsPerDeck * 16,
      streakInCurrentClan: 1,
      totalWeeks: 1,
    },
    null,
    null,
    false,
  );
  const pointsPerDeckEntry = warScore.breakdown.find(
    (entry) => entry.label === "Points / Deck",
  );
  assert.ok(
    pointsPerDeckEntry,
    `Points / Deck entry exists for pointsPerDeck ${tc.pointsPerDeck}`,
  );
  assert.strictEqual(
    pointsPerDeckEntry.score,
    tc.expected,
    `pointsPerDeck ${tc.pointsPerDeck} should give ${tc.expected}, got ${pointsPerDeckEntry.score}`,
  );
}
console.log("✓ computeWarScore Points / Deck thresholds test passed.");

const regularityProfile = computeWarScore(
  { trophies: 5000, totalDonations: 1000, badges: [] },
  {
    weeks: [
      { decksUsed: 16, fame: 2400 },
      { decksUsed: 8, fame: 1200 },
      { decksUsed: 16, fame: 2400 },
      { decksUsed: 16, fame: 2400 },
      { decksUsed: 12, fame: 1800 },
    ],
    streakInCurrentClan: 5,
    totalWeeks: 5,
  },
  null,
  null,
  false,
);
const regularityEntry = regularityProfile.breakdown.find(
  (entry) => entry.label === "Regularity",
);
assert.ok(regularityEntry, "Regularity entry exists for five-week profile");
assert.strictEqual(
  regularityEntry.score,
  7.2,
  `Five-week profile with 3 full weeks should score 7.2, got ${regularityEntry.score}`,
);
assert.ok(
  regularityEntry.detail.includes("3/5 full weeks"),
  `Expected regularity detail to mention 3/5 full weeks, got ${regularityEntry.detail}`,
);
console.log("✓ computeWarScore regularity window test passed.");

const fallbackPointsPerDeck = computeWarReliabilityFallback(
  {
    trophies: 12000,
    totalDonations: 10000,
    badges: [{ name: "ClanWarWins", progress: 250 }],
  },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  {
    weeks: [
      { label: "S1·W1", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W2", decksUsed: 16, fame: 2320, isCurrent: false },
      { label: "S1·W3", decksUsed: 16, fame: 2240, isCurrent: false },
      { label: "S1·W4", decksUsed: 16, fame: 2160, isCurrent: false },
    ],
    streakInCurrentClan: 4,
  },
);
const fallbackPointsPerDeckEntry = fallbackPointsPerDeck.breakdown.find(
  (entry) => entry.label === "Points / Deck",
);
assert.ok(
  fallbackPointsPerDeckEntry,
  "Fallback should expose Points / Deck when warHistory is available",
);
assert.strictEqual(
  fallbackPointsPerDeckEntry.max,
  4,
  `Fallback Points / Deck max should be 4, got ${fallbackPointsPerDeckEntry.max}`,
);
assert.strictEqual(
  fallbackPointsPerDeck.maxScore,
  42,
  `Fallback maxScore should be 42 when lastSeen is present, got ${fallbackPointsPerDeck.maxScore}`,
);
assert.ok(
  fallbackPointsPerDeck.summary.includes("Points / deck"),
  "Fallback summary should mention Points / deck",
);
console.log("✓ fallback Points / Deck thresholds test passed.");

const highEfficiencyProfile = computeWarScore(
  {
    trophies: 5000,
    totalDonations: 1000,
    badges: [{ name: "ClanWarWins", progress: 250 }],
  },
  {
    weeks: [
      { decksUsed: 16, fame: 3000 },
      { decksUsed: 16, fame: 2960 },
      { decksUsed: 16, fame: 2890 },
    ],
    avgFame: 2950,
    streakInCurrentClan: 3,
    totalWeeks: 3,
  },
  0.9,
  null,
  true,
);
const lowEfficiencyProfile = computeWarScore(
  {
    trophies: 5000,
    totalDonations: 1000,
    badges: [{ name: "ClanWarWins", progress: 250 }],
  },
  {
    weeks: [
      { decksUsed: 16, fame: 1900 },
      { decksUsed: 16, fame: 1860 },
      { decksUsed: 16, fame: 1810 },
    ],
    avgFame: 1857,
    streakInCurrentClan: 3,
    totalWeeks: 3,
  },
  0.9,
  null,
  true,
);
assert.ok(
  highEfficiencyProfile.total > lowEfficiencyProfile.total,
  `Expected high efficiency profile to outrank low efficiency profile (${highEfficiencyProfile.total} vs ${lowEfficiencyProfile.total})`,
);
console.log("✓ computeWarScore efficiency ranking test passed.");

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

const fallbackWithHistory = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  {
    weeks: [
      { label: "S1·W1", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W2", decksUsed: 8, fame: 1200, isCurrent: false },
      { label: "S1·W3", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W4", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W5", decksUsed: 12, fame: 1800, isCurrent: false },
    ],
    streakInCurrentClan: 1,
  },
);
assert.ok(
  fallbackWithHistory.breakdown.some((b) => b.label === "Regularity"),
  "Fallback with warHistory should expose Regularity",
);
assert.ok(
  !fallbackWithHistory.breakdown.some((b) => b.label === "General Activity"),
  "Fallback with warHistory should no longer expose General Activity",
);
const fallbackWarActivityEntry = fallbackWithHistory.breakdown.find(
  (b) => b.label === "War Activity",
);
assert.strictEqual(
  fallbackWarActivityEntry?.score,
  1.6,
  `Expected War Activity to scale from 1/5 recovered weeks, got ${fallbackWarActivityEntry?.score}`,
);
const fallbackRegularityEntry = fallbackWithHistory.breakdown.find(
  (b) => b.label === "Regularity",
);
assert.strictEqual(
  fallbackRegularityEntry?.score,
  7.2,
  `Expected Regularity to count only full weeks on a 5-week window, got ${fallbackRegularityEntry?.score}`,
);
assert.ok(
  fallbackRegularityEntry?.detail.includes("3/5 full weeks"),
  `Expected Regularity detail to mention full weeks, got ${fallbackRegularityEntry?.detail}`,
);
console.log("✓ fallback regularity replacement test passed.");

// New tests: fallback relies only on recovered weeks and not on battle-log ratios
const fallbackNoHistory = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 28, gdc: 0, ladder: 28, challenge: 0 },
  null,
  false,
  0,
  null,
);
const fallbackWarActivityNoHistory = fallbackNoHistory.breakdown.find(
  (b) => b.label === "War Activity",
);
assert.ok(
  fallbackWarActivityNoHistory,
  "War Activity entry exists for no-history case",
);
assert.strictEqual(
  fallbackWarActivityNoHistory?.score,
  0,
  `Expected War Activity 0 when no history is recovered, got ${fallbackWarActivityNoHistory?.score}`,
);
assert.strictEqual(
  fallbackNoHistory.breakdown.find((b) => b.label === "Regularity")?.score,
  0,
  "Expected Regularity 0 when no history is recovered",
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
  42,
  `Expected fallback maxScore 42 when lastSeen is present, got ${fallbackNoWarWithLastSeen.maxScore}`,
);
assert.ok(
  fallbackNoWarWithLastSeen.breakdown.some((b) => b.label === "Last Seen"),
  "Expected Last Seen entry when lastSeen data is available",
);

const fallbackFiveWeeks = computeWarReliabilityFallback(
  { trophies: 12000, totalDonations: 10000, badges: [] },
  [],
  { total: 0, gdc: 0, ladder: 0, challenge: 0 },
  null,
  false,
  0,
  {
    weeks: [
      { label: "S1·W1", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W2", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W3", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W4", decksUsed: 16, fame: 2400, isCurrent: false },
      { label: "S1·W5", decksUsed: 16, fame: 2400, isCurrent: false },
    ],
    streakInCurrentClan: 5,
  },
);
assert.strictEqual(
  fallbackFiveWeeks.breakdown.find((b) => b.label === "War Activity")?.score,
  8,
  "Expected War Activity 8 when five weeks are recovered",
);
assert.strictEqual(
  fallbackFiveWeeks.breakdown.find((b) => b.label === "Regularity")?.score,
  12,
  "Expected Regularity 12 when five full weeks are recovered",
);
assert.strictEqual(
  fallbackFiveWeeks.maxScore,
  39,
  `Expected fallback maxScore 39 when no last seen data and Discord is not counted, got ${fallbackFiveWeeks.maxScore}`,
);
const cw2Entry = fallbackFiveWeeks.breakdown.find(
  (b) => b.label === "CW2 badge",
);
assert.ok(cw2Entry, "CW2 badge entry exists for five-week case");
assert.strictEqual(
  cw2Entry.max,
  10,
  `CW2 badge max should be 10, got ${cw2Entry.max}`,
);
const warActivityEntryAllWar = fallbackFiveWeeks.breakdown.find(
  (b) => b.label === "War Activity",
);
assert.ok(
  warActivityEntryAllWar,
  "War Activity entry exists for five-week case",
);
assert.strictEqual(
  warActivityEntryAllWar.max,
  8,
  `War Activity max should be 8, got ${warActivityEntryAllWar.max}`,
);
console.log("✓ fallback recovered-week scaling tests passed.");

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
