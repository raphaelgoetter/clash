// Script pour comparer les tags du snapshot jeudi et du cache actuel
// Usage : node temp/compare_snapshot_cache.js
import fs from "fs";
const snap = Object.keys(
  JSON.parse(fs.readFileSync("./data/snapshots/LRQP20V9.json"))[0].days.find(
    (d) => d.warDay === "thursday",
  )._cumulFame,
);
const cache = Object.keys(
  JSON.parse(fs.readFileSync("./frontend/dist/clan-cache/LRQP20V9.json"))
    .membersRaw,
);
console.log(
  "Dans snapshot mais pas dans cache:",
  snap.filter((t) => !cache.includes(t)),
);
console.log(
  "Dans cache mais pas dans snapshot:",
  cache.filter((t) => !snap.includes(t)),
);
