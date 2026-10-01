import assert from "assert";
import { applyJoin, isMancheReady, isStale, isNewHighScore } from "./elixirDuel.js";

function baseState(overrides = {}) {
  return { maxPlayers: 2, totalManches: 5, manche: 1, players: [], rosterLocked: false, ...overrides };
}

async function main() {
  // ── applyJoin ──
  {
    const decision = applyJoin(baseState({ players: ["a"] }), "b");
    assert.strictEqual(decision.allowed, true);
    assert.deepStrictEqual(decision.players, ["a", "b"]);
    assert.strictEqual(decision.rosterLocked, true);
    assert.strictEqual(applyJoin(baseState({ players: ["a", "b"], rosterLocked: true }), "c").allowed, false);
    assert.strictEqual(applyJoin(baseState({ players: ["a"] }), "a").isSeated, true);
  }

  // ── isMancheReady : tous les sièges pris et toutes les offres posées ──
  {
    assert.strictEqual(isMancheReady(baseState({ players: ["a"] }), { a: { card: 0, bid: 3 } }), false);
    assert.strictEqual(isMancheReady(baseState({ players: ["a", "b"] }), { a: { card: 0, bid: 3 } }), false);
    assert.strictEqual(isMancheReady(baseState({ players: ["a", "b"] }), { a: { card: 0, bid: 3 }, b: { card: null, bid: 0 } }), true);
    // Solo : l'offre du bot est déjà posée, seul le joueur compte
    assert.strictEqual(isMancheReady(baseState({ maxPlayers: 1, players: ["a"] }), { bot: { card: 1, bid: 2 }, a: { card: 0, bid: 3 } }), true);
  }

  // ── isStale / isNewHighScore ──
  {
    const now = Date.now();
    assert.strictEqual(isStale(baseState({ lastActivityAt: new Date(now - 3 * 3_600_000).toISOString() }), now), true);
    assert.strictEqual(isStale(baseState({ lastActivityAt: new Date(now - 3_600_000).toISOString() }), now), false);
    assert.strictEqual(isNewHighScore(null, 5), true);
    assert.strictEqual(isNewHighScore({ points: 5 }, 5), false);
  }

  console.log("✓ elixirDuel tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
