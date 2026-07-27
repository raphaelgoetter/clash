import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { writeChampionRegistry, getHistory } from "./championPredictions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.resolve(__dirname, "..", "..", "data", "champion-registry.json");
const TMP_REGISTRY_FILE = "/tmp/champion-registry.json";
const CLAN_TAG = "TESTCLAN1";
const LEGACY_CLAN_TAG = "TESTCLAN2";

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
  // Doublon volontaire de S133W5 (simule un backfill rejoué) : ne doit pas
  // être compté comme une semaine supplémentaire ni casser le calcul de série.
  { clanTag: CLAN_TAG, weekId: "S133W5", seasonId: 133, sectionIndex: 4,
    champions: [{ tag: "P1", name: "Alice", fame: 3100 }, { tag: "P3", name: "Carl", fame: 3100 }] },
];

// Entrées au format legacy (champ `champion` singulier, avant la migration vers
// `champions` pluriel) — le registre de clans peu actifs peut encore en contenir,
// hors de portée du race log donc jamais réécrites par backfillChampionRegistry.
const legacyFixture = [
  { clanTag: LEGACY_CLAN_TAG, weekId: "S131W3", seasonId: 131, sectionIndex: 2,
    champion: { tag: "P4", name: "Dan", fame: 3200 } },
  { clanTag: LEGACY_CLAN_TAG, weekId: "S131W4", seasonId: 131, sectionIndex: 3,
    champion: { tag: "P4", name: "Dan", fame: 3100 } },
];

async function main() {
  const originalLocal = await fs.readFile(REGISTRY_FILE, "utf-8").catch(() => null);
  const originalTmp = await fs.readFile(TMP_REGISTRY_FILE, "utf-8").catch(() => null);

  try {
    await writeChampionRegistry([...fixture, ...legacyFixture]);
    const { entries: history, hasMore } = await getHistory(CLAN_TAG, 10);

    assert.strictEqual(
      history.length, 5,
      "le doublon de S133W5 doit être fusionné, il ne doit rester que 5 semaines distinctes",
    );
    assert.strictEqual(history[0].weekId, "S133W5", "l'historique doit être trié en ordre décroissant");
    assert.strictEqual(hasMore, false, "aucune page suivante quand tout tient dans la limite");

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

    // Pagination : page 1 (limit=3, offset=0) puis page 2 (offset=3)
    const page1 = await getHistory(CLAN_TAG, 3, 0);
    assert.strictEqual(page1.entries.length, 3);
    assert.deepStrictEqual(page1.entries.map((e) => e.weekId), ["S133W5", "S133W4", "S133W3"]);
    assert.strictEqual(page1.hasMore, true, "il reste 2 semaines plus anciennes");

    const page2 = await getHistory(CLAN_TAG, 3, 3);
    assert.strictEqual(page2.entries.length, 2);
    assert.deepStrictEqual(page2.entries.map((e) => e.weekId), ["S133W2", "S133W1"]);
    assert.strictEqual(page2.hasMore, false, "plus rien après la page 2");

    // Schéma legacy `champion` (singulier) : doit être normalisé en `champions`
    // et rester exploitable pour l'affichage et les stats.
    const legacyHistory = (await getHistory(LEGACY_CLAN_TAG, 10)).entries;
    assert.strictEqual(legacyHistory.length, 2);
    const legacyByWeek = Object.fromEntries(legacyHistory.map((e) => [e.weekId, e]));
    assert.strictEqual(
      legacyByWeek["S131W3"].champions[0].name, "Dan",
      "l'entrée legacy doit être exposée via champions[], pas juste champion",
    );
    assert.strictEqual(legacyByWeek["S131W3"].champions[0].totalCount, 2);
    assert.strictEqual(legacyByWeek["S131W4"].champions[0].streak, 2);

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
