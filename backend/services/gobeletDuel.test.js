import assert from "assert";
import { applyJoin, isMancheReady, computeMancheOutcome, buildRanking } from "./gobeletDuel.js";

function baseState(overrides = {}) {
  return {
    maxPlayers: 2,
    totalManches: 5,
    manche: 1,
    players: [],
    rosterLocked: false,
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

  // ── isMancheReady — roster incomplet : jamais résolue, même si le seul
  // inscrit a fini (sinon la partie se verrouille en solo) ──
  {
    const state = baseState({ players: ["a"] });
    assert.strictEqual(isMancheReady(state, { a: { status: "termine" } }), false);
  }

  // ── isMancheReady — roster complet : résolue seulement quand tous ont fini ──
  {
    const state = baseState({ players: ["a", "b"] });
    assert.strictEqual(isMancheReady(state, { a: { status: "termine" } }), false);
    assert.strictEqual(isMancheReady(state, { a: { status: "termine" }, b: { status: "en_cours" } }), false);
    assert.strictEqual(isMancheReady(state, { a: { status: "termine" }, b: { status: "termine" } }), true);
  }

  // ── isMancheReady — solo (1 place) : résolue dès que le joueur a fini ──
  {
    const state = baseState({ maxPlayers: 1, players: ["a"] });
    assert.strictEqual(isMancheReady(state, { a: { status: "termine" } }), true);
  }

  // ── computeMancheOutcome — manche intermédiaire : pas de classement final ──
  // Le score gagné est directement les points de la catégorie retenue (pas
  // de barème win/push/lose comme Blackjack).
  {
    const state = baseState({ manche: 1, totalManches: 5 });
    const hands = {
      a: { dice: [1, 2, 3, 4, 5], status: "termine", category: "Grande Suite", points: 50, username: "Alice" },
      b: { dice: [1, 1, 2, 3, 4], status: "termine", category: "Aucune combinaison", points: 11, username: "Bob" },
    };
    const outcome = computeMancheOutcome(state, hands, {});
    assert.strictEqual(outcome.estFinDePartie, false);
    assert.strictEqual(outcome.mancheSuivante, 2);
    assert.strictEqual(outcome.ranking, null);
    assert.strictEqual(outcome.pointsAfter.a, 50);
    assert.strictEqual(outcome.pointsAfter.b, 11);
  }

  // ── computeMancheOutcome — dernière manche : classement final cumulé ──
  {
    const state = baseState({ manche: 5, totalManches: 5 });
    const hands = {
      a: { dice: [6, 6, 6, 6, 6], status: "termine", category: "Gobelet", points: 60, username: "Alice" },
      b: { dice: [1, 2, 3, 5, 6], status: "termine", category: "Aucune combinaison", points: 17, username: "Bob" },
    };
    const currentPoints = { a: 20, b: 30 };
    const outcome = computeMancheOutcome(state, hands, currentPoints);
    assert.strictEqual(outcome.estFinDePartie, true);
    assert.strictEqual(outcome.pointsAfter.a, 80);
    assert.strictEqual(outcome.pointsAfter.b, 47);
    assert.deepStrictEqual(outcome.ranking.map((r) => r.discordId), ["a", "b"]);
    // computeMancheOutcome ne mute jamais l'objet points fourni par l'appelant
    assert.deepStrictEqual(currentPoints, { a: 20, b: 30 });
  }

  // ── computeMancheOutcome — une main encore "en_cours" est figée, jamais ignorée ──
  {
    const state = baseState({ manche: 1, totalManches: 5 });
    const hands = {
      a: { dice: [6, 6, 6, 6, 6], status: "en_cours", category: null, points: null, username: "Alice" },
    };
    const outcome = computeMancheOutcome(state, hands, {});
    assert.strictEqual(outcome.results[0].category, "Gobelet");
    assert.strictEqual(outcome.pointsAfter.a, 60);
  }

  console.log("✓ gobeletDuel service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
