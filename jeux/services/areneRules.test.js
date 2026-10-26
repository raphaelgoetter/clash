import assert from "assert";
import { creerDuel, poser, scoreColonne, scoreGrille, choixGlouton } from "./areneRules.js";

// Dé suivant imposé (le rng ne sert qu'au lancer)
const de = (v) => () => (v - 1) / 6;

function duelTest(joueur, bot, valeur, actif = "joueur") {
  const d = creerDuel({ commence: actif, rng: de(1) });
  d.grilles.joueur = joueur.map((c) => [...c]);
  d.grilles.bot = bot.map((c) => [...c]);
  d.de = valeur;
  return d;
}

function main() {
  // ── Score : valeur × n × n par valeur ──
  assert.strictEqual(scoreColonne([4, 4]), 16);
  assert.strictEqual(scoreColonne([3, 3, 3]), 27);
  assert.strictEqual(scoreColonne([2, 5, 2]), 13);
  assert.strictEqual(scoreColonne([]), 0);
  assert.strictEqual(scoreGrille([[6], [1, 1], [2, 3, 4]]), 6 + 4 + 9);

  // ── Pose : détruit tous les dés de même valeur dans la colonne d'en face ──
  {
    const d = duelTest([[], [], []], [[], [5, 2, 5], []], 5);
    const r = poser(d, "joueur", 1, { rng: de(3) });
    assert.deepStrictEqual(d.grilles.joueur[1], [5]);
    assert.deepStrictEqual(d.grilles.bot[1], [2]);
    assert.strictEqual(r.pointsDetruits, 22 - 2);
    assert.strictEqual(r.desDetruits, 2);
    assert.strictEqual(d.actif, "bot");
    assert.strictEqual(d.de, 3);
  }

  // ── Refus : pas son tour, colonne pleine ──
  {
    const d = duelTest([[1, 2, 3], [], []], [[], [], []], 4);
    assert.ok(poser(d, "bot", 1).erreur);
    assert.ok(poser(d, "joueur", 0).erreur);
    assert.ok(poser(d, "joueur", 3).erreur);
  }

  // ── Fin dès qu'une grille est pleine, plus haut total gagnant ──
  {
    const d = duelTest([[6, 6, 6], [6, 6, 6], [6, 6]], [[1], [], []], 6);
    poser(d, "joueur", 2);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "joueur");
    assert.strictEqual(d.de, null);
    assert.ok(poser(d, "bot", 1).erreur);
  }
  {
    const d = duelTest([[1, 2, 3], [1, 2, 3], [1, 2]], [[6, 6], [], []], 4);
    poser(d, "joueur", 2);
    assert.strictEqual(d.gagnant, "bot");
  }
  // ── Kévina : gain + destruction, puis colonne la moins remplie ──
  {
    // Empiler 4-4-4 (+20) bat détruire un 4 adverse (+4 +4)
    const d = duelTest([[], [], [4]], [[4, 4], [], []], 4, "bot");
    assert.strictEqual(choixGlouton(d, "bot"), 0);
    // Détruire 4-4 adverse (+4 +16) bat poser seul (+4)
    d.grilles.bot = [[], [], []];
    d.grilles.joueur = [[], [], [4, 4]];
    assert.strictEqual(choixGlouton(d, "bot"), 2);
  }
  {
    // Égalité de valeur : la colonne la moins remplie
    const d = duelTest([[], [], []], [[1, 2], [3], [5, 6]], 4, "bot");
    assert.strictEqual(choixGlouton(d, "bot"), 1);
  }

  console.log("areneRules : OK");
}

main();
