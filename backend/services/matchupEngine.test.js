import assert from "assert";
import {
  identifyWinConditions,
  computeCounterLayer,
  computeUtilityLayer,
  computeLevelDifferentialLayer,
  computeEvolutionLayer,
  computeDeckMatchupScore,
} from "./matchupEngine.js";
import {
  normalizeCardName,
  getWinConditionsCatalog,
} from "./matchupCatalog.js";

// Valeurs attendues tirées de CONTRIBUTING.md, section « Matchup GDC »
// (calibration du 06/10/2026) : base 50, 4 layers additifs, score borné
// à [5, 95].

console.log("Running matchupEngine tests...");

// ------------------------------------------------------------
// Catalogue de fixture en mémoire — indépendant du contenu réel de
// data/clash-royale-matchup-catalog.json et
// data/clash-royale-matchup-structure-rules.json (édités à la main), pour
// que ces tests restent stables quels que soient les counters ajoutés. Les
// règles de structure reprennent la forme et les poids du fichier réel au
// moment de la calibration.
// ------------------------------------------------------------

function buildFixtureStructureRules() {
  const toSet = (names) => new Set(names.map(normalizeCardName));
  return {
    cardSets: {
      smallSpells: toSet(["The Log", "Zap", "Arrows", "Barbarian Barrel"]),
      bigSpells: toSet(["Fireball", "Poison", "Lightning", "Rocket"]),
      defensiveBuildings: toSet(["Cannon", "Tesla", "Inferno Tower", "Bomb Tower"]),
      heavyDpsHardCounters: toSet(["Ronin", "P.E.K.K.A", "Mini P.E.K.K.A"]),
      heavyDpsThreats: toSet(["P.E.K.K.A", "Mini P.E.K.K.A", "Prince", "Mega Knight"]),
      antiAirCards: toSet(["Musketeer", "Archers", "Tesla", "Inferno Tower"]),
      lowElixirCards: toSet(["Skeletons", "Zap", "The Log", "Ice Spirit"]),
    },
    crossRules: [
      {
        id: "bait",
        trigger: { type: "archetype", value: "Bait" },
        watch: { cardSets: ["smallSpells"] },
        thresholds: [{ op: "lt", value: 1, shift: 8, label: "Bait face à 0 petit sort adverse" }],
      },
      {
        id: "heavyDpsHardCounter",
        trigger: { type: "cardSet", value: "heavyDpsHardCounters" },
        watch: { cardSets: ["heavyDpsThreats"] },
        thresholds: [{ op: "gte", value: 1, shift: 2, label: "{triggerCard} hard-counter {watchCards}" }],
      },
    ],
    dispersionRules: [
      { id: "winConditions", metric: "winConditionCount", baseline: 2, unitPoints: 4, label: "{count} win conditions (dispersion)" },
      { id: "spells", cardSets: ["smallSpells", "bigSpells"], baseline: 3, unitPoints: 2, label: "{count} sorts (dispersion)" },
      { id: "buildings", cardSets: ["defensiveBuildings"], baseline: 2, unitPoints: 2, label: "{count} bâtiments (dispersion)" },
    ],
    selfRules: [
      { id: "antiAirScarcity", watch: { cardSets: ["antiAirCards"] }, thresholds: [{ op: "eq", value: 0, shift: -4, label: "0 carte anti-air" }] },
      { id: "noSpell", watch: { cardSets: ["smallSpells", "bigSpells"] }, thresholds: [{ op: "eq", value: 0, shift: -2, label: "0 sort" }] },
      { id: "lowElixirScarcity", watch: { cardSets: ["lowElixirCards"] }, thresholds: [{ op: "eq", value: 0, shift: -4, label: "0 carte à moins de 3 élixir" }] },
    ],
    clamp: 10,
  };
}

function buildFixtureCatalog(entries, pseudoEntries = []) {
  const byName = (list) =>
    new Map(list.map((entry) => [normalizeCardName(entry.name), entry]));
  return {
    winConditionsByName: byName(entries),
    pseudoWinConditionsByName: byName(pseudoEntries),
    normalizeCardName,
    structureRules: buildFixtureStructureRules(),
  };
}

const catalog = buildFixtureCatalog(
  [
    { name: "Hog Rider", archetype: "Cycle", hardCounters: ["Cannon", "Tesla"], softCounters: ["Mini P.E.K.K.A", "P.E.K.K.A"] },
    { name: "Miner", archetype: "Control", hardCounters: ["Knight"], softCounters: ["Skeletons"] },
    { name: "Golem", archetype: "Beatdown", hardCounters: ["P.E.K.K.A"], softCounters: ["Tesla", "Cannon"] },
    { name: "P.E.K.K.A", archetype: "Control", hardCounters: ["Inferno Tower"], softCounters: ["Goblins"] },
    { name: "Goblin Barrel", archetype: "Bait", hardCounters: ["The Log"], softCounters: ["Zap"] },
  ],
  [{ name: "Mega Knight", archetype: "Beatdown", hardCounters: ["P.E.K.K.A"], softCounters: [] }],
);

