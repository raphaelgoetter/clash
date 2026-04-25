import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { getSnapshotsForWeeks, recordSnapshot, resolveSnapshotType } from "./snapshot.js";

const TMP_DIR = path.join("/tmp", "clash-snapshots");
const TEST_FILE = path.join(TMP_DIR, "TESTTAG.json");

async function main() {
  await fs.mkdir(TMP_DIR, { recursive: true });
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

  const weekSnaps = await getSnapshotsForWeeks("TESTTAG", ["S131W3"]);
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
  await fs.writeFile(TEST_FILE, JSON.stringify(backupFixture, null, 2), "utf-8");
  await recordSnapshot(
    "TESTTAG",
    [
      { tag: "#A", decksUsed: 4 },
      { tag: "#B", decksUsed: 4 },
    ],
    "S131W3",
    { now: "2026-04-25T10:42:00.000Z" },
  );
  const updatedWeekSnaps = await getSnapshotsForWeeks("TESTTAG", ["S131W3"]);
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

  await fs.unlink(TEST_FILE);
  console.log("✓ snapshot service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
