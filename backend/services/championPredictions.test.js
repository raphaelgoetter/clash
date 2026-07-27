import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { writeChampionRegistry, getHistory } from "./championPredictions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.resolve(__dirname, "..", "..", "data", "champion-registry.json");
const TMP_REGISTRY_FILE = "/tmp/champion-registry.json";
const CLAN_TAG = "TESTCLAN1";

const fixture = [
  { clanTag: CLAN_TAG, weekId: "S133W1", seasonId: 133, sectionIndex: 0,
    champions: [{ tag: "P1", name: "Alice", fame: 3000 }] },
  { clanTag: CLAN_TAG, weekId: "S133W2", seasonId: 133, sectionIndex: 1,
    champions: [{ tag: "P1", name: "Alice", fame: 3100 }] },
  { clanTag: CLAN_TAG, weekId: "S133W3", seasonId: 133, sectionIndex: 2,
    champions: [{ tag: "P2", name: "Bob", fame: 3200 }] },
  { clanTag: CLAN_TAG, weekId: "S133W4", seasonId: 133, sectionIndex: 3,
    champions: [{ tag: "P1", name: "Alice", fame: 3050 }] },
  { clanTag: CLAN_TAG, weekId: "S133W5", seasonId: 133, sectionIndex: 4,
    champions: [{ tag: "P1", name: "Alice", fame: 3100 }, { tag: "P3", name: "Carl", fame: 3100 }] },
];

async function main() {
  const originalLocal = await fs.readFile(REGISTRY_FILE, "utf-8").catch(() => null);
  const originalTmp = await fs.readFile(TMP_REGISTRY_FILE, "utf-8").catch(() => null);

  try {
    await writeChampionRegistry(fixture);
    const history = await getHistory(CLAN_TAG, 10);

    assert.strictEqual(history.length, 5, "les 5 semaines de la fixture doivent être retournées");
    assert.strictEqual(history[0].weekId, "S133W5", "l'historique doit être trié en ordre décroissant");

    const byWeek = Object.fromEntries(history.map((e) => [e.weekId, e]));
    const champByTag = (weekId, tag) => byWeek[weekId].champions.find((c) => c.tag === tag);

    // Alice (P1) : championne 4 fois, avec une série cassée par Bob (S133W3)
    assert.strictEqual(champByTag("S133W1", "P1").totalCount, 4);
    assert.strictEqual(champByTag("S133W1", "P1").streak, 1);
    assert.strictEqual(champByTag("S133W2", "P1").streak, 2, "S133W1→W2 sont consécutives");
    assert.strictEqual(champByTag("S133W4", "P1").streak, 1, "la série est cassée par S133W3 (Bob)");
    assert.strictEqual(champByTag("S133W5", "P1").streak, 2, "S133W4→W5 sont consécutives");
    assert.strictEqual(champByTag("S133W5", "P1").totalCount, 4);

    // Bob (P2) : champion une seule fois
    assert.strictEqual(champByTag("S133W3", "P2").totalCount, 1);
    assert.strictEqual(champByTag("S133W3", "P2").streak, 1);

    // Carl (P3) : ex-æquo avec Alice sur S133W5, champion une seule fois
    assert.strictEqual(champByTag("S133W5", "P3").totalCount, 1);
    assert.strictEqual(champByTag("S133W5", "P3").streak, 1);

    console.log("✓ championPredictions.test.js passed");
  } finally {
    if (originalLocal !== null) {
      await fs.writeFile(REGISTRY_FILE, originalLocal, "utf-8");
    } else {
      await fs.rm(REGISTRY_FILE, { force: true });
    }
    if (originalTmp !== null) {
      await fs.writeFile(TMP_REGISTRY_FILE, originalTmp, "utf-8");
    } else {
      await fs.rm(TMP_REGISTRY_FILE, { force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
