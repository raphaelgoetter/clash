import assert from "assert";
import fs from "fs";
import { computeCloture, isTooSoonSinceLastClosure } from "./draftroyale.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/draftroyale/draftroyale.json", import.meta.url), "utf8"));

function main() {
  const partie = { familles: ["a", "b", "c", "d", "e"], marche: ["a", "c"], reserve: ["b", "b", "d", "d", "d", "e", "e", "e"] };
  const joueursAvant = {
    p1: { username: "p1", main: ["a", "a", "a", "b"], joker: 0, points: 0, carres: 0, arrivee: 0 },
    p2: { username: "p2", main: ["c", "c", "d", "e"], joker: 0, points: 0, carres: 0, arrivee: 1 },
  };

  // ── Jour ordinaire sans carré : échange, pas de décompte ni classement ──
  {
    const r = computeCloture({ jour: 2, joueursAvant, actionsRaw: { p2: { prise: "c", depot: "e" } }, partie, config: CONFIG });
    assert.deepStrictEqual(r.scores, []);
    assert.strictEqual(r.final, null);
    assert.deepStrictEqual([...r.joueursApres.p2.main].sort(), ["c", "c", "c", "d"]);
    assert.ok(r.partieApres.marche.includes("e") && !r.partieApres.marche.includes("c"));
    assert.deepStrictEqual(r.partieApres.familles, partie.familles);
  }

  // ── Quadruplé : points et nouvelle main pour son auteur, la partie continue
  {
    const r = computeCloture({ jour: 3, joueursAvant, actionsRaw: { p1: { prise: "a", depot: "b" } }, partie, config: CONFIG });
    assert.deepStrictEqual(r.carres, ["p1"]);
    assert.ok(!r.joueursApres.p1.main.includes("a"));
    assert.strictEqual(r.joueursApres.p1.points, CONFIG.points_carre);
    assert.strictEqual(r.joueursApres.p2.points, 0);
    assert.strictEqual(r.final, null);
  }

  // ── Dernier jour : décompte pour tous et classement final ─────────────
  {
    const r = computeCloture({ jour: CONFIG.duree_jours, joueursAvant, actionsRaw: {}, partie, config: CONFIG });
    assert.deepStrictEqual(r.final.map((x) => [x.discordId, x.score]), [["p1", 3], ["p2", 2]]);
  }

  assert.strictEqual(isTooSoonSinceLastClosure(null), false);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date().toISOString()), true);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(Date.now() - 9 * 3_600_000).toISOString()), false);

  console.log("draftroyale.test.js : OK");
}

main();
