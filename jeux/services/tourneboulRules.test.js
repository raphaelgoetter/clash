import assert from "assert";
import {
  creerDuel,
  poser,
  retournements,
  resultat,
  casesLibres,
  choixKevina,
  NB_CASES,
  ROC,
} from "./tourneboulRules.js";

// Grille de test : 5 chaînes de 5 caractères (J joueur, B bot, R rocher,
// . vide)
const grilleDe = (lignes) =>
  lignes.join("").split("").map((x) => ({ J: "joueur", B: "bot", R: "roc", ".": null })[x]);

function main() {
  // ── Mise en place : plateau vide, centre bloqué, 24 cases libres ──
  {
    const d = creerDuel();
    assert.strictEqual(d.grille[ROC], "roc");
    assert.strictEqual(casesLibres(d.grille).length, NB_CASES - 1);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Retournements : lignes orthogonales encadrées, pas en diagonale ──
  {
    const g = grilleDe([
      "JBB..",
      ".....",
      "B.R..",
      "J....",
      ".B...",
    ]);
    // J en 3 (ligne 0) : encadre B B (cases 1 et 2) avec J en 0
    assert.deepStrictEqual(retournements([...g.slice(0, 3), "joueur", ...g.slice(4)], 3, "joueur"), [2, 1]);
    // J en 5 (ligne 1, colonne 0) : encadre B (case 10) avec J en 15
    assert.deepStrictEqual(retournements(g, 5, "joueur"), [10]);
    // Pas de diagonale : J en 6 n'encadre rien
    assert.deepStrictEqual(retournements(g, 6, "joueur"), []);
    // Le rocher ferme une ligne sans encadrer
    assert.deepStrictEqual(retournements(grilleDe(["..B..", "..B..", "..R..", ".....", "....."]), 7 - 5, "joueur"), []);
  }

  // ── Poser : retournement appliqué, tour adverse, vue +1 ──
  {
    const d = creerDuel();
    d.grille = grilleDe(["JB...", ".....", "..R..", ".....", "....."]);
    const r = poser(d, "joueur", 2);
    assert.deepStrictEqual(r, { case: 2, retournes: [1] });
    assert.deepStrictEqual(d.grille.slice(0, 3), ["joueur", "joueur", "joueur"]);
    assert.deepStrictEqual([d.actif, d.vue, d.dernierRetournement], ["bot", 1, "joueur"]);
    assert.ok(poser(d, "bot", 2).erreur); // case prise
    assert.ok(poser(d, "joueur", 3).erreur); // pas son tour
    assert.ok(poser(d, "bot", ROC).erreur); // rocher
  }

  // ── Fin : majorité, puis coins, puis dernier retournement ──
  {
    const pleine = (lignes) => grilleDe(lignes);
    assert.deepStrictEqual(resultat(pleine(["JJJJJ", "JJJJJ", "JJRJB", "BBBBB", "BBBBB"]), null), { gagnant: "joueur", fin: "majorite" });
    // 12 partout : coins (J en a 3)
    assert.deepStrictEqual(resultat(pleine(["JBBBJ", "BBBBB", "BJRJB", "JJJJJ", "JJBJB"]), "bot").gagnant, "joueur");
    // 12 partout, 2 coins chacun : dernier retournement
    assert.deepStrictEqual(resultat(pleine(["JJJJB", "JJJJJ", "JJRBB", "BBBBB", "BBBBJ"]), "bot"), { gagnant: "bot", fin: "retournement" });
    assert.deepStrictEqual(resultat(pleine(["JJJJB", "JJJJJ", "JJRBB", "BBBBB", "BBBBJ"]), null), { gagnant: "nul", fin: "nul" });
  }

  // ── Partie complète : 24 coups, puis fin ──
  {
    const d = creerDuel();
    while (!d.termine) poser(d, d.actif, casesLibres(d.grille)[0]);
    assert.strictEqual(d.coups, NB_CASES - 1);
    assert.ok(["joueur", "bot", "nul"].includes(d.gagnant));
  }

  // ── Kévina : prend le retournement le plus gros ──
  {
    const d = creerDuel({ commence: "bot" });
    d.grille = grilleDe(["BJJJ.", ".....", "..R..", ".....", "....."]);
    assert.strictEqual(choixKevina(d, "bot", { profondeur: 1 }), 4);
  }
}

main();
console.log("tourneboulRules.test.js OK");
