import assert from "assert";
import {
  creerDuel,
  jouer,
  choisirValeur,
  resoudre,
  bloque,
  coupsPossibles,
  choixKevina,
  evaluerCoups,
  mainPleine,
  CIBLE,
  SEUIL,
  VALEUR_MAX,
} from "./pilepoilRules.js";

// Valeurs exprimées par rapport à la cible (C) : le test survit à un
// changement de CIBLE
const C = CIBLE;

function duelTest(piles, { actif = "joueur", points = null, mains = null } = {}) {
  const d = creerDuel({ commence: actif });
  d.piles = piles;
  if (points) d.points = points;
  if (mains) d.mains = mains;
  return d;
}

// Choisit la valeur `v` puis la pose sur la pile `k`
const poser = (d, id, v, k) => {
  const c = choisirValeur(d, id, v);
  return c.erreur ? c : jouer(d, id, k);
};

function main() {
  // ── Mise en place : 3 piles à 0, mains pleines (1 à 6), le joueur commence ──
  {
    const d = creerDuel();
    assert.deepStrictEqual(d.piles, [0, 0, 0]);
    assert.deepStrictEqual(d.mains, { joueur: mainPleine(), bot: mainPleine() });
    assert.deepStrictEqual(mainPleine(), Array.from({ length: VALEUR_MAX }, (_, i) => i + 1));
    assert.deepStrictEqual([d.actif, d.choix], ["joueur", null]);
  }

  // ── Explosion simple et souffle sur les voisines non vides ──
  {
    assert.deepStrictEqual(resoudre([C - 3, 4, 5], 0, 3), { piles: [0, 7, 5], explosions: [0], ratees: [], gain: 1, perte: 0 });
    // B explose : A et C +3 ; C tombe pile et explose en chaîne (son souffle touche B, vide)
    assert.deepStrictEqual(resoudre([2, C - 2, C - 3], 1, 2), { piles: [5, 0, 0], explosions: [1, 2], ratees: [], gain: 2, perte: 0 });
    // Le souffle fait dépasser A : elle saute ratée (+1 pour l'adversaire)
    assert.deepStrictEqual(resoudre([C - 1, C - 4, 0], 1, 4), { piles: [0, 0, 0], explosions: [1], ratees: [0], gain: 1, perte: 1 });
    // Une pile vide ne reçoit pas de souffle
    assert.deepStrictEqual(resoudre([0, C - 1, 0], 1, 1).piles, [0, 0, 0]);
  }

  // ── Contenu des piles : valeurs posées et souffles, vidé à l'explosion ──
  {
    const contenu = [[{ v: 3, id: "joueur" }, { v: 5, id: "bot" }], [{ v: 4, id: "bot" }], []];
    const r = resoudre([C - 2, 4, 0], 0, 2, contenu, { v: 2, id: "joueur" });
    assert.deepStrictEqual(r.contenu, [[], [{ v: 4, id: "bot" }, { v: 3, souffle: true }], []]);
    assert.deepStrictEqual(r.videes, { 0: 3 });
    assert.strictEqual(contenu[0].length, 2); // copie, contenu d'origine intact
  }

  // ── Choix de valeur puis pose : la valeur quitte la main ──
  {
    const d = duelTest([0, 0, 0]);
    assert.ok(jouer(d, "joueur", 0).erreur); // pas de valeur choisie
    assert.deepStrictEqual(coupsPossibles(d), []);
    assert.ok(choisirValeur(d, "bot", 4).erreur); // pas son tour
    choisirValeur(d, "joueur", 4);
    assert.strictEqual(d.vue, 1);
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.contenu[1], [{ v: 4, id: "joueur" }]);
    assert.deepStrictEqual(d.mains.joueur, [1, 2, 3, 5, 6]);
    assert.deepStrictEqual([d.actif, d.choix, d.vue], ["bot", null, 2]);
    // Valeur déjà jouée : refusée
    poser(d, "bot", 6, 0);
    assert.ok(choisirValeur(d, "joueur", 4).erreur);
  }

  // ── Coups possibles : jamais au-delà de la cible ──
  {
    const d = duelTest([C - 2, 3, 0]);
    choisirValeur(d, "joueur", 4);
    assert.deepStrictEqual(coupsPossibles(d).map((x) => x.k), [1, 2]);
    assert.ok(jouer(d, "joueur", 0).erreur);
    assert.strictEqual(d.coups, 0);
  }

  // ── Main vide : rechargée ──
  {
    const d = duelTest([0, 0, 0], { mains: { joueur: [2], bot: mainPleine() } });
    poser(d, "joueur", 2, 0);
    assert.deepStrictEqual(d.mains.joueur, mainPleine());
  }

  // ── Bloqué : aucune valeur ne rentre, on défausse et la pile choisie saute ──
  {
    const d = duelTest([C - 1, C - 2, C - 3], { mains: { joueur: [5, 6], bot: mainPleine() } });
    assert.strictEqual(bloque(d.piles, d.mains.joueur), true);
    choisirValeur(d, "joueur", 6);
    assert.deepStrictEqual(coupsPossibles(d).map((x) => x.type), ["sautee", "sautee", "sautee"]);
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.piles, [C - 1, 0, C - 3]);
    assert.deepStrictEqual(d.points, { joueur: 0, bot: 1 });
    assert.deepStrictEqual(d.mains.joueur, [5]);
  }

  // ── Fin au seuil ; les deux sur le même coup : le plus de points, à égalité celui qui joue ──
  {
    const d = duelTest([C - 3, 0, 0], { points: { joueur: SEUIL - 1, bot: 0 } });
    poser(d, "joueur", 3, 0);
    assert.deepStrictEqual([d.termine, d.gagnant], [true, "joueur"]);
  }
  {
    // A explose (+1 joueur) et son souffle fait sauter B (+1 bot) : égalité au seuil, le joueur gagne
    const d = duelTest([C - 2, C - 1, 0], { points: { joueur: SEUIL - 1, bot: SEUIL - 1 } });
    poser(d, "joueur", 2, 0);
    assert.deepStrictEqual([d.points.joueur, d.points.bot, d.gagnant], [SEUIL, SEUIL, "joueur"]);
  }

  // ── Partie complète entre deux Kévina ──
  {
    const d = creerDuel();
    while (!d.termine) {
      const { v, k } = choixKevina(d, d.actif, { profondeur: 2 });
      poser(d, d.actif, v, k);
    }
    assert.ok(Math.max(d.points.joueur, d.points.bot) >= SEUIL);
  }

  // ── Kévina : explose quand elle peut, et n'offre pas d'explosion ──
  {
    // Le 2 fait exploser A
    const d = duelTest([C - 2, 0, 0], { actif: "bot" });
    assert.deepStrictEqual(choixKevina(d, "bot", { profondeur: 2 }), { v: 2, k: 0 });
  }
  {
    // Piles vides sauf B à 4 (personne ne peut la finir d'un dé) : poser sur
    // B (1 à 3 ou 6) ou un 6 ailleurs laisserait au joueur, qui a tous ses
    // dés, de quoi faire exploser une pile ; les coups sûrs sont 1, 2 ou 3
    // sur A ou C
    const d = duelTest([0, 4, 0], { actif: "bot", mains: { joueur: mainPleine(), bot: [1, 2, 3, 6] } });
    for (let essai = 0; essai < 20; essai++) {
      const { v, k } = choixKevina(d, "bot", { profondeur: 2 });
      assert.ok(k !== 1 && v <= 3, `coup risqué : ${v} en ${"ABC"[k]}`);
    }
    const scores = evaluerCoups(d, 2);
    const max = Math.max(...scores.map((x) => x.score));
    assert.ok(scores.find((x) => x.v === 6 && x.k === 0).score < max);
  }
}

main();
console.log("pilepoilRules.test.js OK");
