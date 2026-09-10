import assert from "assert";
import { applyJoin, computeMancheOutcome, buildRanking } from "./blackjackDuel.js";

function baseState(overrides = {}) {
  return {
    maxPlayers: 2,
    totalManches: 5,
    manche: 1,
    players: [],
    rosterLocked: false,
    dealer: { score: 18 },
    ...overrides,
  };
}

async function main() {
  // ── applyJoin — un nouveau joueur peut prendre un siège libre ──
  {
    const state = baseState({ players: ["a"] });
    const decision = applyJoin(state, "b");
    assert.strictEqual(decision.allowed, true);
    assert.deepStrictEqual(decision.players, ["a", "b"]);
    // 2e siège sur 2 -> verrou immédiat (tous les sièges pris)
    assert.strictEqual(decision.rosterLocked, true);
  }

  // ── applyJoin — un joueur déjà inscrit rejoue simplement sa manche ──
  {
    const state = baseState({ players: ["a"] });
    const decision = applyJoin(state, "a");
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.isSeated, true);
    assert.deepStrictEqual(decision.players, ["a"]);
    assert.strictEqual(decision.rosterLocked, false); // 1/2, pas encore plein
  }

  // ── applyJoin — refusé une fois le roster verrouillé ──
  {
    const state = baseState({ players: ["a"], rosterLocked: true });
    const decision = applyJoin(state, "b");
    assert.strictEqual(decision.allowed, false);
  }

  // ── applyJoin — refusé si les sièges sont déjà tous pris (garde-fou,
  // même si rosterLocked n'a pas encore été explicitement posé) ──
  {
    const state = baseState({ players: ["a", "b"] });
    const decision = applyJoin(state, "c");
    assert.strictEqual(decision.allowed, false);
  }

  // ── computeMancheOutcome — manche intermédiaire : pas de classement final ──
  {
    const state = baseState({ manche: 1, totalManches: 5 });
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" }, // gagne
      b: { cards: [], score: 15, status: "stand", username: "Bob" }, // perd
    };
    const outcome = computeMancheOutcome(state, hands, {});
    assert.strictEqual(outcome.estFinDePartie, false);
    assert.strictEqual(outcome.mancheSuivante, 2);
    assert.strictEqual(outcome.ranking, null);
    assert.strictEqual(outcome.pointsAfter.a, 1);
    assert.strictEqual(outcome.pointsAfter.b ?? 0, 0);
  }

  // ── computeMancheOutcome — dernière manche : classement final cumulé ──
  {
    const state = baseState({ manche: 5, totalManches: 5 });
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" }, // gagne encore
      b: { cards: [], score: 25, status: "bust", username: "Bob" },
    };
    const currentPoints = { a: 3, b: 1 };
    const outcome = computeMancheOutcome(state, hands, currentPoints);
    assert.strictEqual(outcome.estFinDePartie, true);
    assert.strictEqual(outcome.pointsAfter.a, 4);
    assert.strictEqual(outcome.pointsAfter.b, 1);
    assert.deepStrictEqual(outcome.ranking.map((r) => r.discordId), ["a", "b"]);
    // computeMancheOutcome ne mute jamais l'objet points fourni par l'appelant
    assert.deepStrictEqual(currentPoints, { a: 3, b: 1 });
  }

  console.log("✓ blackjackDuel service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
