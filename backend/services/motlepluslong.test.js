import assert from "assert";
import {
  wordLetterCount,
  canonicalWordForm,
  filterEligiblePool,
  canFormFromBag,
  buildLetterBag,
  weightedRandomLetter,
  validateSubmission,
  computeScore,
  pickNextIndex,
  computeSeasonMancheTotal,
} from "./motlepluslong.js";

// PRNG déterministe (mulberry32) — seul moyen d'obtenir des tests
// reproductibles pour tout ce qui dépend d'un tirage aléatoire ici.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // wordLetterCount — accents et espaces ignorés
  assert.strictEqual(wordLetterCount("Bébé dragon"), 10);
  assert.strictEqual(wordLetterCount("Reine des Archères"), 16);
  assert.strictEqual(wordLetterCount("Arrows"), 6);
  // wordLetterCount — la ponctuation (points) ne compte pas non plus
  assert.strictEqual(wordLetterCount("P.E.K.K.A"), 5);
  assert.strictEqual(wordLetterCount("Mini P.E.K.K.A"), 9);

  // canonicalWordForm — forme affichée/archivée : que des lettres, aucune
  // ponctuation ni espace d'origine (pas de tuile pour ça dans le tirage)
  assert.strictEqual(canonicalWordForm("P.E.K.K.A"), "PEKKA");
  assert.strictEqual(canonicalWordForm("Mini P.E.K.K.A"), "MINIPEKKA");
  assert.strictEqual(canonicalWordForm("Bébé dragon"), "BEBEDRAGON");

  // filterEligiblePool — exclut apostrophe et > 12 lettres, garde le reste
  const sample = [
    { cardKey: "A", fr: "Barbares d'élite" }, // apostrophe -> exclue
    { cardKey: "B", fr: "Reine des Archères" }, // 16 lettres -> exclue
    { cardKey: "C", fr: "Bébé dragon" }, // 10 lettres -> incluse
    { cardKey: "D", fr: null }, // pas de nom FR -> exclue
    { cardKey: "E", fr: "abcdefghijkl" }, // 12 lettres pile -> incluse
  ];
  const eligible = filterEligiblePool(sample).map((c) => c.cardKey);
  assert.deepStrictEqual(eligible.sort(), ["C", "E"]);

  // canFormFromBag — respecte les doublons de lettres, pas seulement l'ensemble
  assert.strictEqual(canFormFromBag("as", ["A", "S", "X"]), true);
  assert.strictEqual(canFormFromBag("aa", ["A", "S", "X"]), false); // un seul "a" dans le sac
  assert.strictEqual(canFormFromBag("aa", ["A", "A", "S"]), true);
  assert.strictEqual(canFormFromBag("bébé dragon", "BEDRAGONBE".split("")), true); // espaces/accents ignorés

  // buildLetterBag — contient toujours les lettres du mot "seed", taille 12
  const rng = mulberry32(42);
  const bag = buildLetterBag("Bébé dragon", rng);
  assert.strictEqual(bag.length, 12);
  assert.strictEqual(canFormFromBag("Bébé dragon", bag), true);

  // weightedRandomLetter — toujours une lettre valide de la table
  const seenLetters = new Set();
  const rng2 = mulberry32(7);
  for (let i = 0; i < 200; i++) seenLetters.add(weightedRandomLetter(rng2));
  for (const letter of seenLetters) assert.match(letter, /^[a-z]$/);

  // validateSubmission — les 4 issues possibles
  const pool = [{ cardKey: "C", fr: "Bébé dragon" }];
  const fullList = [...pool, { cardKey: "A", fr: "Barbares d'élite" }];
  const draw = "BEDRAGONBE".split(""); // contient "bébé dragon"

  assert.strictEqual(validateSubmission(pool, fullList, draw, "bebe dragon").status, "ok");
  assert.strictEqual(validateSubmission(pool, fullList, draw, "bebe dragon").length, 10);
  assert.strictEqual(validateSubmission(pool, fullList, draw, "barbares d elite").status, "not-eligible");
  assert.strictEqual(validateSubmission(pool, fullList, draw, "n importe quoi").status, "invalid");
  // "Bébé dragon" reconnue mais ce tirage précis ne contient pas assez de lettres
  assert.strictEqual(validateSubmission(pool, fullList, ["B", "E", "X"], "bebe dragon").status, "impossible");

  // computeScore — trivial mais figé (pas de bonus caché)
  assert.strictEqual(computeScore(9), 9);

  // pickNextIndex — avance simplement, boucle à la fin
  assert.strictEqual(pickNextIndex(null, ["a", "b", "c"]), 0);
  assert.strictEqual(pickNextIndex({ currentIndex: 0 }, ["a", "b", "c"]), 1);
  assert.strictEqual(pickNextIndex({ currentIndex: 2 }, ["a", "b", "c"]), 0);

  // computeSeasonMancheTotal — wrapper simple autour de countRemainingWeekdayOccurrences
  assert.strictEqual(typeof computeSeasonMancheTotal(1, new Date("2026-07-11T13:00:00Z")), "number");

  console.log("✓ motlepluslong service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
