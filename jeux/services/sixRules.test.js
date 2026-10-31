import assert from "assert";
import {
  creerDuel,
  jouer,
  typeCoup,
  coupsPossibles,
  penalite,
  choixKevina,
  echangePermis,
  echanger,
  COULEUR_MAUDITE,
  PENALITE_MAUDITE,
  SEUIL,
  prochaine,
} from "./sixRules.js";

// Colonnes de test : une chaîne de valeurs par colonne ("147" = 1, 4, 7),
// couleur 0 ; `maudites` : valeurs de la couleur maudite, par colonne.
const col = (valeurs, maudites = "") =>
  [...valeurs].map((v) => ({ k: maudites.includes(v) ? COULEUR_MAUDITE : 0, v: Number(v) }));

function duelTest(colonnes, carte, { pioche = null, actif = "joueur" } = {}) {
  const d = creerDuel({ commence: actif, rng: () => 0 });
  d.colonnes = colonnes;
  d.carte = { k: 1, v: carte };
  if (pioche) d.pioche = pioche;
  return d;
}

function main() {
  // ── Mise en place : 4 colonnes d'une carte, 1 carte à poser, 31 en pioche ──
  {
    const d = creerDuel();
    assert.strictEqual(d.colonnes.length, 4);
    assert.ok(d.colonnes.every((c) => c.length === 1));
    assert.ok(d.carte);
    assert.strictEqual(d.pioche.length, 31);
    const toutes = [...d.pioche, d.carte, ...d.colonnes.flat()].map((c) => `${c.k}${c.v}`);
    assert.strictEqual(new Set(toutes).size, 36);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Pénalité : 1 par carte, + PENALITE_MAUDITE par carte maudite ──
  assert.strictEqual(penalite(col("123")), 3);
  assert.strictEqual(penalite(col("123", "2")), 3 + PENALITE_MAUDITE);

  // ── Types de coup ──
  {
    const colonnes = [col("3"), col("8"), col("12345"), col("9")];
    const c = (v) => ({ k: 0, v });
    assert.strictEqual(typeCoup(colonnes, c(5), 0), "pose");
    // Plus faible ici, plus forte sur la colonne 0 : interdit
    assert.strictEqual(typeCoup(colonnes, c(5), 1), null);
    // 6e carte : ramasse
    assert.strictEqual(typeCoup(colonnes, c(9), 2), "sixieme");
    // Égalité : ne monte pas
    assert.strictEqual(typeCoup(colonnes, c(8), 1), null);
    // Plus forte nulle part : pose libre, sauf 6e carte
    const hautes = [col("9"), col("8"), col("12348"), col("7")];
    assert.strictEqual(typeCoup(hautes, c(2), 0), "libre");
    assert.strictEqual(typeCoup(hautes, c(2), 2), "sixieme");
  }

  // ── Coups possibles : colonnes permises seulement, pénalité annoncée ──
  {
    const d = duelTest([col("3"), col("8", "8"), col("12345"), col("9")], 6);
    assert.deepStrictEqual(coupsPossibles(d), [
      { c: 0, type: "pose", penalite: 0 },
      { c: 2, type: "sixieme", penalite: 5 },
    ]);
    // Colonne interdite refusée, partie intacte
    assert.ok(jouer(d, "joueur", 1).erreur);
    assert.strictEqual(d.coups, 0);
  }

  // ── Prochaine carte : le dessus de la pioche ──
  {
    const d = duelTest([col("3"), col("8"), col("1"), col("2")], 5, { pioche: [{ k: 0, v: 2 }, { k: 3, v: 7 }] });
    assert.deepStrictEqual(prochaine(d), { k: 3, v: 7 });
    jouer(d, "joueur", 0);
    assert.deepStrictEqual(d.carte, { k: 3, v: 7 });
    assert.deepStrictEqual(prochaine(d), { k: 0, v: 2 });
  }

  // ── Jouer : pose, puis carte retournée pour l'adversaire ──
  {
    const d = duelTest([col("3"), col("8"), col("1"), col("2")], 5);
    const restantes = d.pioche.length;
    const r = jouer(d, "joueur", 0);
    assert.deepStrictEqual(r, { carte: { k: 1, v: 5 }, type: "pose", penalite: 0 });
    assert.deepStrictEqual(d.colonnes[0].map((c) => c.v), [3, 5]);
    assert.strictEqual(d.actif, "bot");
    assert.ok(d.carte);
    assert.strictEqual(d.pioche.length, restantes - 1);
    assert.strictEqual(d.coups, 1);
    assert.ok(jouer(d, "joueur", 0).erreur);
    assert.ok(jouer(d, "bot", 4).erreur);
  }

  // ── Ramassage à la 6e carte : 5 cartes ramassées, la 6e reste ──
  {
    const d = duelTest([col("12345", "2"), col("8"), col("9"), col("9")], 7);
    jouer(d, "joueur", 0);
    assert.deepStrictEqual(d.colonnes[0], [{ k: 1, v: 7 }]);
    assert.strictEqual(d.points.joueur, 5 + PENALITE_MAUDITE);
    assert.strictEqual(d.dernier.ramassees.length, 5);
    assert.strictEqual(d.dernier.type, "sixieme");
  }

  // ── Pose libre : aucune colonne où monter, aucun point ──
  {
    const d = duelTest([col("9"), col("78"), col("6"), col("5")], 2);
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.colonnes[1].map((c) => c.v), [7, 8, 2]);
    assert.strictEqual(d.points.joueur, 0);
    assert.strictEqual(d.dernier.type, "libre");
  }

  // ── Fin : pioche vide après le coup, le moins de points gagne ──
  {
    const d = duelTest([col("3"), col("8"), col("1"), col("2")], 5, { pioche: [] });
    d.points = { joueur: 4, bot: 6 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.fin, "pioche");
    assert.strictEqual(d.gagnant, "joueur");
    assert.ok(jouer(d, "bot", 0).erreur);
  }
  {
    const d = duelTest([col("3"), col("8"), col("1"), col("2")], 5, { pioche: [] });
    d.points = { joueur: 6, bot: 6 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.gagnant, "nul");
  }

  // ── Fin au seuil : dès qu'un joueur atteint SEUIL points ──
  {
    const d = duelTest([col("12345"), col("8"), col("9"), col("9")], 7);
    d.points = { joueur: SEUIL - 5, bot: 3 };
    jouer(d, "joueur", 0);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.fin, "seuil");
    assert.strictEqual(d.gagnant, "bot");
  }

  // ── Partie complète : au plus 32 coups ──
  {
    const d = creerDuel({ rng: () => 0.3 });
    while (!d.termine) jouer(d, d.actif, coupsPossibles(d)[0].c);
    assert.ok(d.coups <= 32);
  }

  // ── Kévina : évite de ramasser ──
  {
    // Le 9 sur la colonne 2 (5 cartes) ramasserait, ailleurs il se pose
    const d = duelTest([col("2"), col("8"), col("12345"), col("1")], 9, { actif: "bot", pioche: [{ k: 0, v: 1 }] });
    const choix = choixKevina(d, "bot");
    const carte = choix.echange ? prochaine(d) : d.carte;
    assert.strictEqual(coupsPossibles(d, carte).find((x) => x.c === choix.c).penalite, 0);
  }

  // ── Échange : seulement si sa carte passe sans ramasser, 1 par partie ──
  {
    // Le 7 ne peut aller que sur la colonne 0 (5 cartes) : il ferait ramasser
    const d = duelTest([col("12345"), col("8"), col("9"), col("9")], 7, { pioche: [{ k: 0, v: 2 }, { k: 3, v: 4 }] });
    assert.strictEqual(echangePermis(d, "joueur"), false);
    assert.ok(echanger(d, "joueur").erreur);
  }
  {
    const d = duelTest([col("3"), col("8"), col("1"), col("2")], 5, { pioche: [{ k: 0, v: 2 }, { k: 3, v: 7 }] });
    assert.strictEqual(echangePermis(d, "bot"), false); // pas son tour
    const r = echanger(d, "joueur");
    assert.deepStrictEqual(r, { donnee: { k: 1, v: 5 }, recue: { k: 3, v: 7 } });
    assert.deepStrictEqual(d.carte, { k: 3, v: 7 });
    assert.deepStrictEqual(prochaine(d), { k: 1, v: 5 });
    assert.strictEqual(d.echanges.joueur, 0);
    assert.strictEqual(d.vue, 1);
    assert.ok(echanger(d, "joueur").erreur); // un seul par tour (et plus aucun)
    jouer(d, "joueur", 0);
    assert.strictEqual(d.dernier.echange, true);
    // L'adversaire reçoit la carte donnée
    assert.deepStrictEqual(d.carte, { k: 1, v: 5 });
    assert.strictEqual(echangePermis(d, "bot"), true);
  }
}

main();
console.log("sixRules.test.js OK");
