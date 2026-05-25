import assert from "assert";
import {
  computeWeeklySummary,
  computeMissingDuelsCountFromBattleLog,
} from "../../scripts/notifyWarSummary.js";

const FIXTURE = [
  {
    warDay: "thursday",
    realDay: "2026-04-23",
    snapshotCount: 190,
    decks: {},
  },
  {
    warDay: "friday",
    realDay: "2026-04-24",
    snapshotCount: 194,
    decks: {
      "#A": 40,
      "#B": 40,
      "#C": 40,
      "#D": 40,
      "#E": 40,
    },
  },
  {
    warDay: "saturday",
    realDay: "2026-04-25",
    snapshotCount: 194,
    decks: {},
  },
  {
    warDay: "sunday",
    realDay: "2026-04-26",
    snapshotCount: 190,
    decks: {},
  },
];

const result = computeWeeklySummary(FIXTURE);
assert.strictEqual(
  result.totalDecksWeek,
  774,
  "Should use deck totals from the snapshot decks object when present",
);
assert.strictEqual(
  result.avgDecksPerDay,
  193.5,
  "Average should compute with the weekly total and 4 days",
);
console.log("notifyWarSummary.test.js passed");

const WEEK_DAYS = ["2026-05-21", "2026-05-22", "2026-05-23", "2026-05-24"];

const noDuelBattleLog = [
  { type: "riverRacePvP", battleTime: "20260521T120000.000Z" },
  { type: "riverRacePvP", battleTime: "20260522T120000.000Z" },
  { type: "clanWarBattle", battleTime: "20260523T120000.000Z" },
  { type: "riverRaceBoat", battleTime: "20260524T120000.000Z" },
];

assert.strictEqual(
  computeMissingDuelsCountFromBattleLog(noDuelBattleLog, "LRQP20V9", WEEK_DAYS),
  4,
  "Un joueur sans duel sur la semaine doit avoir 4 duels manquants",
);

const mixedDuelBattleLog = [
  { type: "riverRaceDuel", battleTime: "20260521T120000.000Z" },
  { type: "riverRaceDuelsColosseum", battleTime: "20260523T120000.000Z" },
  { type: "riverRacePvP", battleTime: "20260522T120000.000Z" },
  { type: "riverRaceBoat", battleTime: "20260524T120000.000Z" },
];

assert.strictEqual(
  computeMissingDuelsCountFromBattleLog(
    mixedDuelBattleLog,
    "LRQP20V9",
    WEEK_DAYS,
  ),
  2,
  "Le calcul doit retirer uniquement les jours où au moins un duel a été joué",
);

console.log("notifyWarSummary.duels.test.js passed");
