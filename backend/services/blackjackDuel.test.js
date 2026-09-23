import assert from "assert";
import { applyJoin, computeMancheOutcome, buildRanking, resolvePvP } from "./blackjackDuel.js";

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

  // ── computeMancheOutcome — solo (1 joueur), manche intermédiaire : pas de
  // classement final. Barème 2/1/0 (12/09) : une victoire rapporte 2 points,
  // une égalité 1 point (pas 0 comme une défaite), une défaite 0.
  {
    const state = baseState({ maxPlayers: 1, manche: 1, totalManches: 5 });
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" }, // gagne -> 2 pts
      b: { cards: [], score: 15, status: "stand", username: "Bob" }, // perd -> 0 pt
      c: { cards: [], score: 18, status: "stand", username: "Chris" }, // égalité (Croupier à 18) -> 1 pt
    };
    const outcome = computeMancheOutcome(state, hands, {});
    assert.strictEqual(outcome.estFinDePartie, false);
    assert.strictEqual(outcome.mancheSuivante, 2);
    assert.strictEqual(outcome.ranking, null);
    assert.strictEqual(outcome.pointsAfter.a, 2);
    assert.strictEqual(outcome.pointsAfter.b ?? 0, 0);
    assert.strictEqual(outcome.pointsAfter.c, 1);
  }

  // ── computeMancheOutcome — solo, dernière manche : classement final cumulé ──
  {
    const state = baseState({ maxPlayers: 1, manche: 5, totalManches: 5 });
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" }, // gagne encore -> +2
      b: { cards: [], score: 25, status: "bust", username: "Bob" }, // -> +0
    };
    const currentPoints = { a: 3, b: 1 };
    const outcome = computeMancheOutcome(state, hands, currentPoints);
    assert.strictEqual(outcome.estFinDePartie, true);
    assert.strictEqual(outcome.pointsAfter.a, 5);
    assert.strictEqual(outcome.pointsAfter.b, 1);
    assert.deepStrictEqual(outcome.ranking.map((r) => r.discordId), ["a", "b"]);
    // computeMancheOutcome ne mute jamais l'objet points fourni par l'appelant
    assert.deepStrictEqual(currentPoints, { a: 3, b: 1 });
  }

  // ── resolvePvP — 2-3 joueurs, pas de Croupier : la meilleure main non
  // bust l'emporte (2 pts), les autres perdent (0 pt) ──
  {
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" },
      b: { cards: [], score: 15, status: "stand", username: "Bob" },
      c: { cards: [], score: 25, status: "bust", username: "Chris" },
    };
    const results = resolvePvP(hands);
    const byId = Object.fromEntries(results.map((r) => [r.discordId, r]));
    assert.strictEqual(byId.a.result, "win");
    assert.strictEqual(byId.b.result, "lose");
    assert.strictEqual(byId.c.result, "lose");
  }

  // ── resolvePvP — égalité au sommet entre 2 joueurs : les 2 se partagent
  // 1 point chacun (push), le 3e perd ──
  {
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" },
      b: { cards: [], score: 20, status: "stand", username: "Bob" },
      c: { cards: [], score: 18, status: "stand", username: "Chris" },
    };
    const results = resolvePvP(hands);
    const byId = Object.fromEntries(results.map((r) => [r.discordId, r]));
    assert.strictEqual(byId.a.result, "push");
    assert.strictEqual(byId.b.result, "push");
    assert.strictEqual(byId.c.result, "lose");
  }

  // ── resolvePvP — tout le monde bust : personne ne gagne la manche ──
  {
    const hands = {
      a: { cards: [], score: 22, status: "bust", username: "Alice" },
      b: { cards: [], score: 24, status: "bust", username: "Bob" },
    };
    const results = resolvePvP(hands);
    assert.ok(results.every((r) => r.result === "lose"));
  }

  // ── computeMancheOutcome — 2-3 joueurs (maxPlayers > 1) : résolution PvP,
  // pas face au Croupier (state.dealer ignoré, même s'il vaut { score: 18 }
  // dans baseState) ──
  {
    const state = baseState({ maxPlayers: 3, manche: 1, totalManches: 5 });
    const hands = {
      a: { cards: [], score: 20, status: "stand", username: "Alice" }, // meilleure main -> 2 pts
      b: { cards: [], score: 18, status: "stand", username: "Bob" }, // perd contre Alice, PAS d'égalité avec un Croupier -> 0 pt
    };
    const outcome = computeMancheOutcome(state, hands, {});
    assert.strictEqual(outcome.pointsAfter.a, 2);
    assert.strictEqual(outcome.pointsAfter.b ?? 0, 0);
  }

  console.log("✓ blackjackDuel service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
