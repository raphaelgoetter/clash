import assert from "assert";
import {
  creerDuel,
  jouer,
  typeCoup,
  coupsPossibles,
  penalite,
  choixKevina,
  COULEUR_MAUDITE,
  PENALITE_MAUDITE,
} from "./sixRules.js";

// Colonnes de test : une chaîne de valeurs par colonne ("147" = 1, 4, 7),
// couleur 0 ; `maudites` : valeurs de la couleur maudite, par colonne.
const col = (valeurs, maudites = "") =>
  [...valeurs].map((v) => ({ k: maudites.includes(v) ? COULEUR_MAUDITE : 0, v: Number(v) }));

function duelTest(colonnes, main, { pioche = null, actif = "joueur" } = {}) {
  const d = creerDuel({ commence: actif, rng: () => 0 });
  d.colonnes = colonnes;
  d.main = main.map((v) => ({ k: 1, v }));
  if (pioche) d.pioche = pioche;
  return d;
}

function main() {
  // ── Mise en place : 3 colonnes d'une carte, 2 cartes en main, 31 en pioche ──
  {
    const d = creerDuel();
    assert.strictEqual(d.colonnes.length, 3);
    assert.ok(d.colonnes.every((c) => c.length === 1));
    assert.strictEqual(d.main.length, 2);
    assert.strictEqual(d.pioche.length, 31);
    const toutes = [...d.pioche, ...d.main, ...d.colonnes.flat()].map((c) => `${c.k}${c.v}`);
    assert.strictEqual(new Set(toutes).size, 36);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Pénalité : 1 par carte, + PENALITE_MAUDITE par carte maudite ──
  assert.strictEqual(penalite(col("123")), 3);
  assert.strictEqual(penalite(col("123", "2")), 3 + PENALITE_MAUDITE);

  // ── Types de coup ──
  {
    const colonnes = [col("3"), col("8"), col("12345")];
    const c = (v) => ({ k: 0, v });
    assert.strictEqual(typeCoup(colonnes, c(5), 0), "pose");
    // Plus faible ici, plus forte sur la colonne 0 : ramassage volontaire
    assert.strictEqual(typeCoup(colonnes, c(5), 1), "volontaire");
    // 6e carte : ramasse
    assert.strictEqual(typeCoup(colonnes, c(9), 2), "sixieme");
    // Égalité : ne monte pas
    assert.strictEqual(typeCoup(colonnes, c(8), 1), "volontaire");
    // Plus forte nulle part : pose libre, sauf 6e carte
    const hautes = [col("9"), col("8"), col("12348")];
    assert.strictEqual(typeCoup(hautes, c(2), 0), "libre");
    assert.strictEqual(typeCoup(hautes, c(2), 2), "sixieme");
  }

  // ── Coups possibles : 2 cartes × 3 colonnes, pénalité annoncée ──
  {
    const d = duelTest([col("3"), col("8", "8"), col("12345")], [5, 9]);
    const coups = coupsPossibles(d);
    assert.strictEqual(coups.length, 6);
    const coup = (m, c) => coups.find((x) => x.m === m && x.c === c);
    assert.deepStrictEqual(coup(0, 1), { m: 0, c: 1, type: "volontaire", penalite: 1 + PENALITE_MAUDITE });
    assert.deepStrictEqual(coup(1, 2), { m: 1, c: 2, type: "sixieme", penalite: 5 });
    assert.strictEqual(coup(0, 0).penalite, 0);
  }

  // ── Jouer : pose, carte passée à l'adversaire avec une nouvelle pioche ──
  {
    const d = duelTest([col("3"), col("8"), col("1")], [5, 9]);
    const restantes = d.pioche.length;
    const r = jouer(d, "joueur", 0, 0);
    assert.deepStrictEqual(r, { carte: { k: 1, v: 5 }, type: "pose", penalite: 0 });
    assert.deepStrictEqual(d.colonnes[0].map((c) => c.v), [3, 5]);
    assert.strictEqual(d.actif, "bot");
    assert.deepStrictEqual(d.main[0], { k: 1, v: 9 });
    assert.strictEqual(d.pioche.length, restantes - 1);
    assert.strictEqual(d.coups, 1);
    assert.ok(jouer(d, "joueur", 0, 0).erreur);
  }

  // ── Ramassage à la 6e carte : 5 cartes ramassées, la 6e reste ──
  {
    const d = duelTest([col("12345", "2"), col("8"), col("9")], [7, 1]);
    jouer(d, "joueur", 0, 0);
    assert.deepStrictEqual(d.colonnes[0], [{ k: 1, v: 7 }]);
    assert.strictEqual(d.points.joueur, 5 + PENALITE_MAUDITE);
    assert.strictEqual(d.dernier.ramassees.length, 5);
    assert.strictEqual(d.dernier.type, "sixieme");
  }

  // ── Ramassage volontaire : la colonne entière, la carte la remplace ──
  {
    const d = duelTest([col("3"), col("68"), col("1")], [5, 9]);
    jouer(d, "joueur", 0, 1);
    assert.deepStrictEqual(d.colonnes[1], [{ k: 1, v: 5 }]);
    assert.strictEqual(d.points.joueur, 2);
    assert.strictEqual(d.dernier.type, "volontaire");
  }

  // ── Pose libre : aucune colonne où monter, aucun point ──
  {
    const d = duelTest([col("9"), col("78"), col("6")], [2, 3]);
    jouer(d, "joueur", 0, 1);
    assert.deepStrictEqual(d.colonnes[1].map((c) => c.v), [7, 8, 2]);
    assert.strictEqual(d.points.joueur, 0);
    assert.strictEqual(d.dernier.type, "libre");
  }

  // ── Fin : pioche vide après le coup, le moins de points gagne ──
  {
    const d = duelTest([col("3"), col("8"), col("1")], [5, 9], { pioche: [] });
    d.points = { joueur: 4, bot: 6 };
    jouer(d, "joueur", 0, 0);
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "joueur");
    assert.ok(jouer(d, "bot", 0, 0).erreur);
  }
  {
    const d = duelTest([col("3"), col("8"), col("1")], [5, 9], { pioche: [] });
    d.points = { joueur: 6, bot: 6 };
    jouer(d, "joueur", 0, 0);
    assert.strictEqual(d.gagnant, "nul");
  }

  // ── Partie complète : 16 coups chacun ──
  {
    const d = creerDuel({ rng: () => 0.3 });
    while (!d.termine) jouer(d, d.actif, 0, 0);
    assert.strictEqual(d.coups, 32);
  }

  // ── Kévina : évite de ramasser, et ne passe pas la carte qui fait ramasser peu ──
  {
    // Le 9 sur la colonne 2 (5 cartes) ramasserait ; le 4 se pose sans risque
    const d = duelTest([col("2"), col("8"), col("12345")], [9, 4], { actif: "bot", pioche: [{ k: 0, v: 1 }] });
    const { m, c } = choixKevina(d, "bot");
    assert.strictEqual(coupsPossibles(d).find((x) => x.m === m && x.c === c).penalite, 0);
  }
}

main();
console.log("sixRules.test.js OK");