function card(name, level = 11, rarity = "common", evolutionLevel = 0) {
  return { name, level, rarity, evolutionLevel };
}

function filler(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => card(`Filler${i + offset}`));
}

// Deck neutre pour le layer Structure : 1 anti-air, 1 sort, 1 carte < 3
// élixir, donc aucune carence (selfRules) ni dispersion.
function cleanDeck(extra = [], offset = 0) {
  const base = [card("Musketeer"), card("Zap"), card("Skeletons")];
  return [...base, ...extra, ...filler(8 - base.length - extra.length, offset)];
}

const wc = (name) => catalog.winConditionsByName.get(normalizeCardName(name));

// ------------------------------------------------------------
// 1. Counters directs (±6) : par win condition, +3 moins 3 par
//    hard-counter et 1 par soft-counter adverse, borné à ±3 ;
//    layer = moyenne(A) - moyenne(B).
// ------------------------------------------------------------
{
  // Hog subit 1 hard-counter (Cannon) → 0 ; Miner subit 1 soft (Skeletons) → 2.
  assert.strictEqual(
    computeCounterLayer(
      [wc("Hog Rider")],
      [card("Hog Rider"), card("Skeletons"), ...filler(6)],
      [wc("Miner")],
      [card("Miner"), card("Cannon"), ...filler(6, 100)],
      catalog,
    ),
    -2,
    "1 hard-counter contre 1 soft-counter doit donner -2",
  );

  // Aucun counter côté Hog → 3 ; Miner toujours soft-countered → 2.
  assert.strictEqual(
    computeCounterLayer(
      [wc("Hog Rider")],
      [card("Hog Rider"), card("Skeletons"), ...filler(6)],
      [wc("Miner")],
      [card("Miner"), ...filler(7, 100)],
      catalog,
    ),
    1,
    "Sans counter adverse, la win condition garde sa baseline +3",
  );

  // 2 hard-counters → 3 - 6 = -3 (borne basse) ; Miner sans counter → 3.
  assert.strictEqual(
    computeCounterLayer(
      [wc("Hog Rider")],
      [card("Hog Rider"), ...filler(7)],
      [wc("Miner")],
      [card("Miner"), card("Cannon"), card("Tesla"), ...filler(5, 100)],
      catalog,
    ),
    -6,
    "Le layer counters est borné à ±6",
  );

  // Double win condition moyennée : Hog soft-countered par P.E.K.K.A → 2,
  // Miner sans counter → 3, moyenne 2,5 ; P.E.K.K.A sans counter → 3.
  const dualDeck = [card("Hog Rider"), card("Miner"), ...filler(6)];
  const pekkaDeck = [card("P.E.K.K.A"), ...filler(7, 100)];
  const winConditionsA = identifyWinConditions(dualDeck, catalog);
  assert.strictEqual(winConditionsA.length, 2, "Hog Rider et Miner doivent être identifiés");
  assert.strictEqual(
    computeCounterLayer(
      winConditionsA,
      dualDeck,
      identifyWinConditions(pekkaDeck, catalog),
      pekkaDeck,
      catalog,
    ),
    -0.5,
    "Plusieurs win conditions sont moyennées",
  );
  console.log("✓ counters : baseline +3, poids 3/1, bornes ±3 et ±6, moyenne");
}

// ------------------------------------------------------------
// 2. Win conditions inconnues et pseudo win conditions
// ------------------------------------------------------------
{
  // Aucune win condition d'un côté : counters neutralisés pour le combat.
  const { breakdown } = computeDeckMatchupScore(
    [card("Balloon"), ...filler(7)],
    [card("Hog Rider"), card("Cannon"), ...filler(6, 100)],
    catalog,
  );
  assert.strictEqual(breakdown.counters, 0, "Counters neutres si une win condition est inconnue");

  // Pseudo win condition utilisée seulement en l'absence de vraie win condition.
  const pseudoOnly = identifyWinConditions([card("Mega Knight"), ...filler(7)], catalog);
  assert.deepStrictEqual(
    pseudoOnly.map((w) => [w.name, w.pseudo]),
    [["Mega Knight", true]],
    "Mega Knight doit servir de pseudo win condition",
  );
  const realFirst = identifyWinConditions([card("Mega Knight"), card("Hog Rider"), ...filler(6)], catalog);
  assert.deepStrictEqual(
    realFirst.map((w) => w.name),
    ["Hog Rider"],
    "Une vraie win condition prime sur les pseudo win conditions",
  );
  console.log("✓ win condition inconnue → counters neutres ; pseudo win conditions en repli");
}

