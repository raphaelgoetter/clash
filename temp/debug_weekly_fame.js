// debug temporaire — diagnostique bilan hebdo
import { loadSnapshots } from "../backend/services/snapshot.js";

for (const tag of ["LRQP20V9", "Y8JUPC9C", "QU9UQJRL"]) {
  const snap = await loadSnapshots(tag);
  const week = snap[0];
  if (!week) {
    console.log(tag, "pas de snap");
    continue;
  }
  console.log(`\n=== ${tag} weekId:${week.week} ===`);
  for (const d of week.days ?? []) {
    const cumulSum = Object.values(d._cumulFame ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    const preResetSum = d._cumulFamePreReset
      ? Object.values(d._cumulFamePreReset).reduce((a, b) => a + b, 0)
      : null;
    console.log(
      d.realDay,
      d.warDay,
      "cumul:",
      cumulSum,
      "preReset:",
      preResetSum,
      "snap:",
      d.snapshotTime,
      "preResetTime:",
      d.snapshotPreResetTime ?? "N/A",
    );
  }
}
