import assert from "assert";
import { Redis } from "@upstash/redis";
import { isNewHighScore, majHighScore } from "./grilleDuel.js";

// ── isNewHighScore : record strictement battu, jamais un score nul ──
assert.strictEqual(isNewHighScore(null, 75), true);
assert.strictEqual(isNewHighScore(null, 0), false);
assert.strictEqual(isNewHighScore({ points: 75 }, 60), false);
assert.strictEqual(isNewHighScore({ points: 75 }, 75), false); // égalité : le détenteur garde le record
assert.strictEqual(isNewHighScore({ points: 75 }, 80), true);

// ── majHighScore : écrit seulement un record battu (Redis en mémoire) ──
if (Redis.isFake) {
  const now = new Date("2026-10-27T20:00:00Z");
  assert.deepStrictEqual(await majHighScore("1", "libertade", 75, now), {
    discordId: "1",
    username: "libertade",
    points: 75,
    at: now.toISOString(),
  });
  assert.strictEqual((await majHighScore("2", "nb", 60, now)).username, "libertade");
  assert.strictEqual((await majHighScore("2", "nb", 81, now)).points, 81);
}

console.log("grilleDuel.test.js OK");