// ------------------------------------------------------------
// 3. Écart de niveau (±40 + ±8) : 2 % par point d'écart de la somme des
//    niveaux normalisés, puis 4 % par niveau d'écart des win conditions.
// ------------------------------------------------------------
{
  const neutral = filler(7);
  const withGap = (delta) => [...neutral, card("Gap", 11 + delta)];
  const baseline = withGap(0);
  for (const [delta, expected] of [
    [1, -2],
    [5, -10],
    [20, -40],
    [30, -40],
  ]) {
    assert.strictEqual(
      computeLevelDifferentialLayer(baseline, withGap(delta)),
      expected,
      `Un écart de ${delta} points doit donner ${expected}`,
    );
  }
  assert.strictEqual(
    computeLevelDifferentialLayer(withGap(5), baseline),
    10,
    "Le layer niveau est symétrique",
  );

  // normLevel : une légendaire niveau 9 vaut une commune niveau 17.
  assert.strictEqual(
    computeLevelDifferentialLayer(
      [...neutral, card("Gap", 9, "legendary")],
      [...neutral, card("Gap", 17, "common")],
    ),
    0,
    "Le niveau est normalisé par rareté",
  );

  // Composante win conditions : Hog niveau 13 contre Miner niveau 11 →
  // cartes (2 points × 2) + win conditions (2 niveaux × 4) = 12.
  const hogDeck = (level) => [card("Hog Rider", level), ...neutral];
  const minerDeck = [card("Miner", 11), ...filler(7, 100)];
  const levelWithWc = (deckA, deckB) =>
    computeLevelDifferentialLayer(
      deckA,
      deckB,
      identifyWinConditions(deckA, catalog),
      identifyWinConditions(deckB, catalog),
      catalog,
    );
  assert.strictEqual(levelWithWc(hogDeck(13), minerDeck), 12, "Écart de win condition : 4 % par niveau");
  assert.strictEqual(levelWithWc(hogDeck(15), minerDeck), 16, "La composante win conditions est bornée à ±8");
  assert.strictEqual(
    levelWithWc(hogDeck(13), filler(8, 100)),
    4,
    "Sans win condition d'un côté, seule la somme des cartes compte",
  );
  console.log("✓ niveau : 2 %/point borné à ±40, win conditions 4 %/niveau bornées à ±8");
}

// ------------------------------------------------------------
// 4. Évolutions et héros (±9) : 3 % par carte d'écart avec evolutionLevel > 0.
// ------------------------------------------------------------
{
  const evolved = (count, level = 1) =>
    [...Array.from({ length: count }, (_, i) => card(`Evo${i}`, 11, "common", level)), ...filler(8 - count)];
  assert.strictEqual(computeEvolutionLayer(evolved(2), evolved(0)), 6, "2 évolutions d'écart → +6");
  assert.strictEqual(computeEvolutionLayer(evolved(1, 2), evolved(0)), 3, "Un héros compte comme une évolution");
  assert.strictEqual(computeEvolutionLayer(evolved(0), evolved(4)), -9, "Le layer évolutions est borné à ±9");
  console.log("✓ évolutions : 3 %/carte, héros compris, borné à ±9");
}

// ------------------------------------------------------------
// 5. Structure du deck (±10) : règles croisées, carences, dispersion.
// ------------------------------------------------------------
{
  const structure = (deckA, deckB) =>
    computeUtilityLayer(
      identifyWinConditions(deckA, catalog),
      deckA,
      identifyWinConditions(deckB, catalog),
      deckB,
      catalog,
    );

  assert.strictEqual(structure(cleanDeck(), cleanDeck([], 100)), 0, "Deux decks sans carence → 0");

  // Bait (Goblin Barrel) face à 0 petit sort adverse → +8 (l'adversaire a un
  // gros sort pour ne pas subir la carence « 0 sort »).
  assert.strictEqual(
    structure(
      cleanDeck([card("Goblin Barrel")]),
      [card("Musketeer"), card("Fireball"), card("Skeletons"), ...filler(5, 100)],
    ),
    8,
    "Bait face à 0 petit sort adverse → +8",
  );

  // Mini P.E.K.K.A face à un gros DPS adverse (Prince) → +2.
  assert.strictEqual(
    structure(cleanDeck([card("Mini P.E.K.K.A")]), cleanDeck([card("Prince")], 100)),
    2,
    "Hard-counter de gros DPS → +2",
  );

  // Carence propre : 0 carte anti-air → -4.
  assert.strictEqual(
    structure([card("Zap"), card("Skeletons"), ...filler(6)], cleanDeck([], 100)),
    -4,
    "0 carte anti-air → -4",
  );

  // Dispersion triangulaire : 4 sorts → -2, 5 sorts → -6 (2 × (1 + 2)).
  const spells = (names) => cleanDeck(names.map((n) => card(n)));
  assert.strictEqual(structure(spells(["The Log", "Fireball", "Poison"]), cleanDeck([], 100)), -2, "4 sorts → -2");
  assert.strictEqual(
    structure(spells(["The Log", "Fireball", "Poison", "Rocket"]), cleanDeck([], 100)),
    -6,
    "5 sorts → -6",
  );

  // 3 win conditions → -4.
  assert.strictEqual(
    structure(cleanDeck([card("Hog Rider"), card("Miner"), card("Golem")]), cleanDeck([], 100)),
    -4,
    "3 win conditions → -4",
  );

  // Cumul au-delà de la borne : 0 anti-air (-4), 0 carte < 3 élixir (-4),
  // 6 sorts (-12) → -20, borné à -10.
  assert.strictEqual(
    structure(
      [card("Fireball"), card("Poison"), card("Rocket"), card("Lightning"), card("Arrows"), card("Barbarian Barrel"), ...filler(2)],
      cleanDeck([], 100),
    ),
    -10,
    "Le layer structure est borné à ±10",
  );
  console.log("✓ structure : Bait, gros DPS, carences, dispersion, borne ±10");
}

