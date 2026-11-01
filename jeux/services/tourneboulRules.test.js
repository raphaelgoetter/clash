import assert from "assert";
import {
  creerDuel,
  poser,
  retournements,
  resultat,
  casesLibres,
  casesJouables,
  choixKevina,
  evaluer,
  DEPART,
  NB_CASES,
  ROC,
} from "./tourneboulRules.js";

// Grille de test : 5 chaînes de 5 caractères (J joueur, B bot, R rocher,
// . vide)
const grilleDe = (lignes) =>
  lignes.join("").split("").map((x) => ({ J: "joueur", B: "bot", R: "roc", ".": null })[x]);

function main() {
  // ── Mise en place : centre bloqué, un pion chacun à côté du centre, 22 cases libres ──
  {
    const d = creerDuel();
    assert.strictEqual(d.grille[ROC], "roc");
    assert.deepStrictEqual([d.grille[DEPART.joueur], d.grille[DEPART.bot]], ["joueur", "bot"]);
    assert.deepStrictEqual([DEPART.joueur, DEPART.bot], [7, 17]);
    assert.strictEqual(casesLibres(d.grille).length, NB_CASES - 3);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Cases jouables : voisines (côté ou coin) d'un pion ou du rocher ──
  {
    const d = creerDuel();
    const jouables = casesJouables(d.grille);
    // Les coins ne sont pas jouables au départ
    for (const coin of [0, 4, 20, 24]) assert.ok(!jouables.includes(coin));
    assert.ok(jouables.includes(1) && jouables.includes(11));
    assert.ok(poser(d, "joueur", 0).erreur);
    assert.strictEqual(d.coups, 0);
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
    // J en 6 : aucune ligne encadrée
    assert.deepStrictEqual(retournements(g, 6, "joueur"), []);
    // Le rocher coupe une diagonale : J en 0, B en 6, J posé en 18 → rien
    assert.deepStrictEqual(retournements(grilleDe(["J....", ".B...", "..R..", ".....", "....."]), 18, "joueur"), []);
    // Diagonale : J en 1, B en 7, J posé en 13 → 7 est encadré (1 → 7 → 13)
    assert.deepStrictEqual(retournements(grilleDe([".J...", "..B..", "..R.J", ".....", "....."]), 13, "joueur"), [7]);
    // Le rocher ferme une ligne sans encadrer
    assert.deepStrictEqual(retournements(grilleDe(["..B..", "..B..", "..R..", ".....", "....."]), 7 - 5, "joueur"), []);
  }

  // ── Poser : retournement appliqué, tour adverse, vue +1 ──
  {
    const d = creerDuel();
    d.grille = grilleDe(["JB...", ".....", "..R..", ".....", "....."]);
    const r = poser(d, "joueur", 2); // voisine du B en 1
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

  // ── Partie complète : 22 coups, puis fin ──
  {
    const d = creerDuel();
    while (!d.termine) poser(d, d.actif, casesJouables(d.grille)[0]);
    assert.strictEqual(d.coups, NB_CASES - 3);
    assert.ok(["joueur", "bot", "nul"].includes(d.gagnant));
  }

  // ── Kévina : prend le retournement le plus gros ──
  {
    const d = creerDuel({ commence: "bot" });
    d.grille = grilleDe(["BJJJ.", ".....", "..R..", ".....", "....."]);
    assert.strictEqual(choixKevina(d, "bot", { profondeur: 1 }), 4);
  }

  // ── Évaluation positionnelle : coin 8, bord 2, intérieur 1, pion voisin
  // d'un coin vide −4 ──
  {
    const g = grilleDe(["J....", ".....", "..R..", ".....", "....."]);
    assert.strictEqual(evaluer(g, "joueur"), 8);
    assert.strictEqual(evaluer(g, "bot"), -8);
    const g2 = grilleDe([".J...", ".....", "..R..", ".....", "....."]);
    assert.strictEqual(evaluer(g2, "joueur"), 2 - 4);
    const g3 = grilleDe([".....", ".....", "..R..", "...J.", "....."]);
    assert.strictEqual(evaluer(g3, "joueur"), 1 - 4);
  }

  // ── Kévina ne donne pas un coin : à profondeur 2, elle évite la case qui
  // ouvre un coin à l'adversaire ──
  {
    const d = creerDuel({ commence: "bot" });
    d.grille = grilleDe([".....", "..J..", "..R..", "..B..", "....."]);
    for (let k = 0; k < 20; k++) assert.ok(![6, 8, 16, 18].includes(choixKevina(d, "bot", { profondeur: 2 })));
  }
}

main();
console.log("tourneboulRules.test.js OK");
