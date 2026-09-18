import assert from "assert";
import {
  DRAW_SIZE,
  wordLetterCount,
  canonicalWordForm,
  filterEligiblePool,
  canFormFromBag,
  buildLetterBag,
  buildLetterBagFromSeeds,
  pickCompatibleSecondarySeed,
  weightedRandomLetter,
  computeValidWordsForDraw,
  validateSubmission,
  computeScore,
  pickNextIndex,
  computeSeasonMancheTotal,
} from "./pelemele.js";

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

  // filterEligiblePool — exclut apostrophe et > DRAW_SIZE lettres, garde le
  // reste. Fixture E générée depuis DRAW_SIZE (pas figée en dur) pour tester
  // la vraie limite actuelle sans se déphaser si DRAW_SIZE change encore.
  const boundaryWord = "abcdefghijklmnopqrstuvwxyz".slice(0, DRAW_SIZE);
  assert.strictEqual(boundaryWord.length, DRAW_SIZE);
  const sample = [
    { cardKey: "A", fr: "Barbares d'élite" }, // apostrophe -> exclue
    { cardKey: "B", fr: "Reine des Archères" }, // 16 lettres -> exclue (toujours > DRAW_SIZE)
    { cardKey: "C", fr: "Bébé dragon" }, // 10 lettres -> incluse
    { cardKey: "D", fr: null }, // pas de nom FR -> exclue
    { cardKey: "E", fr: boundaryWord }, // DRAW_SIZE lettres pile -> incluse
  ];
  const eligible = filterEligiblePool(sample).map((c) => c.cardKey);
  assert.deepStrictEqual(eligible.sort(), ["C", "E"]);

  // canFormFromBag — respecte les doublons de lettres, pas seulement l'ensemble
  assert.strictEqual(canFormFromBag("as", ["A", "S", "X"]), true);
  assert.strictEqual(canFormFromBag("aa", ["A", "S", "X"]), false); // un seul "a" dans le sac
  assert.strictEqual(canFormFromBag("aa", ["A", "A", "S"]), true);
  assert.strictEqual(canFormFromBag("bébé dragon", "BEDRAGONBE".split("")), true); // espaces/accents ignorés

  // buildLetterBag — contient toujours les lettres du mot "seed", taille DRAW_SIZE
  const rng = mulberry32(42);
  const bag = buildLetterBag("Bébé dragon", rng);
  assert.strictEqual(bag.length, DRAW_SIZE);
  assert.strictEqual(canFormFromBag("Bébé dragon", bag), true);

  // buildLetterBagFromSeeds — UNION des lettres (pas la somme) : "as" + "sa"
  // partagent déjà leurs lettres, donc 2 lettres suffisent, pas 4.
  const unionBag = buildLetterBagFromSeeds(["as", "sa"], mulberry32(1), 2);
  assert.strictEqual(unionBag.length, 2);
  assert.strictEqual(canFormFromBag("as", unionBag), true);
  assert.strictEqual(canFormFromBag("sa", unionBag), true);
  // les deux mots-seed tiennent simultanément dans un tirage à taille normale
  const twoSeedBag = buildLetterBagFromSeeds(["Gel", "Golem"], mulberry32(2));
  assert.strictEqual(canFormFromBag("Gel", twoSeedBag), true);
  assert.strictEqual(canFormFromBag("Golem", twoSeedBag), true);

  // pickCompatibleSecondarySeed — jamais la carte principale elle-même,
  // toujours une carte dont les lettres tiennent avec la principale
  const miniPool = [
    { cardKey: "A", fr: "Gel" },
    { cardKey: "B", fr: "Golem" },
    { cardKey: "C", fr: "Rage" },
  ];
  const secondary = pickCompatibleSecondarySeed(miniPool, miniPool[0], mulberry32(3));
  assert.notStrictEqual(secondary?.cardKey, "A");
  assert.ok(["B", "C"].includes(secondary?.cardKey));
  // aucune carte compatible disponible (pool à une seule carte) -> null, pas d'erreur
  assert.strictEqual(pickCompatibleSecondarySeed([miniPool[0]], miniPool[0], mulberry32(3)), null);

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

  // computeValidWordsForDraw — toutes les cartes du pool qui rentrent dans
  // ce tirage précis, triées par longueur décroissante
  const wordsPool = [
    { cardKey: "C", fr: "Bébé dragon" }, // 10 lettres, rentre
    { cardKey: "F", fr: "Gel" }, // 3 lettres, rentre (sous-ensemble)
    { cardKey: "G", fr: "Golem" }, // ne rentre pas (pas de L/M en trop dans ce tirage)
  ];
  const validWords = computeValidWordsForDraw(wordsPool, "BEDRAGONBEGEL".split(""));
  assert.deepStrictEqual(
    validWords.map((w) => w.cardKey),
    ["C", "F"],
  );
  assert.strictEqual(validWords[0].length, 10);

  // computeScore — barème fixe : LONGEST_WORD_BONUS (5) si le mot égale la
  // longueur max du tirage, EXTRA_WORD_POINTS (1) sinon — jamais proportionnel
  // à la longueur elle-même (indépendant de DRAW_SIZE, décision explicite).
  assert.strictEqual(computeScore(10, 10), 5); // mot le plus long du tirage
  assert.strictEqual(computeScore(3, 10), 1); // mot valide mais pas le plus long
  assert.strictEqual(computeScore(10, 10) === computeScore(3, 10), false);

  // pickNextIndex — avance simplement, boucle à la fin
  assert.strictEqual(pickNextIndex(null, ["a", "b", "c"]), 0);
  assert.strictEqual(pickNextIndex({ currentIndex: 0 }, ["a", "b", "c"]), 1);
  assert.strictEqual(pickNextIndex({ currentIndex: 2 }, ["a", "b", "c"]), 0);

  // computeSeasonMancheTotal — wrapper simple autour de countRemainingWeekdayOccurrences
  assert.strictEqual(typeof computeSeasonMancheTotal(1, new Date("2026-07-11T13:00:00Z")), "number");

  console.log("✓ pelemele service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
