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
  generateDraw,
  loadEligiblePool,
  MIN_VALID_WORDS,
  MAX_VALID_WORDS,
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
  // wordLetterCount — accents, espaces et ponctuation ignorés
  assert.strictEqual(wordLetterCount("Salamèche"), 9);
  assert.strictEqual(wordLetterCount("Dracaufeu"), 9);
  assert.strictEqual(wordLetterCount("M. Mime"), 5);

  // canonicalWordForm — forme affichée/archivée : que des lettres, aucune
  // ponctuation ni espace d'origine (pas de tuile pour ça dans le tirage)
  assert.strictEqual(canonicalWordForm("M. Mime"), "MMIME");
  assert.strictEqual(canonicalWordForm("Électhor"), "ELECTHOR");

  // filterEligiblePool — exclut apostrophe et > DRAW_SIZE lettres, garde le
  // reste. Fixture E générée depuis DRAW_SIZE (pas figée en dur) pour tester
  // la vraie limite actuelle sans se déphaser si DRAW_SIZE change encore.
  const boundaryWord = "abcdefghijklmnopqrstuvwxyz".slice(0, DRAW_SIZE);
  assert.strictEqual(boundaryWord.length, DRAW_SIZE);
  const sample = [
    { key: "A", fr: "Canarticho d'or" }, // apostrophe -> exclue
    { key: "B", fr: "Papilusion Florizarre" }, // 20 lettres -> exclue (toujours > DRAW_SIZE)
    { key: "C", fr: "Dracaufeu" }, // 9 lettres -> incluse
    { key: "D", fr: null }, // pas de nom FR -> exclue
    { key: "E", fr: boundaryWord }, // DRAW_SIZE lettres pile -> incluse
  ];
  const eligible = filterEligiblePool(sample).map((c) => c.key);
  assert.deepStrictEqual(eligible.sort(), ["C", "E"]);

  // canFormFromBag — respecte les doublons de lettres, pas seulement l'ensemble
  assert.strictEqual(canFormFromBag("as", ["A", "S", "X"]), true);
  assert.strictEqual(canFormFromBag("aa", ["A", "S", "X"]), false); // un seul "a" dans le sac
  assert.strictEqual(canFormFromBag("aa", ["A", "A", "S"]), true);
  assert.strictEqual(canFormFromBag("M. Mime", "MMIEM".split("")), true); // ponctuation/espaces ignorés
  assert.strictEqual(canFormFromBag("salamèche", "SALAMECHE".split("")), true); // accents ignorés

  // buildLetterBag — contient toujours les lettres du mot "seed", taille DRAW_SIZE
  const rng = mulberry32(42);
  const bag = buildLetterBag("Dracaufeu", rng);
  assert.strictEqual(bag.length, DRAW_SIZE);
  assert.strictEqual(canFormFromBag("Dracaufeu", bag), true);

  // buildLetterBagFromSeeds — UNION des lettres (pas la somme) : "as" + "sa"
  // partagent déjà leurs lettres, donc 2 lettres suffisent, pas 4.
  const unionBag = buildLetterBagFromSeeds(["as", "sa"], mulberry32(1), 2);
  assert.strictEqual(unionBag.length, 2);
  assert.strictEqual(canFormFromBag("as", unionBag), true);
  assert.strictEqual(canFormFromBag("sa", unionBag), true);
  // les deux mots-seed tiennent simultanément dans un tirage à taille normale
  const twoSeedBag = buildLetterBagFromSeeds(["Onix", "Ponyta"], mulberry32(2));
  assert.strictEqual(canFormFromBag("Onix", twoSeedBag), true);
  assert.strictEqual(canFormFromBag("Ponyta", twoSeedBag), true);

  // pickCompatibleSecondarySeed — jamais le nom principal lui-même,
  // toujours un nom dont les lettres tiennent avec le principal
  const miniPool = [
    { key: "A", fr: "Abo" },
    { key: "B", fr: "Onix" },
    { key: "C", fr: "Mew" },
  ];
  const secondary = pickCompatibleSecondarySeed(miniPool, miniPool[0], mulberry32(3));
  assert.notStrictEqual(secondary?.key, "A");
  assert.ok(["B", "C"].includes(secondary?.key));
  // aucun nom compatible disponible (pool à un seul nom) -> null, pas d'erreur
  assert.strictEqual(pickCompatibleSecondarySeed([miniPool[0]], miniPool[0], mulberry32(3)), null);

  // generateDraw — aucun tirage dans la fourchette possible : garde le plus
  // proche, sans erreur
  const lonelyDraw = generateDraw([miniPool[0]], miniPool[0], mulberry32(4), 5);
  assert.strictEqual(lonelyDraw.validWords.length, 1);
  assert.strictEqual(canFormFromBag("Abo", lonelyDraw.letters), true);

  // Vrai pool : les 151 Pokémon de 1re génération, Nidoran♀/♂ fusionnés,
  // tous éligibles ; chaque nom principal tombe dans la fourchette
  const realPool = await loadEligiblePool();
  assert.strictEqual(realPool.length, 150);
  assert.strictEqual(new Set(realPool.map((c) => canonicalWordForm(c.fr))).size, 150);
  const rngReal = mulberry32(11);
  for (const entry of realPool) {
    const { letters, validWords } = generateDraw(realPool, entry, rngReal);
    assert.strictEqual(canFormFromBag(entry.fr, letters), true);
    assert.ok(validWords.length >= MIN_VALID_WORDS && validWords.length <= MAX_VALID_WORDS, `${entry.fr} : ${validWords.length} mots`);
  }

  // weightedRandomLetter — toujours une lettre valide de la table
  const seenLetters = new Set();
  const rng2 = mulberry32(7);
  for (let i = 0; i < 200; i++) seenLetters.add(weightedRandomLetter(rng2));
  for (const letter of seenLetters) assert.match(letter, /^[a-z]$/);

  // validateSubmission — les 4 issues possibles
  const pool = [
    { key: "006", fr: "Dracaufeu" },
    { key: "122", fr: "M. Mime", accept: ["Mr. Mime"] },
  ];
  const fullList = [...pool, { key: "X", fr: "Canarticho d'or" }];
  const draw = "DRACAUFEUMMIEM".split(""); // contient "Dracaufeu" et "M. Mime"

  assert.strictEqual(validateSubmission(pool, fullList, draw, "dracaufeu").status, "ok");
  assert.strictEqual(validateSubmission(pool, fullList, draw, "dracaufeu").length, 9);
  assert.strictEqual(validateSubmission(pool, fullList, draw, "canarticho d or").status, "not-eligible");
  assert.strictEqual(validateSubmission(pool, fullList, draw, "n importe quoi").status, "invalid");
  // variante acceptée et repli sans espaces, lettres comptées sur le nom officiel
  assert.strictEqual(validateSubmission(pool, fullList, draw, "Mr Mime").entry.key, "122");
  assert.strictEqual(validateSubmission(pool, fullList, draw, "MMime").length, 5);
  // "Dracaufeu" reconnu mais ce tirage précis ne contient pas assez de lettres
  assert.strictEqual(validateSubmission(pool, fullList, ["D", "R", "X"], "dracaufeu").status, "impossible");

  // computeValidWordsForDraw — tous les noms du pool qui rentrent dans
  // ce tirage précis, triés par longueur décroissante
  const wordsPool = [
    { key: "C", fr: "Dracaufeu" }, // 9 lettres, rentre
    { key: "F", fr: "Draco" }, // 5 lettres, rentre (sous-ensemble)
    { key: "G", fr: "Onix" }, // ne rentre pas (ni N, ni I, ni X)
  ];
  const validWords = computeValidWordsForDraw(wordsPool, "DRACAUFEUTOS".split(""));
  assert.deepStrictEqual(
    validWords.map((w) => w.key),
    ["C", "F"],
  );
  assert.strictEqual(validWords[0].length, 9);

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
