import assert from "assert";
import {
  creerDuel,
  poser,
  casesJouables,
  choixKevina,
  alignementsDepuis,
  CENTRE,
  NB_CASES,
} from "./puntoRules.js";

// Grille de test : 5 chaînes de 5 cases, une case = 2 caractères
// (J/B = siège, puis valeur ; ".." = vide), couleur 0 par défaut ;
// `couleurs` : { case: k } pour les cartes de couleur 1.
function duelTest(lignes, { actif = "joueur", carte = { k: 0, v: 5 }, couleurs = {}, pioches = null } = {}) {
  const d = creerDuel({ commence: actif, rng: () => 0 });
  d.grille = lignes.flatMap((l, r) =>
    Array.from({ length: 5 }, (_, c) => {
      const x = l.slice(2 * c, 2 * c + 2);
      const i = r * 5 + c;
      return x === ".." ? null : { s: x[0] === "J" ? "joueur" : "bot", k: couleurs[i] ?? 0, v: Number(x[1]) };
    }),
  );
  d.actif = actif;
  d.carte = carte;
  if (pioches) d.pioches = pioches;
  return d;
}

const vide = [".........."];
const grilleVide = () => Array(5).fill(vide[0]);
const sansHasard = () => 0;

function main() {
  // ── Pioches : 36 cartes par joueur, 2 couleurs × 1 à 9 en double ──
  {
    const d = creerDuel();
    assert.strictEqual(d.pioches.joueur.length + 1, 36);
    assert.strictEqual(d.pioches.bot.length, 36);
    assert.strictEqual(d.actif, "joueur");
    assert.ok(d.carte);
    const toutes = [...d.pioches.bot].map((c) => `${c.k}${c.v}`).sort();
    assert.strictEqual(new Set(toutes).size, 18);
  }

  // ── Première carte : au centre seulement ──
  {
    const d = creerDuel();
    assert.deepStrictEqual(casesJouables(d.grille, d.carte), [CENTRE]);
    assert.ok(poser(d, "joueur", 0).erreur);
    const r = poser(d, "joueur", CENTRE);
    assert.strictEqual(r.victoire, false);
    assert.strictEqual(d.actif, "bot");
    assert.strictEqual(d.coups, 1);
    assert.ok(d.carte);
    assert.strictEqual(d.dernier.case, CENTRE);
  }

  // ── Cases jouables : vides voisines (coins compris), ou carte plus faible ──
  {
    const lignes = grilleVide();
    lignes[2] = "....J5....";
    const d = duelTest(lignes, { carte: { k: 0, v: 5 } });
    // Les 8 voisines du centre, pas le centre (5 n'est pas < 5)
    assert.deepStrictEqual(casesJouables(d.grille, d.carte), [6, 7, 8, 11, 13, 16, 17, 18]);
    assert.ok(casesJouables(d.grille, { k: 0, v: 6 }).includes(CENTRE));
    assert.ok(poser(d, "joueur", 0).erreur);
    assert.ok(poser(d, "bot", 6).erreur);
  }
  {
    // Recouvrir une carte adverse plus faible : la carte du dessus change de camp
    const lignes = grilleVide();
    lignes[2] = "....B3....";
    const d = duelTest(lignes, { carte: { k: 1, v: 4 } });
    const r = poser(d, "joueur", CENTRE);
    assert.deepStrictEqual(r.recouverte, { s: "bot", k: 0, v: 3 });
    assert.deepStrictEqual(d.grille[CENTRE], { s: "joueur", k: 1, v: 4 });
  }

  // ── Victoire : 4 cartes de la même couleur du même joueur ──
  {
    const lignes = grilleVide();
    lignes[1] = "J1J2J3....";
    const d = duelTest(lignes, { carte: { k: 0, v: 9 } });
    const r = poser(d, "joueur", 8);
    assert.strictEqual(r.victoire, true);
    assert.strictEqual(d.gagnant, "joueur");
    assert.deepStrictEqual([...d.alignement].sort((a, b) => a - b), [5, 6, 7, 8]);
    assert.ok(poser(d, "bot", 9).erreur);
  }
  {
    // Même joueur mais autre couleur : pas d'alignement
    const lignes = grilleVide();
    lignes[1] = "J1J2J3....";
    const d = duelTest(lignes, { carte: { k: 1, v: 9 } });
    assert.strictEqual(poser(d, "joueur", 8).victoire, false);
    assert.strictEqual(d.termine, false);
  }
  {
    // Diagonale descendante, et alignement de 5 : toutes les cases gagnantes
    const lignes = ["J1........", "..J1......", "..........", "......J1..", "........J1"];
    const d = duelTest(lignes, { carte: { k: 0, v: 2 } });
    poser(d, "joueur", 12);
    assert.strictEqual(d.alignement.length, 5);
    assert.deepStrictEqual(alignementsDepuis(d.grille, 1), []);
  }

  // ── Carte impossible à poser : défaussée, l'adversaire rejoue ──
  {
    // Grille pleine de 9 sauf une case : le joueur pose, la carte suivante
    // du bot (un 1) ne peut aller nulle part, le joueur rejoue
    const lignes = Array(5).fill("J9B9J9B9J9");
    lignes[0] = "..B9J9B9J9";
    const d = duelTest(lignes, {
      carte: { k: 1, v: 1 },
      pioches: { joueur: [{ k: 0, v: 2 }], bot: [{ k: 0, v: 1 }] },
    });
    // Couleur 1 : aucun alignement possible
    poser(d, "joueur", 0);
    assert.deepStrictEqual(d.defausses, [{ id: "bot", carte: { k: 0, v: 1 } }]);
    assert.strictEqual(d.actif, "joueur");
    assert.deepStrictEqual(d.carte, { k: 0, v: 2 });
    assert.strictEqual(d.termine, false);
  }
  {
    // Pioches vides : match nul
    const lignes = Array(5).fill("J9B9J9B9J9");
    lignes[0] = "..B9J9B9J9";
    const d = duelTest(lignes, { carte: { k: 1, v: 1 }, pioches: { joueur: [], bot: [] } });
    poser(d, "joueur", 0);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "nul");
  }

  // ── Kévina : gagne dès qu'elle peut, coups toujours légaux ──
  {
    const lignes = grilleVide();
    lignes[3] = "B2B2..B2..";
    lignes[2] = "....J1....";
    const d = duelTest(lignes, { actif: "bot", carte: { k: 0, v: 3 } });
    for (let i = 0; i < 10; i++) assert.strictEqual(choixKevina(d, "bot", { marge: 50 }), 17);
  }
  {
    // Recouvrir la carte qui bloque l'alignement adverse : le joueur a
    // J J J sur la rangée 1, Kévina recouvre plutôt que de jouer ailleurs
    const lignes = grilleVide();
    lignes[1] = "J3J3J3....";
    lignes[2] = "....B1....";
    const d = duelTest(lignes, { actif: "bot", carte: { k: 0, v: 9 } });
    const c = choixKevina(d, "bot", { prudence: 1, rng: sansHasard });
    assert.ok([5, 6, 7, 8].includes(c));
  }
  {
    for (let n = 0; n < 50; n++) {
      const d = creerDuel();
      while (!d.termine) {
        const i = choixKevina(d, d.actif, { marge: 10 });
        assert.ok(casesJouables(d.grille, d.carte).includes(i));
        poser(d, d.actif, i);
      }
      assert.ok(d.coups <= 72 && d.grille.length === NB_CASES);
    }
  }

  console.log("puntoRules : OK");
}

main();
