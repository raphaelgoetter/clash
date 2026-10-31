import assert from "assert";
import {
  creerDuel,
  jouer,
  typeCoup,
  coupsPossibles,
  choixKevina,
  prochaine,
  prochaineDe,
  COULEUR,
  NEUTRE,
  SEUIL,
} from "./sixRules.js";

// Cartes de test : `j` = couleur du joueur, `b` = couleur du bot, `n` = neutre
const K = { j: COULEUR.joueur, b: COULEUR.bot, n: NEUTRE };
const carte = (code) => ({ k: K[code[0]], v: Number(code[1]) });
// Colonne : codes séparés par des espaces (« j1 b2 n3 »)
const col = (codes) => codes.split(" ").map(carte);

// `paquets` : { joueur: [codes], bot: [codes] }, dessus du paquet en dernier
function duelTest(colonnes, aJouer, { paquets = null, actif = "joueur" } = {}) {
  const d = creerDuel({ commence: actif, rng: () => 0 });
  d.colonnes = colonnes;
  d.carte = carte(aJouer);
  if (paquets) d.paquets = { joueur: (paquets.joueur ?? []).map(carte), bot: (paquets.bot ?? []).map(carte) };
  return d;
}

function main() {
  // ── Mise en place : un paquet de 22 cartes par joueur (18 de sa couleur, 4 neutres),
  // 4 colonnes de départ (2 cartes de chaque paquet) ──
  {
    const d = creerDuel();
    assert.strictEqual(d.colonnes.length, 4);
    assert.ok(d.colonnes.every((c) => c.length === 1));
    assert.ok([K.j, K.n].includes(d.carte.k));
    assert.deepStrictEqual([d.paquets.joueur.length, d.paquets.bot.length], [22 - 2 - 1, 22 - 2]);
    const toutes = [...d.paquets.joueur, ...d.paquets.bot, d.carte, ...d.colonnes.flat()];
    const parCouleur = (k) => toutes.filter((c) => c.k === k).length;
    assert.deepStrictEqual([parCouleur(K.j), parCouleur(K.b), parCouleur(K.n)], [18, 18, 8]);
    // Le paquet du joueur ne contient que ses cartes et des neutres
    assert.ok(d.paquets.joueur.every((c) => c.k !== K.b));
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Types de coup ──
  {
    const colonnes = [col("n3"), col("n8"), col("j1 j2 j3 j4 j5"), col("n9")];
    const c = (v) => ({ k: K.n, v });
    assert.strictEqual(typeCoup(colonnes, c(5), 0), "pose");
    // Plus faible ici, plus forte sur la colonne 0 : interdit
    assert.strictEqual(typeCoup(colonnes, c(5), 1), null);
    // 6e carte : fermeture
    assert.strictEqual(typeCoup(colonnes, c(9), 2), "fermeture");
    // Plus forte nulle part : pose libre, sauf 6e carte
    const hautes = [col("n9"), col("n8"), col("n1 n2 n3 n4 n8"), col("n7")];
    assert.strictEqual(typeCoup(hautes, c(2), 0), "libre");
    assert.strictEqual(typeCoup(hautes, c(2), 2), "fermeture");
  }

  // ── Coups possibles : colonnes permises seulement, gain annoncé pour le joueur actif ──
  {
    const d = duelTest([col("n3"), col("n8"), col("j1 b2 j3 n4 j5"), col("n9")], "n6");
    assert.deepStrictEqual(coupsPossibles(d), [
      { c: 0, type: "pose", gain: 0 },
      { c: 2, type: "fermeture", gain: 3 },
    ]);
    // Même coup vu par le bot : ses cartes seulement
    assert.strictEqual(coupsPossibles(d, d.carte, "bot")[1].gain, 1);
    assert.ok(jouer(d, "joueur", 1).erreur);
    assert.strictEqual(d.coups, 0);
  }

  // ── Jouer : pose, puis carte retournée du paquet de l'adversaire ──
  {
    const d = duelTest([col("n3"), col("n8"), col("n1"), col("n2")], "j5", { paquets: { joueur: ["j4", "j8"], bot: ["n2", "b7"] } });
    // Visibles : la prochaine de l'adversaire et sa propre suivante
    assert.deepStrictEqual(prochaine(d), carte("b7"));
    assert.deepStrictEqual(prochaineDe(d, "joueur"), carte("j8"));
    const r = jouer(d, "joueur", 0);
    assert.deepStrictEqual(r, { carte: carte("j5"), type: "pose", gain: 0 });
    assert.deepStrictEqual(d.colonnes[0], col("n3 j5"));
    assert.strictEqual(d.actif, "bot");
    assert.deepStrictEqual(d.carte, carte("b7"));
    assert.deepStrictEqual(prochaine(d), carte("j8"));
    assert.strictEqual(d.vue, 1);
    assert.ok(jouer(d, "joueur", 0).erreur);
    assert.ok(jouer(d, "bot", 4).erreur);
  }

  // ── Fermeture : 1 point par carte de sa couleur parmi les 5, la 6e reste ──
  {
    const d = duelTest([col("j1 b2 j3 n4 j5"), col("n8"), col("n9"), col("n9")], "b7");
    d.actif = "bot";
    jouer(d, "bot", 0);
    assert.deepStrictEqual(d.colonnes[0], [carte("b7")]);
    assert.strictEqual(d.points.bot, 1);
    assert.deepStrictEqual(d.marquees.bot, [carte("b2")]);
    assert.strictEqual(d.dernier.type, "fermeture");
    assert.strictEqual(d.dernier.gain, 1);
  }

  // ── Pose libre : aucune colonne où monter ──
  {
    const d = duelTest([col("n9"), col("n7 n8"), col("n6"), col("n5")], "j2");
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.colonnes[1], col("n7 n8 j2"));
    assert.strictEqual(d.dernier.type, "libre");
  }

  // ── Fin au seuil : le premier à SEUIL points gagne ──
  {
    const d = duelTest([col("j1 j2 j3 n4 n5"), col("n8"), col("n9"), col("n9")], "n7");
    d.points = { joueur: SEUIL - 3, bot: 4 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.fin, "seuil");
    assert.strictEqual(d.gagnant, "joueur");
  }

  // ── Fin paquet adverse vide : le plus de points gagne, égalité = nul ──
  {
    const d = duelTest([col("n3"), col("n8"), col("n1"), col("n2")], "n5", { paquets: { joueur: [], bot: [] } });
    d.points = { joueur: 2, bot: 1 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.fin, "pioche");
    assert.strictEqual(d.gagnant, "joueur");
  }
  {
    const d = duelTest([col("n3"), col("n8"), col("n1"), col("n2")], "n5", { paquets: { joueur: [], bot: [] } });
    d.points = { joueur: 2, bot: 2 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.gagnant, "nul");
  }

  // ── Partie complète ──
  {
    const d = creerDuel({ rng: () => 0.3 });
    while (!d.termine) jouer(d, d.actif, coupsPossibles(d)[0].c);
    assert.ok(d.termine && d.gagnant);
  }

  // ── Kévina : ferme la colonne qui lui rapporte, n'offre pas de fermeture ──
  {
    // Le 6 rouge ferme la colonne 2 (3 cartes du bot) ; ailleurs, rien
    const d = duelTest([col("n2"), col("n8"), col("b1 b2 b3 n4 n5"), col("n1")], "b6", { actif: "bot", paquets: { joueur: ["n1"], bot: ["b1"] } });
    d.actif = "bot";
    assert.strictEqual(choixKevina(d, "bot"), 2);
  }
  {
    // Poser le 5 en colonne 0 offrirait au joueur (prochaine carte j9) une
    // fermeture rapportant 4 points : Kévina joue ailleurs
    const d = duelTest([col("j1 j2 j3 j4"), col("n3"), col("n9"), col("n9")], "b5", { actif: "bot", paquets: { joueur: ["j9"], bot: ["b1"] } });
    d.actif = "bot";
    assert.notStrictEqual(choixKevina(d, "bot"), 0);
  }
}

main();
console.log("sixRules.test.js OK");
