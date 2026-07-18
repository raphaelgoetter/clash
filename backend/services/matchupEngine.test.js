import assert from "assert";
import {
  identifyWinConditions,
  computeArchetypeLayer,
  computeCounterLayer,
  computeUtilityLayer,
  computeLevelDifferentialLayer,
  computeDeckMatchupScore,
} from "./matchupEngine.js";
import {
  normalizeCardName,
  getWinConditionsCatalog,
} from "./matchupCatalog.js";

console.log("Running matchupEngine tests...");

// ------------------------------------------------------------
// Catalogue de fixture en mémoire — indépendant du contenu réel de
// data/clash-royale-matchup-catalog.json (édité à la main par l'utilisateur),
// pour que ces tests restent stables quels que soient les counters ajoutés.
// ------------------------------------------------------------

// Règles Layer 3 de fixture — même forme/valeurs que
// data/clash-royale-matchup-structure-rules.json au moment de l'écriture de
// ces tests, mais copiées ici pour rester indépendantes d'un fichier édité
// à la main par l'utilisateur (cf. buildFixtureCatalog ci-dessous).
function buildFixtureStructureRules() {
  const toSet = (names) => new Set(names.map(normalizeCardName));
  return {
    cardSets: {
      smallSpells: toSet(["The Log", "Zap", "Arrows", "Barbarian Barrel", "Giant Snowball", "Rage"]),
      bigSpells: toSet(["Fireball", "Poison", "Lightning", "Rocket", "Void"]),
      defensiveBuildings: toSet(["Cannon", "Tesla", "Inferno Tower", "Bomb Tower", "Tombstone", "Goblin Cage"]),
      tankKillers: toSet(["Mini P.E.K.K.A", "P.E.K.K.A", "Hunter", "Mighty Miner", "Inferno Dragon", "Elite Barbarians"]),
      heavyBeatdownWinConditions: toSet(["Golem", "Giant", "Electro Giant", "Lava Hound"]),
      splitPushTriggerCards: toSet(["Three Musketeers", "Royal Hogs"]),
    },
    crossRules: [
      {
        id: "bait",
        trigger: { type: "archetype", value: "Bait" },
        watch: { cardSets: ["smallSpells"] },
        thresholds: [
          { op: "lt", value: 1, shift: 6, label: "{opponent}: 0 petit sort, {self}: Bait" },
          { op: "gte", value: 2, shift: -6, label: "{opponent}: {count} petits sorts, {self}: Bait" },
        ],
      },
      {
        id: "splitPush",
        trigger: { type: "cardSet", value: "splitPushTriggerCards" },
        watch: { cardSets: ["bigSpells"] },
        thresholds: [
          { op: "eq", value: 0, shift: 6, label: "{opponent}: 0 gros sort, {self}: {triggerCard} (push)" },
        ],
      },
      {
        id: "heavyBeatdown",
        trigger: { type: "cardSet", value: "heavyBeatdownWinConditions" },
        watch: { cardSets: ["tankKillers", "defensiveBuildings"] },
        thresholds: [
          { op: "eq", value: 0, shift: 10, label: "{opponent}: aucun tank killer/bâtiment, {self}: Gros tank" },
        ],
      },
    ],
    dispersionRules: [
      { id: "winConditions", metric: "winConditionCount", baseline: 2, unitPoints: 3, label: "{self}: {count} WC (dispersion)" },
      { id: "spells", cardSets: ["smallSpells", "bigSpells"], baseline: 3, unitPoints: 3, label: "{self}: {count} sorts (dispersion)" },
      { id: "buildings", cardSets: ["defensiveBuildings"], baseline: 2, unitPoints: 3, label: "{self}: {count} bâtiments (dispersion)" },
    ],
    clamp: 10,
  };
}

