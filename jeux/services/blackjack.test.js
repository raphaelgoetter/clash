import assert from "assert";
import {
  drawCard,
  drawUniqueCard,
  computeHandValue,
  dealerPlay,
  dealerHasNatural,
  isNatural,
  compareToDealer,
  pointsForResult,
  dealHand,
  canDouble,
  applyHandAction,
  resolveDay,
  buildRanking,
  addResultsCardsToTotals,
  isTooSoonSinceLastClosure,
} from "./blackjack.js";

function rngSequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function main() {
  // ── drawCard — rang uniforme parmi les 13 (index = floor(rng * 13)) ──
  assert.strictEqual(drawCard(rngSequence([0, 0])).rank, "A");
  assert.strictEqual(drawCard(rngSequence([0.99, 0])).rank, "K");
  assert.strictEqual(drawCard(rngSequence([9 / 13 + 0.001, 0])).rank, "10");
  assert.strictEqual(drawCard(rngSequence([0, 0])).value, 11); // As = 11 par défaut
  assert.strictEqual(drawCard(rngSequence([9 / 13 + 0.001, 0])).value, 10); // "10" = 10
  assert.strictEqual(drawCard(rngSequence([10 / 13 + 0.001, 0])).value, 10); // Valet = 10

  // ── drawUniqueCard — retire une carte déjà présente (même rang+couleur) ──
  {
    // 1er tirage (rng: 0, 0) -> A♠️, identique à la carte déjà en main ->
    // réessaie ; 2e tirage (rng: 0.99, 0.3) -> K♥️, distincte -> renvoyée.
    const card = drawUniqueCard(
      [{ rank: "A", suit: "♠️", value: 11 }],
      rngSequence([0, 0, 0.99, 0.3]),
    );
    assert.strictEqual(card.rank, "K");
    assert.strictEqual(card.suit, "♥️");
  }
  // Un rang qui revient reste autorisé (seule la combinaison rang+couleur
  // identique est exclue) : rng (0, 0.3) -> A♥️, rang "A" déjà présent mais
  // couleur différente -> acceptée du premier coup.
  {
    const card = drawUniqueCard(
      [{ rank: "A", suit: "♠️", value: 11 }],
      rngSequence([0, 0.3]),
    );
    assert.strictEqual(card.rank, "A");
    assert.strictEqual(card.suit, "♥️");
  }
  // Jamais la carte exacte déjà présente, sur de nombreux essais aléatoires.
  for (let i = 0; i < 200; i++) {
    const existing = [drawCard(), drawCard(), drawCard()];
    const card = drawUniqueCard(existing, Math.random);
    assert.ok(!existing.some((c) => c.rank === card.rank && c.suit === card.suit));
  }

  // ── computeHandValue — As 11 par défaut, ramené à 1 si besoin ──
  assert.strictEqual(computeHandValue([{ rank: "7", value: 7 }, { rank: "8", value: 8 }]), 15);
  assert.strictEqual(computeHandValue([{ rank: "A", value: 11 }, { rank: "K", value: 10 }]), 21); // blackjack naturel
  assert.strictEqual(computeHandValue([{ rank: "A", value: 11 }, { rank: "A", value: 11 }]), 12); // A+A = 12, pas 22
  assert.strictEqual(
    computeHandValue([{ rank: "A", value: 11 }, { rank: "5", value: 5 }, { rank: "8", value: 8 }]),
    14, // 11+5+8=24 > 21 -> As ramené à 1 -> 14
  );
  assert.strictEqual(
    computeHandValue([{ rank: "10", value: 10 }, { rank: "10", value: 10 }, { rank: "5", value: 5 }]),
    25, // bust, aucun As à ramener
  );

  const C = (rank) => ({ rank, suit: "♠️", value: rank === "A" ? 11 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank) });

  // ── dealerPlay — pioche jusqu'à 17, reste sur tout 17 (souple compris) ──
  for (let i = 0; i < 500; i++) {
    const d = dealerPlay(Math.random);
    assert.strictEqual(computeHandValue(d.cards), d.score);
    assert.ok(d.score >= 17);
    // la dernière carte n'a été tirée que depuis un total < 17
    if (d.cards.length > 2) assert.ok(computeHandValue(d.cards.slice(0, -1)) < 17);
  }

  // ── isNatural / dealerHasNatural — 21 avec les 2 cartes de départ seulement ──
  assert.strictEqual(isNatural([C("A"), C("K")]), true);
  assert.strictEqual(isNatural([C("7"), C("4"), C("K")]), false);
  assert.strictEqual(dealerHasNatural({ cards: [C("A"), C("Q")], score: 21 }), true);
  assert.strictEqual(dealerHasNatural(null), false);

  // ── compareToDealer ──
  const stand = (score, cards = [C("10"), C("9")]) => ({ score, cards, status: "stand" });
  assert.strictEqual(compareToDealer(stand(20), { cards: [C("10"), C("8")], score: 18 }), "win");
  assert.strictEqual(compareToDealer(stand(18), { cards: [C("10"), C("10")], score: 20 }), "lose");
  assert.strictEqual(compareToDealer(stand(19), { cards: [C("10"), C("9")], score: 19 }), "push");
  // le Croupier dépasse : toute main valide gagne, un dépassement du joueur perd quand même
  assert.strictEqual(compareToDealer(stand(12), { cards: [C("10"), C("6"), C("8")], score: 24 }), "win");
  assert.strictEqual(compareToDealer({ score: 23, cards: [], status: "bust" }, { cards: [], score: 24 }), "lose");
  // Blackjack naturel : bat un 21 en 3 cartes, égalité contre un Blackjack
  const naturel = stand(21, [C("A"), C("K")]);
  assert.strictEqual(compareToDealer(naturel, { cards: [C("7"), C("4"), C("K")], score: 21 }), "blackjack");
  assert.strictEqual(compareToDealer(naturel, { cards: [C("A"), C("J")], score: 21 }), "push");
  assert.strictEqual(compareToDealer(stand(21, [C("7"), C("4"), C("K")]), { cards: [C("A"), C("J")], score: 21 }), "lose");

  // ── pointsForResult — égalité 1, victoire 2, Blackjack 3, doublé ×2 ──
  assert.strictEqual(pointsForResult("win"), 2);
  assert.strictEqual(pointsForResult("push"), 1);
  assert.strictEqual(pointsForResult("lose"), 0);
  assert.strictEqual(pointsForResult("blackjack"), 3);
  assert.strictEqual(pointsForResult("win", true), 4);
  assert.strictEqual(pointsForResult("push", true), 2);
  assert.strictEqual(pointsForResult("lose", true), 0);

  // ── dealHand — main arrêtée d'office sur un 21 ou un Blackjack du Croupier ──
  {
    const croupierNaturel = { cards: [C("A"), C("K")], score: 21 };
    assert.strictEqual(dealHand("A", croupierNaturel).status, "stand");
    for (let i = 0; i < 50; i++) {
      const h = dealHand("A", { cards: [C("10"), C("7")], score: 17 });
      assert.strictEqual(h.status, h.score === 21 ? "stand" : "en_cours");
    }
  }

  // ── applyHandAction — Doubler : une carte, main arrêtée, seulement sur 2 cartes ──
  {
    const depart = { cards: [C("5"), C("6")], score: 11, status: "en_cours" };
    assert.strictEqual(canDouble(depart), true);
    const double = applyHandAction(depart, "doubler", rngSequence([9 / 13 + 0.001, 0]));
    assert.strictEqual(double.cards.length, 3);
    assert.strictEqual(double.score, 21);
    assert.strictEqual(double.status, "stand");
    assert.strictEqual(double.double, true);
    const pioche = applyHandAction(depart, "piocher", rngSequence([1 / 13 + 0.001, 0])); // un 2
    assert.strictEqual(pioche.status, "en_cours");
    assert.strictEqual(canDouble(pioche), false);
    assert.strictEqual(applyHandAction(pioche, "doubler"), pioche); // refusé
    assert.strictEqual(applyHandAction(depart, "arreter").status, "stand");
  }

  // ── resolveDay — une main "en_cours" à la clôture est figée, jamais ignorée ──
  const dealer = { cards: [C("10"), C("8")], score: 18 };
  const hands = {
    a: { cards: [], score: 20, status: "en_cours", username: "Alice" }, // jamais arrêtée -> figée -> gagne
    b: { cards: [], score: 25, status: "bust", username: "Bob" }, // bust -> perd toujours
    c: { cards: [], score: 18, status: "stand", username: "Chris" }, // égalité -> push
    d: { cards: [], score: 15, status: "stand", username: "Dana" }, // perd
  };
  const results = resolveDay(hands, dealer);
  const byId = Object.fromEntries(results.map((r) => [r.discordId, r]));
  assert.strictEqual(byId.a.status, "stand"); // "en_cours" -> figée en "stand"
  assert.strictEqual(byId.a.result, "win");
  assert.strictEqual(byId.b.result, "lose");
  assert.strictEqual(byId.c.result, "push");
  assert.strictEqual(byId.d.result, "lose");
  // une main doublée garde son drapeau jusqu'au résultat
  assert.strictEqual(resolveDay({ e: { cards: [C("10"), C("9")], score: 19, status: "stand", double: true } }, dealer)[0].double, true);

  // ── buildRanking — trié par points décroissants ──
  const ranking = buildRanking({ x: 1, y: 3, z: 0 });
  assert.deepStrictEqual(ranking.map((r) => r.discordId), ["y", "x", "z"]);

  // ── buildRanking — à points égaux, moins de cartes piochées = mieux classé ──
  {
    const tied = buildRanking({ a: 4, b: 4, c: 4 }, {}, { a: 8, b: 5, c: 6 });
    assert.deepStrictEqual(tied.map((r) => r.discordId), ["b", "c", "a"]);
  }

  // ── addResultsCardsToTotals — cumule les cartes de plusieurs jours ──
  {
    const totals = {};
    addResultsCardsToTotals(totals, [
      { discordId: "a", cards: [1, 2] },
      { discordId: "b", cards: [1, 2, 3] },
    ]);
    addResultsCardsToTotals(totals, [{ discordId: "a", cards: [1, 2, 3, 4] }]);
    assert.deepStrictEqual(totals, { a: 6, b: 3 });
  }

  // ── isTooSoonSinceLastClosure — garde-fou anti-double-avancée ──
  const now = Date.now();
  assert.strictEqual(isTooSoonSinceLastClosure(null, now), false);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(now - 1 * 3_600_000).toISOString(), now), true);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(now - 9 * 3_600_000).toISOString(), now), false);

  console.log("✓ blackjack service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
