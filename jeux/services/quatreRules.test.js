import assert from "assert";
import { creerDuel, poser, choixKevina, alignementsDepuis, HAUTEUR } from "./quatreRules.js";

// Grille de test : une chaîne par colonne, du bas vers le haut
// (J = joueur, B = bot), ex. ["JB", "", …].
function duelTest(colonnes, actif = "joueur") {
  const d = creerDuel({ commence: actif });
  d.colonnes = colonnes.map((s) => [...s].map((x) => (x === "J" ? "joueur" : "bot")));
  return d;
}

const vide = () => ["", "", "", "", "", "", ""];
const sansHasard = () => 0;

function main() {
  // ── Pose : le pion tombe en bas, tour adverse ──
  {
    const d = duelTest(["J", "", "", "", "", "", ""]);
    const r = poser(d, "joueur", 0);
    assert.deepStrictEqual(r, { colonne: 0, rangee: 1, victoire: false });
    assert.deepStrictEqual(d.dernier, { id: "joueur", colonne: 0, rangee: 1 });
    assert.strictEqual(d.actif, "bot");
    assert.strictEqual(d.coups, 1);
  }

  // ── Refus : pas son tour, colonne pleine, colonne inconnue ──
  {
    const d = duelTest(["JBJBJB", "", "", "", "", "", ""]);
    assert.ok(poser(d, "bot", 1).erreur);
    assert.ok(poser(d, "joueur", 0).erreur);
    assert.ok(poser(d, "joueur", 7).erreur);
    assert.strictEqual(d.colonnes[0].length, HAUTEUR);
  }

  // ── Victoire : horizontale, verticale, diagonale ──
  {
    const d = duelTest(["J", "J", "J", "", "", "", ""]);
    const r = poser(d, "joueur", 3);
    assert.strictEqual(r.victoire, true);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "joueur");
    assert.strictEqual(d.alignement.length, 4);
    assert.ok(poser(d, "bot", 4).erreur);
  }
  {
    const d = duelTest(["", "", "BBB", "", "", "", ""], "bot");
    poser(d, "bot", 2);
    assert.strictEqual(d.gagnant, "bot");
  }
  {
    // Diagonale montante (0,0) (1,1) (2,2) (3,3)
    const d = duelTest(["J", "BJ", "BBJ", "BBB", "", "", ""]);
    poser(d, "joueur", 3);
    assert.strictEqual(d.gagnant, "joueur");
    assert.deepStrictEqual(
      [...d.alignement].sort((a, b) => a[0] - b[0]),
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );
  }
  {
    // Alignement de 5 et croix : toutes les cases gagnantes, sans doublon
    const d = duelTest(["J", "J", "", "J", "J", "", ""]);
    poser(d, "joueur", 2);
    assert.strictEqual(d.alignement.length, 5);
    assert.deepStrictEqual(alignementsDepuis(d.colonnes, 6, 0), []);
  }

  // ── Grille pleine sans alignement : match nul ──
  {
    // Motif sans 4 alignés, dernière case libre en haut à droite
    const motif = ["JJBBJJ", "BBJJBB", "JJBBJJ", "BBJJBB", "JJBBJJ", "BBJJBB", "JJBBJ"];
    const d = duelTest(motif, "bot");
    poser(d, "bot", 6);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "nul");
    assert.strictEqual(d.alignement, null);
  }

  // ── Kévina : gagne dès qu'elle peut, bloque, voit l'alignement ouvert ──
  {
    const d = duelTest(["J", "BJ", "J", "BBB", "J", "", ""], "bot");
    assert.strictEqual(choixKevina(d, "bot", { rng: sansHasard }), 3);
  }
  {
    // Le joueur menace la colonne 3 en bas : bloquer
    const d = duelTest(["J", "J", "J", "", "B", "B", ""], "bot");
    assert.strictEqual(choixKevina(d, "bot", { rng: sansHasard }), 3);
  }
  {
    // _ _ J J _ _ _ en bas : laisser jouer 1 ou 4 donne un 3 ouvert
    // imparable, Kévina doit occuper une des deux cases
    const d = duelTest(["", "", "J", "J", "", "", "B"], "bot");
    assert.ok([1, 4].includes(choixKevina(d, "bot", { rng: sansHasard })));
  }
  {
    // Ne jamais offrir la victoire : le joueur menace (2, 2) (J J _ J sur
    // la rangée 2), jouer en colonne 2 lui donnerait le pion d'appui
    const d = duelTest(["BJJ", "JBJ", "B", "BJJ", "", "", ""], "bot");
    for (let i = 0; i < 5; i++) assert.notStrictEqual(choixKevina(d, "bot"), 2);
  }

  // ── Variété d'ouverture : marge dans les premiers coups seulement ──
  {
    const reponses = (opts) => {
      const vues = new Set();
      for (let i = 0; i < 40; i++) {
        const d = duelTest(["", "", "", "J", "", "", ""], "bot");
        d.coups = 1;
        vues.add(choixKevina(d, "bot", opts));
      }
      return vues;
    };
    assert.deepStrictEqual([...reponses({ marge: 0 })], [3]);
    assert.ok(reponses({ marge: 6, ouverture: 6 }).size > 1);
    assert.deepStrictEqual([...reponses({ marge: 6, ouverture: 1 })], [3]);
  }
  {
    // Marge sans effet quand une défaite est en vue : toujours bloquer
    const d = duelTest(["J", "J", "J", "", "B", "B", ""], "bot");
    for (let i = 0; i < 10; i++) assert.strictEqual(choixKevina(d, "bot", { marge: 50, ouverture: 99 }), 3);
  }

  console.log("quatreRules : OK");
}

main();
