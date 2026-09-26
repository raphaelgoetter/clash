import assert from "assert";
import {
  rollDie,
  rollDice,
  rerollKept,
  computeBestCombination,
  resolveJour,
  buildRanking,
  withUsedCategory,
  formatBaremeLines,
  COMBINATIONS,
  isTooSoonSinceLastClosure,
} from "./gobelet.js";

function rngSequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function main() {
  // ── rollDie / rollDice — entier uniforme 1-6 ──
  assert.strictEqual(rollDie(rngSequence([0])), 1);
  assert.strictEqual(rollDie(rngSequence([0.99])), 6);
  assert.deepStrictEqual(rollDice(5, rngSequence([0, 0.2, 0.4, 0.6, 0.8])), [1, 2, 3, 4, 5]);
  for (let i = 0; i < 200; i++) {
    const d = rollDie(Math.random);
    assert.ok(d >= 1 && d <= 6);
  }

  // ── rerollKept — ne touche jamais aux dés conservés ──
  {
    const dice = [1, 2, 3, 4, 5];
    const kept = [true, false, true, false, true];
    const result = rerollKept(dice, kept, rngSequence([0.99, 0.99])); // -> 6, 6 pour les relancés
    assert.deepStrictEqual(result, [1, 6, 3, 6, 5]);
  }

  // ── computeBestCombination — chaque catégorie du barème ──
  // "Aucune combinaison" vaut 0 pt depuis la règle d'unicité (26/09).
  assert.deepStrictEqual(computeBestCombination([1, 2, 3, 5, 6]), { category: "Aucune combinaison", points: 0 });
  assert.deepStrictEqual(computeBestCombination([2, 2, 3, 4, 6]), { category: "Double quelconque", points: 10 });
  assert.deepStrictEqual(computeBestCombination([2, 2, 2, 3, 6]), { category: "Brelan", points: 20 });
  assert.deepStrictEqual(computeBestCombination([2, 4, 4, 6, 2]), { category: "Pairs", points: 35 });
  assert.deepStrictEqual(computeBestCombination([1, 3, 5, 5, 3]), { category: "Impairs", points: 35 });
  assert.deepStrictEqual(computeBestCombination([3, 3, 3, 3, 6]), { category: "Carré", points: 30 });
  assert.deepStrictEqual(computeBestCombination([3, 3, 3, 2, 2]), { category: "Full", points: 40 });
  assert.deepStrictEqual(computeBestCombination([1, 1, 1, 1, 2]), { category: "Somme ≤ 7", points: 45 }); // somme=6
  // Petite Suite (16/09, révisée) : 4 valeurs consécutives parmi les 5 dés
  // (pas forcément les 5 dés) — ici 1-2-3-4, le 6 ne prolonge pas la suite.
  assert.deepStrictEqual(computeBestCombination([1, 2, 3, 4, 6]), { category: "Petite Suite", points: 30 });
  // Autre suite de 4 possible : 3-4-5-6 (doublon sur 5, sans importance).
  assert.deepStrictEqual(computeBestCombination([3, 4, 5, 5, 6]), { category: "Petite Suite", points: 30 });
  assert.deepStrictEqual(computeBestCombination([6, 6, 6, 6, 6]), { category: "Gobelet", points: 60 });

  // ── Chevauchement — la catégorie la plus valorisée l'emporte, pas la
  // priorité de la liste ──
  // 6,6,6,6,5 : Carré (30) ET somme=29 >= 28 (45) -> on retient 45.
  assert.deepStrictEqual(computeBestCombination([6, 6, 6, 6, 5]), { category: "Somme ≥ 28", points: 45 });
  // 1,2,1,1,2 : Full (40) ET somme=7 <= 7 (45) -> on retient 45 (cas réel
  // signalé le 16/09, à l'origine de la révision du barème).
  assert.deepStrictEqual(computeBestCombination([1, 2, 1, 1, 2]), { category: "Somme ≤ 7", points: 45 });
  // 1,2,3,4,5 et 2,3,4,5,6 : 5 dés consécutifs -> Grande Suite (50) l'emporte
  // sur Petite Suite (30), qui matche aussi (contient bien une suite de 4).
  assert.deepStrictEqual(computeBestCombination([1, 2, 3, 4, 5]), { category: "Grande Suite", points: 50 });
  assert.deepStrictEqual(computeBestCombination([2, 3, 4, 5, 6]), { category: "Grande Suite", points: 50 });
  // Gobelet (60) bat toujours "Somme >= 28" (45) même si les deux matchent.
  assert.deepStrictEqual(computeBestCombination([6, 6, 6, 6, 6]).points, 60);
  // Une vraie combinaison l'emporte toujours, la somme brute ne compte plus :
  // 6,6,5,5,4 (somme 26) -> Double quelconque.
  assert.deepStrictEqual(computeBestCombination([6, 6, 5, 5, 4]), { category: "Double quelconque", points: 10 });
  // 4,4,4,2,2 : Full (40) ET 5 dés pairs (35) -> Full.
  assert.deepStrictEqual(computeBestCombination([4, 4, 4, 2, 2]), { category: "Full", points: 40 });
  // Régression (16/09, capture d'écran) : un Brelan de 6 (somme=22, plus
  // que les 20 pts du Brelan) doit rester étiqueté "Brelan", jamais "Aucune
  // combinaison" seulement parce que la somme brute serait plus élevée — la
  // somme n'est un candidat qu'en l'absence de toute vraie combinaison.
  assert.deepStrictEqual(computeBestCombination([6, 6, 3, 1, 6]), { category: "Brelan", points: 20 });

  // ── Unicité (26/09) — une combinaison déjà réalisée ne rapporte plus rien,
  // la meilleure combinaison encore libre est retenue à sa place ──
  {
    const dice = [6, 6, 6, 6, 6];
    const expected = [
      ["Gobelet", 60],
      ["Somme ≥ 28", 45],
      ["Pairs", 35],
      ["Carré", 30],
      ["Brelan", 20],
      ["Double quelconque", 10],
      ["Aucune combinaison", 0],
    ];
    let used = [];
    for (const [category, points] of expected) {
      const result = computeBestCombination(dice, used);
      assert.deepStrictEqual(result, { category, points });
      used = withUsedCategory(used, result.category);
    }
    // "Aucune combinaison" n'est jamais consommée
    assert.strictEqual(used.includes("Aucune combinaison"), false);
  }

  // ── withUsedCategory — pure, sans doublon ──
  {
    const used = ["Brelan"];
    assert.strictEqual(withUsedCategory(used, "Brelan"), used);
    assert.strictEqual(withUsedCategory(used, "Aucune combinaison"), used);
    assert.deepStrictEqual(withUsedCategory(used, "Full"), ["Brelan", "Full"]);
    assert.deepStrictEqual(used, ["Brelan"]);
  }

  // ── Barème — règles affichées par ordre croissant de valeur ──
  {
    const points = COMBINATIONS.map((c) => c.points);
    assert.deepStrictEqual(points, [...points].sort((a, b) => a - b));
    assert.strictEqual(formatBaremeLines().length, COMBINATIONS.length + 1);
    assert.ok(formatBaremeLines().includes("🎯 Double quelconque (2 dés identiques) : 10 pts"));
  }

  // ── resolveJour — une main figée à la clôture tient compte des combinaisons déjà réalisées ──
  {
    const results = resolveJour(
      { a: { dice: [6, 6, 6, 6, 6], status: "en_cours", category: null, points: null, username: "Alice" } },
      { a: ["Gobelet"] },
    );
    assert.deepStrictEqual([results[0].category, results[0].points], ["Somme ≥ 28", 45]);
  }

  // ── resolveJour — une main "en_cours" à la clôture est figée, jamais ignorée ──
  const hands = {
    a: { dice: [6, 6, 6, 6, 6], status: "en_cours", category: null, points: null, username: "Alice" },
    b: { dice: [1, 2, 3, 4, 6], status: "termine", category: "Petite Suite", points: 30, username: "Bob" },
  };
  const results = resolveJour(hands);
  const byId = Object.fromEntries(results.map((r) => [r.discordId, r]));
  assert.strictEqual(byId.a.category, "Gobelet"); // "en_cours" -> calculé à la clôture
  assert.strictEqual(byId.a.points, 60);
  assert.strictEqual(byId.b.category, "Petite Suite"); // déjà "termine" -> inchangée
  assert.strictEqual(byId.b.points, 30);

  // ── buildRanking — trié par points décroissants ──
  const ranking = buildRanking({ x: 20, y: 60, z: 0 });
  assert.deepStrictEqual(ranking.map((r) => r.discordId), ["y", "x", "z"]);

  // ── isTooSoonSinceLastClosure — garde-fou anti-double-avancée ──
  const now = Date.now();
  assert.strictEqual(isTooSoonSinceLastClosure(null, now), false);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(now - 1 * 3_600_000).toISOString(), now), true);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(now - 9 * 3_600_000).toISOString(), now), false);

  console.log("✓ gobelet service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