function buildFixtureCatalog(entries) {
  const winConditionsByName = new Map();
  for (const entry of entries) {
    winConditionsByName.set(normalizeCardName(entry.name), entry);
  }
  return {
    winConditionsByName,
    normalizeCardName,
    structureRules: buildFixtureStructureRules(),
  };
}

const catalog = buildFixtureCatalog([
  {
    name: "Hog Rider",
    archetype: "Cycle",
    hardCounters: ["Cannon", "Tesla"],
    softCounters: ["Mini P.E.K.K.A", "P.E.K.K.A"],
  },
  {
    name: "Miner",
    archetype: "Control",
    hardCounters: ["Knight"],
    softCounters: ["Skeletons"],
  },
  {
    name: "Golem",
    archetype: "Beatdown",
    hardCounters: ["P.E.K.K.A"],
    softCounters: ["Tesla", "Cannon"],
  },
  {
    name: "P.E.K.K.A",
    archetype: "Control",
    hardCounters: ["Inferno Tower"],
    softCounters: ["Goblins"],
  },
  {
    name: "Goblin Barrel",
    archetype: "Bait",
    hardCounters: ["The Log"],
    softCounters: ["Zap"],
  },
  {
    name: "Three Musketeers",
    archetype: "Split-Push",
    hardCounters: ["Fireball"],
    softCounters: ["Bowler"],
  },
]);

function card(name, level = 11, rarity = "Common") {
  return { name, level, rarity };
}

function filler(count, offset = 0) {
  return Array.from({ length: count }, (_, i) =>
    card(`Filler${i + offset}`),
  );
}

// computeCounterLayer exige les deux côtés connus (sinon neutre, cf. règle
// "win condition inconnue" gérée en amont par computeDeckMatchupScore). Pour
// isoler la contribution d'un seul côté dans les tests 1 et 2, le deck A
// inclut toujours "Skeletons" — l'unique soft counter de Miner dans la
// fixture — ce qui neutralise volontairement le côté B (exactement 1 soft
// counter = zone grise = 0, cf. règle du cas "exactement 1 soft counter").
const miner = catalog.winConditionsByName.get("miner");

// ------------------------------------------------------------
// 1. Win condition connue avec hard counter présent → layer2 = -9
// ------------------------------------------------------------
{
  const hogRider = catalog.winConditionsByName.get("hog rider");
  const layer2 = computeCounterLayer(
    [hogRider],
    [card("Hog Rider"), card("Skeletons"), ...filler(6)],
    [miner],
    [card("Cannon"), ...filler(7, 100)],
    catalog,
  );
  assert.strictEqual(
    layer2,
    -9,
    `Hard counter present should shift -9, got ${layer2}`,
  );
  console.log("✓ hard counter present → layer2 = -9");
}

// ------------------------------------------------------------
// 2. Win condition connue sans aucun counter → layer2 = +9
// ------------------------------------------------------------
{
  const hogRider = catalog.winConditionsByName.get("hog rider");
  const layer2 = computeCounterLayer(
    [hogRider],
    [card("Hog Rider"), card("Skeletons"), ...filler(6, 50)],
    [miner],
    filler(8, 200), // aucune carte ne matche hardCounters/softCounters de Hog Rider
    catalog,
  );
  assert.strictEqual(
    layer2,
    9,
    `No counter present should shift +9, got ${layer2}`,
  );
  console.log("✓ no counter present → layer2 = +9");
}

// ------------------------------------------------------------
// 3. Win condition inconnue vs deck connu → layer1 === 0 && layer2 === 0
// ------------------------------------------------------------
{
  const unknownDeck = [card("Balloon"), ...filler(7, 300)]; // "Balloon" absent du catalogue de fixture
  const knownDeck = [card("Hog Rider"), ...filler(7, 400)];
  const { breakdown } = computeDeckMatchupScore(unknownDeck, knownDeck, catalog);
  assert.strictEqual(breakdown.layer1, 0, "layer1 should be neutral");
  assert.strictEqual(breakdown.layer2, 0, "layer2 should be neutral");
  console.log("✓ unknown win condition → layer1 = layer2 = 0");
}

