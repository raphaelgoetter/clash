import assert from "assert";
import fs from "fs/promises";
import path from "path";
import {
  getSnapshotsForWeeks,
  recordSnapshot,
  resolveSnapshotType,
  overrideWarSnapshotDaysWithLiveCurrentDay,
} from "./snapshot.js";

const TMP_DIR = path.join("/tmp", "clash-snapshots");
const TEST_TAG = "TESTTAG2";
const TEST_FILE = path.join(TMP_DIR, `${TEST_TAG}.json`);
const TEST_DATA_FILE = path.join("data", "snapshots", `${TEST_TAG}.json`);

async function main() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.rm(TEST_FILE, { force: true });
  await fs.rm(TEST_DATA_FILE, { force: true });
  const fixture = [
    {
      week: "S131W3",
      days: [
        {
          warDay: "thursday",
          realDay: "2026-04-23",
          gdcPeriod: {
            start: "2026-04-23T09:52:00.000Z",
            end: "2026-04-24T09:51:59.999Z",
          },
          snapshotBackupTime: "2026-04-24T10:00:00.000Z",
          snapshotCount: 187,
          decks: {},
        },
      ],
    },
  ];

  await fs.writeFile(TEST_FILE, JSON.stringify(fixture, null, 2), "utf-8");

  const weekSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
  assert.strictEqual(
    weekSnaps.S131W3.length,
    4,
    "Expected four ordered war days for S131W3",
  );

  const snap = weekSnaps.S131W3[0];
  assert.strictEqual(snap.snapshotCount, 187);
  assert.deepStrictEqual(snap.decks, {});
  assert.strictEqual(snap.snapshotBackupTime, "2026-04-24T10:00:00.000Z");
  assert.strictEqual(
    resolveSnapshotType("2026-04-24T10:00:00.000Z", "Y8JUPC9C"),
    "backup",
  );
  assert.strictEqual(
    resolveSnapshotType("2026-04-24T12:00:00.000Z", "Y8JUPC9C"),
    "primary",
  );

  {
    const fixture = [
      {
        week: "S131W3",
        days: [
          {
            warDay: "thursday",
            realDay: "2026-04-23",
            gdcPeriod: {
              start: "2026-04-23T09:52:00.000Z",
              end: "2026-04-24T09:51:59.999Z",
            },
            snapshotTime: "2026-04-24T10:00:00.000Z",
            snapshotCount: 187,
            decks: {},
            periodType: "colosseum",
          },
        ],
      },
    ];
    await fs.writeFile(TEST_FILE, JSON.stringify(fixture, null, 2), "utf-8");
    const colosseumSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
    assert.strictEqual(
      colosseumSnaps.S131W3[0].snapshotCount,
      187,
      "Should accept colosseum snapshots as valid war snapshots",
    );
  }

  {
    const original = [100, 120, 80, null];
    const currentRace = {
      periodType: "warDay",
      periodIndex: 2,
      clan: {
        participants: [
          { tag: "#A", decksUsedToday: 2 },
          { tag: "#B", decksUsedToday: 3 },
          { tag: "#C", decksUsedToday: 0 },
        ],
      },
    };
    const currentMemberTags = new Set(["#A", "#B", "#C"]);
    const updated = overrideWarSnapshotDaysWithLiveCurrentDay(
      original,
      currentRace,
      currentMemberTags,
    );
    assert.deepStrictEqual(
      updated,
      [100, 120, 5, null],
      "Should override current war day with live decksUsedToday sum",
    );
  }

  {
    const original = [100, 120, 80, null];
    const currentRace = {
      periodType: "warDay",
      periodIndex: 1,
      clan: {
        participants: [
          { tag: "#A", decksUsedToday: 0 },
          { tag: "#B", decksUsedToday: 0 },
        ],
      },
    };
    const currentMemberTags = new Set(["#A", "#B"]);
    const updated = overrideWarSnapshotDaysWithLiveCurrentDay(
      original,
      currentRace,
      currentMemberTags,
    );
    assert.deepStrictEqual(
      updated,
      original,
      "Should not override with zero live decksUsedToday",
    );
  }

  {
    const original = [100, 120, 80, null];
    const currentRace = {
      state: "warDay",
      periodIndex: 0,
      clan: {
        participants: [
          { tag: "#A", decksUsedToday: 2 },
          { tag: "#B", decksUsedToday: 3 },
        ],
      },
    };
    const currentMemberTags = new Set(["#A", "#B"]);
    const updated = overrideWarSnapshotDaysWithLiveCurrentDay(
      original,
      currentRace,
      currentMemberTags,
    );
    assert.deepStrictEqual(
      updated,
      [5, 120, 80, null],
      "Should override current war day even when periodType is missing but state indicates warDay",
    );
  }

  {
    const original = [100, 120, 80, null];
    const currentRace = {
      periodType: "warDay",
      periodIndex: 19,
      clan: {
        participants: [
          { tag: "#A", decksUsedToday: 2 },
          { tag: "#B", decksUsedToday: 3 },
        ],
      },
    };
    const currentMemberTags = new Set(["#A", "#B"]);
    const updated = overrideWarSnapshotDaysWithLiveCurrentDay(
      original,
      currentRace,
      currentMemberTags,
      "Y8JUPC9C",
      new Date("2026-04-25T12:00:00Z"),
    );
    assert.deepStrictEqual(
      updated,
      [100, 120, 5, null],
      "Should fallback to calendar day index when periodIndex is outside 0..3",
    );
  }

  {
    await fs.writeFile(TEST_FILE, JSON.stringify([], null, 2), "utf-8");
    await recordSnapshot(
      TEST_TAG,
      [
        { tag: "#A", decksUsed: 5, decksUsedToday: 1 },
        { tag: "#B", decksUsed: 8, decksUsedToday: 4 },
      ],
      "S131W3",
      { now: "2026-04-24T10:05:00.000Z" },
    );
    const fridayWeekSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
    const fridaySnap = fridayWeekSnaps.S131W3[1];
    assert.strictEqual(
      fridaySnap.snapshotCount,
      5,
      "Should compute today's decks from decksUsedToday when no base cumul exists",
    );
    assert.deepStrictEqual(fridaySnap.decks, { "#A": 1, "#B": 4 });
  }

  {
    const existingFixture = [
      {
        week: "S131W3",
        days: [
          {
            warDay: "thursday",
            realDay: "2026-04-23",
            gdcPeriod: {
              start: "2026-04-23T09:40:00.000Z",
              end: "2026-04-24T09:39:59.999Z",
            },
            snapshotTime: "2026-04-24T22:00:00.000Z",
            snapshotCount: 194,
            decks: {
              "#A": 4,
              "#B": 4,
              "#C": 4,
              "#D": 4,
              "#E": 4,
            },
            periodType: "warDay",
            _cumul: {
              "#A": 4,
              "#B": 4,
              "#C": 4,
              "#D": 4,
              "#E": 4,
            },
          },
          {
            warDay: "friday",
            realDay: "2026-04-24",
            gdcPeriod: {
              start: "2026-04-24T09:40:00.000Z",
              end: "2026-04-25T09:39:59.999Z",
            },
            decks: {},
            _cumul: {},
            periodType: "warDay",
          },
        ],
      },
    ];
    await fs.writeFile(
      TEST_FILE,
      JSON.stringify(existingFixture, null, 2),
      "utf-8",
    );
    await recordSnapshot(
      TEST_TAG,
      [
        { tag: "#A", decksUsed: 4, decksUsedToday: 1 },
        { tag: "#B", decksUsed: 8, decksUsedToday: 4 },
        { tag: "#C", decksUsed: 12, decksUsedToday: 4 },
        { tag: "#D", decksUsed: 16, decksUsedToday: 4 },
        { tag: "#E", decksUsed: 20, decksUsedToday: 4 },
      ],
      "S131W3",
      { now: "2026-04-25T10:05:00.000Z" },
    );
    const preservedWeekSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
    const preservedThursday = preservedWeekSnaps.S131W3[0];
    assert.strictEqual(
      preservedThursday.snapshotCount,
      194,
      "Should preserve a valid past day snapshotCount when backup runs after reset",
    );
    assert.deepStrictEqual(preservedThursday.decks, {
      "#A": 4,
      "#B": 4,
      "#C": 4,
      "#D": 4,
      "#E": 4,
    });
  }

  // Backup snapshot should not overwrite an existing primary snapshot for the current war day.
  const backupFixture = [
    {
      week: "S131W3",
      days: [
        {
          warDay: "thursday",
          realDay: "2026-04-23",
          gdcPeriod: {
            start: "2026-04-23T09:40:00.000Z",
            end: "2026-04-24T09:39:59.999Z",
          },
          snapshotTime: "2026-04-23T12:00:00.000Z",
          snapshotCount: 4,
          decks: { "#A": 4 },
          periodType: "warDay",
          _cumul: { "#A": 4 },
        },
        {
          warDay: "friday",
          realDay: "2026-04-24",
          gdcPeriod: {
            start: "2026-04-24T09:40:00.000Z",
            end: "2026-04-25T09:39:59.999Z",
          },
          snapshotTime: "2026-04-25T08:00:00.000Z",
          snapshotCount: 8,
          decks: { "#A": 4, "#B": 4 },
          periodType: "warDay",
          _cumul: { "#A": 4, "#B": 4 },
        },
      ],
    },
  ];
  await fs.writeFile(
    TEST_FILE,
    JSON.stringify(backupFixture, null, 2),
    "utf-8",
  );
  await recordSnapshot(
    TEST_TAG,
    [
      { tag: "#A", decksUsed: 4 },
      { tag: "#B", decksUsed: 4 },
    ],
    "S131W3",
    { now: "2026-04-25T10:42:00.000Z" },
  );
  const updatedWeekSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
  const fridaySnap = updatedWeekSnaps.S131W3[1];
  assert.strictEqual(
    fridaySnap.snapshotCount,
    8,
    "Backup snapshot should preserve existing primary snapshot deck count",
  );
  assert.strictEqual(
    fridaySnap.snapshotTime,
    "2026-04-25T08:00:00.000Z",
    "Backup snapshot should not overwrite the existing primary snapshot time",
  );
  assert.strictEqual(
    fridaySnap.snapshotBackupTime,
    "2026-04-25T10:42:00.000Z",
    "Backup snapshot should record backupTime while preserving primary snapshot data",
  );

  // Backup snapshot without an existing primary snapshot should still
  // record the backup timestamp on the current day and keep the previous day.
  const noPrimaryFixture = [
    {
      week: "S131W3",
      days: [
        {
          warDay: "friday",
          realDay: "2026-04-24",
          gdcPeriod: {
            start: "2026-04-24T09:40:00.000Z",
            end: "2026-04-25T09:39:59.999Z",
          },
          snapshotTime: "2026-04-24T14:00:00.000Z",
          snapshotCount: 200,
          decks: { "#A": 4, "#B": 4, "#C": 4, "#D": 4, "#E": 4 },
          periodType: "warDay",
          _cumul: { "#A": 4, "#B": 4, "#C": 4, "#D": 4, "#E": 4 },
        },
        {
          warDay: "saturday",
          realDay: "2026-04-25",
          gdcPeriod: {
            start: "2026-04-25T09:40:00.000Z",
            end: "2026-04-26T09:39:59.999Z",
          },
          decks: {},
          _cumul: {},
          periodType: "warDay",
        },
      ],
    },
  ];

  await fs.writeFile(
    TEST_FILE,
    JSON.stringify(noPrimaryFixture, null, 2),
    "utf-8",
  );
  await recordSnapshot(
    TEST_TAG,
    [
      { tag: "#A", decksUsed: 4, fame: 0 },
      { tag: "#B", decksUsed: 4, fame: 0 },
      { tag: "#C", decksUsed: 4, fame: 0 },
      { tag: "#D", decksUsed: 4, fame: 0 },
      { tag: "#E", decksUsed: 4, fame: 0 },
    ],
    "S131W3",
    { now: "2026-04-25T10:05:00.000Z" },
  );

  const noPrimaryWeekSnaps = await getSnapshotsForWeeks(TEST_TAG, ["S131W3"]);
  const saturdaySnap = noPrimaryWeekSnaps.S131W3[2];
  assert.strictEqual(
    saturdaySnap.snapshotBackupTime,
    "2026-04-25T10:05:00.000Z",
  );
  assert.strictEqual(saturdaySnap.snapshotCount, 0);
  assert.deepStrictEqual(saturdaySnap.decks, {});

  await fs.rm(TEST_FILE, { force: true });
  await fs.rm(TEST_DATA_FILE, { force: true });
  console.log("✓ snapshot service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
