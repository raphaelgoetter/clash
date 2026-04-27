import assert from "assert";
import { computeWeeklySummary } from "../../scripts/notifyWarSummary.js";

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