// ------------------------------------------------------------
// 4. Deck à double win condition (Hog + Miner) → moyenne Layer 1/2
// ------------------------------------------------------------
{
  const dualDeck = [card("Hog Rider"), card("Miner"), ...filler(6, 500)];
  const pekkaDeck = [card("P.E.K.K.A"), ...filler(7, 600)];
  const winConditionsA = identifyWinConditions(dualDeck, catalog);
  const winConditionsB = identifyWinConditions(pekkaDeck, catalog);
  assert.strictEqual(winConditionsA.length, 2, "should identify both Hog Rider and Miner");

  const layer1 = computeArchetypeLayer(winConditionsA, winConditionsB);
  // Hog Rider (Cycle) vs P.E.K.K.A (Control) → Control a l'avantage sur Cycle → -5
  // Miner (Control) vs P.E.K.K.A (Control) → pas de règle → 0
  // moyenne = (-5 + 0) / 2 = -2.5
  assert.strictEqual(layer1, -2.5, `Expected averaged layer1 = -2.5, got ${layer1}`);

  const layer2 = computeCounterLayer(
    winConditionsA,
    dualDeck,
    winConditionsB,
    pekkaDeck,
    catalog,
  );
  // Hog Rider vs pekkaDeck : 1 soft counter (P.E.K.K.A) → zone grise → 0
  // Miner vs pekkaDeck : aucun counter → +9
  // avgA = (0 + 9) / 2 = 4.5
  // P.E.K.K.A vs dualDeck : aucun counter → +9 → avgB = 9
  // layer2 = avgA - avgB = 4.5 - 9 = -4.5
  assert.strictEqual(layer2, -4.5, `Expected averaged layer2 = -4.5, got ${layer2}`);
  console.log("✓ dual win condition → layer1/layer2 averaged correctly");
}

// ------------------------------------------------------------
// 5. Écart de niveau extrême → layer4 === -20 (cap atteint, 1.2%/point)
// ------------------------------------------------------------
{
  const lowDeck = filler(8).map((c) => ({ ...c, level: 1, rarity: "Common" }));
  const highDeck = filler(8, 100).map((c) => ({
    ...c,
    level: 16,
    rarity: "Legendary",
  }));
  const layer4 = computeLevelDifferentialLayer(lowDeck, highDeck);
  assert.strictEqual(layer4, -20, `Expected capped layer4 = -20, got ${layer4}`);
  console.log("✓ extreme level gap → layer4 capped at -20");
}

// ------------------------------------------------------------
// 6. Layer 3 isolé : Bait, Three Musketeers, Golem
// ------------------------------------------------------------
{
  const goblinBarrel = catalog.winConditionsByName.get("goblin barrel");

  // Bait vs 0 petit sort adverse → +6
  const layer3BaitNoSpell = computeUtilityLayer(
    [goblinBarrel],
    [card("Goblin Barrel"), ...filler(7, 700)],
    [],
    filler(8, 800),
    catalog,
  );
  assert.strictEqual(layer3BaitNoSpell, 6, "Bait vs 0 small spell should be +6");

  // Bait vs 2+ petits sorts adverses → -6
  const layer3BaitTwoSpells = computeUtilityLayer(
    [goblinBarrel],
    [card("Goblin Barrel"), ...filler(7, 900)],
    [],
    [card("The Log"), card("Zap"), ...filler(6, 1000)],
    catalog,
  );
  assert.strictEqual(
    layer3BaitTwoSpells,
    -6,
    "Bait vs 2+ small spells should be -6",
  );

  // Three Musketeers vs pas de big spell → +6
  const threeMusketeers = catalog.winConditionsByName.get("three musketeers");
  const layer3SplitPush = computeUtilityLayer(
    [threeMusketeers],
    [card("Three Musketeers"), ...filler(7, 1100)],
    [],
    filler(8, 1200),
    catalog,
  );
  assert.strictEqual(
    layer3SplitPush,
    6,
    "Three Musketeers vs no big spell should be +6",
  );

  // Golem vs pas de tank killer / bâtiment défensif → +10
  const golem = catalog.winConditionsByName.get("golem");
  const layer3HeavyBeatdown = computeUtilityLayer(
    [golem],
    [card("Golem"), ...filler(7, 1300)],
    [],
    filler(8, 1400),
    catalog,
  );
  assert.strictEqual(
    layer3HeavyBeatdown,
    10,
    "Heavy tank vs no tank killer/defensive building should be +10",
  );
  console.log("✓ layer3 rules (Bait, split-push, heavy beatdown) match spec");
}

