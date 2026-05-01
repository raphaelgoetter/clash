import assert from "assert";
import { buildDebugSnapshotInfo } from "./debugSnapshotInfo.js";

const weekSnaps = [
  {
    _cumulFame: { "#A": 10, "#B": 5 },
    snapshotTime: "2026-04-23T09:20:00.000Z",
  },
  {
    _cumulFame: { "#A": 30, "#B": 20 },
    snapshotTime: "2026-04-24T09:20:00.000Z",
  },
  {
    _cumulFame: { "#A": 80, "#B": 20 },
    snapshotTime: "2026-04-25T09:20:00.000Z",
  },
  {
    _cumulFame: { "#A": 120, "#B": 40 },
    snapshotTime: "2026-04-26T09:20:00.000Z",
  },
];

const info = buildDebugSnapshotInfo({
  weekSnaps,
  warDayIndex: 3,
  currentMemberTags: new Set(["#A", "#B"]),
  allParts: [
    { tag: "#A", name: "Alice", fame: 120 },
    { tag: "#B", name: "Bob", fame: 40 },
  ],
  warSnapshotDays: [15, 35, 50, 80],
  clanTag: "TEST",
  fallbackWarDays: [],
});

assert.strictEqual(info.scoreJeudi, 15, "scoreJeudi doit être le total J1");
assert.strictEqual(
  info.scoreVendredi,
  35,
  "scoreVendredi doit être la différence J2/J1",
);
assert.strictEqual(
  info.scoreSamedi,
  50,
  "scoreSamedi doit être la différence J3/J2",
);
assert.strictEqual(
  info.scoreDimanche,
  60,
  "scoreDimanche doit être la différence J4/J3",
);
assert.deepStrictEqual(
  info.dailyScores,
  { jeudi: 15, vendredi: 35, samedi: 50, dimanche: 60 },
  "dailyScores doit exposer les scores jour par jour",
);
assert.strictEqual(
  info.snapshotJ1DailyFame,
  50,
  "snapshotJ1DailyFame doit refléter J-1 quand warDayIndex=3",
);

const infoFriday = buildDebugSnapshotInfo({
  weekSnaps,
  warDayIndex: 1,
  currentMemberTags: new Set(["#A", "#B"]),
  allParts: [
    { tag: "#A", name: "Alice", fame: 10 },
    { tag: "#B", name: "Bob", fame: 5 },
  ],
  warSnapshotDays: [15, 35, 50, 80],
  clanTag: "TEST",
  fallbackWarDays: [],
});
assert.strictEqual(
  infoFriday.snapshotJ1DailyFame,
  15,
  "snapshotJ1DailyFame doit refléter J-1 sur vendredi (premier jour précédent)",
);

const infoNormalizedTags = buildDebugSnapshotInfo({
  weekSnaps,
  warDayIndex: 3,
  currentMemberTags: new Set(["A", "b"]),
  allParts: [
    { tag: "a", name: "Alice", fame: 120 },
    { tag: "#B", name: "Bob", fame: 40 },
  ],
  warSnapshotDays: [15, 35, 50, 80],
  clanTag: "TEST",
  fallbackWarDays: [],
});
assert.strictEqual(
  infoNormalizedTags.cumulFameLive,
  160,
  "cumulFameLive doit normaliser les tags sans # et avec majuscules",
);
assert.strictEqual(
  infoNormalizedTags.debugDelta[0].prev,
  80,
  "prev cumul fame lookup doit fonctionner avec tags normalisés et J-1",
);
assert.strictEqual(
  infoNormalizedTags.debugDelta[1].prev,
  20,
  "prev cumul fame lookup doit fonctionner avec tags normalisés et J-1",
);

const infoClanTotal = buildDebugSnapshotInfo({
  weekSnaps,
  warDayIndex: 3,
  currentMemberTags: new Set(["#A", "#B"]),
  allParts: [
    { tag: "#A", name: "Alice", fame: 120 },
    { tag: "#B", name: "Bob", fame: 40 },
  ],
  warSnapshotDays: [15, 35, 50, 80],
  clanTag: "TEST",
  currentRaceClanFame: 170,
  fallbackWarDays: [],
});
assert.strictEqual(
  infoClanTotal.cumulFameLive,
  160,
  "cumulFameLive doit encore refléter la somme des participants",
);
assert.strictEqual(
  infoClanTotal.effectiveCumulFameLive,
  170,
  "effectiveCumulFameLive doit utiliser la valeur totale du clan si elle est plus grande",
);
assert.strictEqual(
  infoClanTotal.cumulFameLiveSource,
  "clanTotal",
  "cumulFameLiveSource doit indiquer la source utilisée",
);

console.log("All debugSnapshotInfo tests passed.");
