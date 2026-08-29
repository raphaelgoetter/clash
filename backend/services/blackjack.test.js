import assert from "assert";
import {
  drawCard,
  computeHandValue,
  rollDealerScore,
  buildHandForScore,
  dealerPlay,
  compareToDealer,
  resolveDay,
  buildRanking,
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

  // ── rollDealerScore — entier uniforme dans [min, max], jamais de saut ──
  assert.strictEqual(rollDealerScore(rngSequence([0]), 15, 21), 15);
  assert.strictEqual(rollDealerScore(rngSequence([0.99]), 15, 21), 21);
  for (let i = 0; i < 200; i++) {
    const score = rollDealerScore(Math.random, 15, 21);
    assert.ok(score >= 15 && score <= 21);
  }

  // ── buildHandForScore — 2 cartes dont la somme vaut exactement le score ──
  for (let i = 0; i < 200; i++) {
    const score = 15 + Math.floor(Math.random() * 7); // 15..21
    const cards = buildHandForScore(score, Math.random);
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(computeHandValue(cards), score);
  }

  // ── dealerPlay — jamais de saut, toujours dans [min, max] ──
  const dealerHand = dealerPlay(rngSequence([0.5, 0.2, 0.3]), 15, 21);
  assert.ok(dealerHand.score >= 15 && dealerHand.score <= 21);
  assert.strictEqual(dealerHand.cards.length, 2);
  assert.strictEqual(computeHandValue(dealerHand.cards), dealerHand.score);

  // ── compareToDealer ──
  assert.strictEqual(compareToDealer(20, { score: 18 }), "win");
  assert.strictEqual(compareToDealer(18, { score: 20 }), "lose");
  assert.strictEqual(compareToDealer(19, { score: 19 }), "push");

  // ── resolveDay — une main "en_cours" à la clôture est figée, jamais ignorée ──
  const dealer = { score: 18 };
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

  // ── buildRanking — trié par points décroissants ──
  const ranking = buildRanking({ x: 1, y: 3, z: 0 });
  assert.deepStrictEqual(ranking.map((r) => r.discordId), ["y", "x", "z"]);

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