// ------------------------------------------------------------
// 7. Normalisation des noms : "P.E.K.K.A." et "P.E.K.K.A" doivent matcher
// ------------------------------------------------------------
{
  assert.strictEqual(
    normalizeCardName("P.E.K.K.A."),
    normalizeCardName("P.E.K.K.A"),
    "Trailing dot should not affect normalization",
  );
  const winConditionsWithDot = identifyWinConditions(
    [card("P.E.K.K.A."), ...filler(7, 1500)],
    catalog,
  );
  assert.strictEqual(
    winConditionsWithDot.length,
    1,
    "P.E.K.K.A. (with trailing dot) should match the catalog entry",
  );
  console.log("✓ card name normalization absorbs punctuation differences");
}

// ------------------------------------------------------------
// 8. Test anti-collision : le catalogue réel + les catégories Layer 3
//    ne doivent contenir aucune collision de clé normalisée.
// ------------------------------------------------------------
{
  const realCatalog = await getWinConditionsCatalog();
  const seen = new Map();
  for (const [key, entry] of realCatalog.winConditionsByName) {
    if (seen.has(key) && seen.get(key) !== entry.name) {
      throw new Error(
        `Normalization collision: "${seen.get(key)}" and "${entry.name}" both normalize to "${key}"`,
      );
    }
    seen.set(key, entry.name);
  }
  assert.ok(
    realCatalog.winConditionsByName.size > 0,
    "real catalog should have loaded at least one win condition",
  );
  console.log("✓ no normalization collisions in the real catalog");
}

// ------------------------------------------------------------
// 9. Convention de signe interne : scoreA = avantage du Deck A
//    (l'inversion vers "difficulté" se fait dans battleLogUtils.js,
//    testée séparément lors de l'intégration).
// ------------------------------------------------------------
{
  // Hog Rider (A) dur-countered par Cannon dans le deck Miner (B) :
  // layer1 = -5 (Control bat Cycle), layer2 = clamp(-9 - 9, -15, 15) = -15.
  // scoreA = 50 - 5 - 15 = 30.
  const hogDeck = [card("Hog Rider"), ...filler(7, 1600)];
  const minerDeckWithCannon = [card("Miner"), card("Cannon"), ...filler(6, 1700)];
  const { scoreA: disadvantaged } = computeDeckMatchupScore(
    hogDeck,
    minerDeckWithCannon,
    catalog,
  );
  assert.strictEqual(
    disadvantaged,
    30,
    `Deck A hard countered should score 30, got ${disadvantaged}`,
  );

  // Mêmes decks inversés : par symétrie du moteur, scoreA doit devenir
  // 100 - 30 = 70 (Deck A == ancien Deck B, désormais avantagé).
  const { scoreA: advantaged } = computeDeckMatchupScore(
    minerDeckWithCannon,
    hogDeck,
    catalog,
  );
  assert.strictEqual(
    advantaged,
    70,
    `Swapping the decks should mirror the score to 70, got ${advantaged}`,
  );
  console.log("✓ scoreA convention: higher = more advantage for Deck A");
}

console.log("All matchupEngine tests passed.");
