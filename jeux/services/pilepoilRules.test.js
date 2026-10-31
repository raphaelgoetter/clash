import assert from "assert";
import {
  creerDuel,
  jouer,
  changerDe,
  resoudre,
  bloque,
  coupsPossibles,
  choixKevina,
  deJoue,
  CIBLE,
  SEUIL,
} from "./pilepoilRules.js";

// Lancers truqués : renvoie les valeurs de `des` dans l'ordre (puis 1)
const rngDes = (...des) => {
  const file = [...des];
  return () => ((file.length ? file.shift() : 1) - 1) / 6;
};

function duelTest(piles, de, laisse, { actif = "joueur", points = null } = {}) {
  const d = creerDuel({ commence: actif, rng: () => 0 });
  Object.assign(d, { piles, de, laisse, actif, choix: "lancer" });
  if (points) d.points = points;
  return d;
}

function main() {
  // ── Mise en place : 3 piles à 0, 2 dés, le joueur commence ──
  {
    const d = creerDuel({ rng: rngDes(4, 2) });
    assert.deepStrictEqual(d.piles, [0, 0, 0]);
    assert.deepStrictEqual([d.de, d.laisse, d.choix, d.actif], [4, 2, "lancer", "joueur"]);
  }

  // ── Explosion simple et souffle sur les voisines non vides ──
  {
    // A explose : B (voisine) +3, C intact
    assert.deepStrictEqual(resoudre([7, 4, 5], 0, 3), { piles: [0, 7, 5], explosions: [0], ratees: [], gain: 1, perte: 0 });
    // B explose : A et C +3 ; C tombe pile et explose en chaîne (son souffle touche B, vide)
    assert.deepStrictEqual(resoudre([2, 8, 7], 1, 2), { piles: [5, 0, 0], explosions: [1, 2], ratees: [], gain: 2, perte: 0 });
    // Le souffle fait dépasser A : elle saute ratée (+1 pour l'adversaire)
    assert.deepStrictEqual(resoudre([9, 6, 0], 1, 4), { piles: [0, 0, 0], explosions: [1], ratees: [0], gain: 1, perte: 1 });
    // Une pile vide ne reçoit pas de souffle
    assert.deepStrictEqual(resoudre([0, 9, 0], 1, 1).piles, [0, 0, 0]);
  }

  // ── Contenu des piles : dés posés et souffles, vidé à l'explosion ──
  {
    const contenu = [[{ v: 3, id: "joueur" }, { v: 5, id: "bot" }], [{ v: 4, id: "bot" }], []];
    const r = resoudre([8, 4, 0], 0, 2, contenu, { v: 2, id: "joueur" });
    assert.deepStrictEqual(r.contenu, [[], [{ v: 4, id: "bot" }, { v: 3, souffle: true }], []]);
    assert.deepStrictEqual(r.videes, { 0: 3 });
    assert.strictEqual(contenu[0].length, 2); // copie, contenu d'origine intact
    const d = duelTest([0, 0, 0], 4, 6);
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.contenu[1], [{ v: 4, id: "joueur" }]);
  }

  // ── Coups possibles : jamais au-delà de la cible ──
  {
    const d = duelTest([8, 3, 0], 4, 1);
    assert.deepStrictEqual(coupsPossibles(d).map((x) => x.k), [1, 2]);
    changerDe(d, "joueur");
    assert.strictEqual(deJoue(d), 1);
    assert.deepStrictEqual(coupsPossibles(d).map((x) => x.k), [0, 1, 2]);
    assert.ok(jouer(d, "bot", 0).erreur);
  }

  // ── Jouer : le dé non joué passe à l'adversaire, avec un nouveau lancer ──
  {
    const d = duelTest([7, 0, 0], 3, 5);
    const r = jouer(d, "joueur", 0, { rng: rngDes(6) });
    assert.deepStrictEqual(r, { de: 3, type: "explosion", gain: 1, perte: 0 });
    assert.deepStrictEqual(d.piles, [0, 0, 0]);
    assert.strictEqual(d.points.joueur, 1);
    assert.deepStrictEqual([d.actif, d.de, d.laisse, d.choix], ["bot", 6, 5, "lancer"]);
    assert.strictEqual(d.vue, 1);
    // Dé qui dépasse : refusé
    const e = duelTest([8, 0, 0], 4, 1);
    assert.ok(jouer(e, "joueur", 0).erreur);
    assert.strictEqual(e.coups, 0);
  }

  // ── Bloqué : aucun dé ne rentre, la pile choisie saute (+1 adversaire) ──
  {
    const d = duelTest([9, 8, 7], 5, 4);
    assert.strictEqual(bloque(d.piles, [5, 4]), true);
    assert.deepStrictEqual(coupsPossibles(d).map((x) => x.type), ["sautee", "sautee", "sautee"]);
    jouer(d, "joueur", 1);
    assert.deepStrictEqual(d.piles, [9, 0, 7]);
    assert.deepStrictEqual(d.points, { joueur: 0, bot: 1 });
    assert.strictEqual(d.dernier.type, "sautee");
  }

  // ── Fin au seuil ; les deux sur le même coup : le plus de points, à égalité celui qui joue ──
  {
    const d = duelTest([7, 0, 0], 3, 1, { points: { joueur: SEUIL - 1, bot: 2 } });
    jouer(d, "joueur", 0);
    assert.deepStrictEqual([d.termine, d.gagnant], [true, "joueur"]);
  }
  {
    // A explose (+1 joueur) et son souffle fait sauter B (+1 bot) : 6 à 6, le joueur gagne
    const d = duelTest([8, 9, 0], 2, 1, { points: { joueur: SEUIL - 1, bot: SEUIL - 1 } });
    jouer(d, "joueur", 0);
    assert.deepStrictEqual([d.points.joueur, d.points.bot, d.gagnant], [SEUIL, SEUIL, "joueur"]);
  }

  // ── Lancer qui ne rentre nulle part : le dé laissé est présélectionné ──
  {
    // Le joueur pose 1 sur C ([5, 6, 8]) et laisse le 2 ; le bot lance un 6,
    // qui dépasserait partout, alors que le 2 rentre
    const d = duelTest([5, 6, 7], 1, 2);
    jouer(d, "joueur", 2, { rng: rngDes(6) });
    assert.deepStrictEqual([d.piles, d.de, d.laisse, d.choix], [[5, 6, 8], 6, 2, "laisse"]);
    assert.ok(coupsPossibles(d).length > 0);
  }

  // ── Partie complète ──
  {
    const d = creerDuel();
    while (!d.termine) jouer(d, d.actif, coupsPossibles(d)[0].k);
    assert.ok(Math.max(d.points.joueur, d.points.bot) >= SEUIL);
  }

  // ── Kévina : fait exploser quand elle peut, avec le bon dé ──
  {
    // Le dé laissé (2) fait exploser A ; son lancer (5) non
    const d = duelTest([CIBLE - 2, 0, 0], 5, 2, { actif: "bot" });
    assert.deepStrictEqual(choixKevina(d, "bot"), { choix: "laisse", k: 0 });
  }
}

main();
console.log("pilepoilRules.test.js OK");