// ------------------------------------------------------------
// 6. Normalisation des noms : "P.E.K.K.A." et "P.E.K.K.A" doivent matcher
// ------------------------------------------------------------
{
  assert.strictEqual(
    normalizeCardName("P.E.K.K.A."),
    normalizeCardName("P.E.K.K.A"),
    "Le point final ne doit pas changer la normalisation",
  );
  assert.strictEqual(
    identifyWinConditions([card("P.E.K.K.A."), ...filler(7)], catalog).length,
    1,
    "P.E.K.K.A. (avec point final) doit être reconnu",
  );
  console.log("✓ normalisation des noms de cartes");
}

// ------------------------------------------------------------
// 7. Assemblage : base 50, convention scoreA = avantage du deck A,
//    symétrie et borne [5, 95].
// ------------------------------------------------------------
{
  const mirror = cleanDeck([card("Hog Rider")]);
  assert.strictEqual(
    computeDeckMatchupScore(mirror, cleanDeck([card("Hog Rider")], 100), catalog).scoreA,
    50,
    "Deux decks équivalents → 50",
  );

  // Hog hard-countered par Cannon → 0 ; Miner soft-countered par les
  // Skeletons du deck A → 2 ; counters = -2, sans carence ni dispersion
  // → scoreA = 48.
  const hogDeck = cleanDeck([card("Hog Rider")]);
  const minerDeck = cleanDeck([card("Miner"), card("Cannon")], 100);
  const { scoreA, scoreB, breakdown } = computeDeckMatchupScore(hogDeck, minerDeck, catalog);
  assert.strictEqual(scoreA, 48, `Deck A hard-countered → 48, obtenu ${scoreA}`);
  assert.strictEqual(scoreB, 52, "scoreB = 100 - scoreA");
  assert.deepStrictEqual(
    Object.keys(breakdown).sort(),
    ["counters", "evolutions", "level", "structure"],
    "Le breakdown expose les 4 layers",
  );
  assert.strictEqual(
    computeDeckMatchupScore(minerDeck, hogDeck, catalog).scoreA,
    52,
    "Inverser les decks inverse le score",
  );

  // Gros écart de niveau + évolutions : 50 + 40 + 9 dépasse 95.
  const strong = Array.from({ length: 8 }, (_, i) => card(`Strong${i}`, 16, "legendary", i < 3 ? 1 : 0));
  const weak = Array.from({ length: 8 }, (_, i) => card(`Weak${i}`, 1));
  assert.strictEqual(computeDeckMatchupScore(strong, weak, catalog).scoreA, 95, "scoreA est borné à 95");
  assert.strictEqual(computeDeckMatchupScore(weak, strong, catalog).scoreA, 5, "scoreA est borné à 5");
  console.log("✓ assemblage : base 50, symétrie, borne [5, 95]");
}

// ------------------------------------------------------------
// 8. Données réelles : pas de collision de noms normalisés dans le
//    catalogue, et borne du layer structure conforme à la doc.
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
  assert.ok(realCatalog.winConditionsByName.size > 0, "Le catalogue réel doit contenir des win conditions");
  assert.strictEqual(realCatalog.structureRules?.clamp, 10, "Le layer structure réel doit être borné à ±10");
  console.log("✓ catalogue réel : pas de collision, borne structure ±10");
}

console.log("All matchupEngine tests passed.");
