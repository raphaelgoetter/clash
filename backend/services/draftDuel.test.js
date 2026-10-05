import assert from "assert";
import fs from "fs";
import { nbJoueursEffectifs, botsDeLaPartie, isMancheReady, applyJoin, computeMancheDuel, isNewHighScore, isStale } from "./draftDuel.js";

const BOT_ID = "bot";
import { nbFamilles } from "./draftRules.js";

const RAW = JSON.parse(fs.readFileSync(new URL("../../data/draftroyale/draftroyale.json", import.meta.url), "utf8"));
const CONFIG = { ...RAW, familles: RAW.duel.familles };

function main() {
  // ── Bots : la table est complétée jusqu'à 3 joueurs ───────────────────
  assert.deepStrictEqual(botsDeLaPartie(1).map((b) => b.name), ["Kévina (bot)", "Josette (bot)"]);
  assert.deepStrictEqual(botsDeLaPartie(2).map((b) => b.name), ["Kévina (bot)"]);
  assert.strictEqual(botsDeLaPartie(3).length, 0);

  // ── Cartes en jeu : joueurs + 1, bots compris ─────────────────────────
  for (const n of [1, 2, 3]) assert.strictEqual(nbFamilles(nbJoueursEffectifs(n), CONFIG.familles), 4);

  // ── Manche prête : sièges pleins et tous les humains ont fini ─────────
  {
    const state = { players: ["a", "b"], maxPlayers: 2 };
    assert.strictEqual(isMancheReady(state, { a: { fini: true } }), false);
    assert.strictEqual(isMancheReady(state, { a: { fini: true }, b: { fini: true } }), true);
    assert.strictEqual(isMancheReady({ players: ["a"], maxPlayers: 2 }, { a: { fini: true } }), false);
  }

  // ── Inscription ────────────────────────────────────────────────────
  {
    const r = applyJoin({ players: ["a"], maxPlayers: 2, rosterLocked: false }, "b");
    assert.ok(r.allowed && r.rosterLocked);
    assert.strictEqual(applyJoin({ players: ["a", "b"], maxPlayers: 2, rosterLocked: true }, "c").allowed, false);
    assert.ok(applyJoin({ players: ["a", "b"], maxPlayers: 2, rosterLocked: true }, "a").isSeated);
  }

  // ── Manche : le bot choisit son échange à la résolution ───────────────
  {
    const state = { manche: 1, totalManches: 7, familles: ["a", "b", "c"], marche: ["a", "b", "c", "c", "c", "b", "b"] };
    const joueursAvant = {
      u1: { main: ["c", "c", "a", "b"], popularite: 0, points: 0 },
      [BOT_ID]: { main: ["a", "a", "a", "b"], popularite: 0, points: 0 },
    };
    const r = computeMancheDuel({ state, joueursAvant, actions: { u1: { prise: "c", depot: "a", fini: true } }, config: CONFIG });
    assert.deepStrictEqual(r.actions[BOT_ID], { prise: "a", depot: "b" });
    assert.deepStrictEqual(r.carres, [BOT_ID]);
    assert.strictEqual(r.joueurs[BOT_ID].points, CONFIG.points_carre);
    assert.strictEqual(r.joueurs.u1.points, 3);
    assert.ok(r.redistribution);
    assert.strictEqual(r.final, null);
  }

  // ── Dernière manche : classement final ────────────────────────────────
  {
    const state = { manche: 7, totalManches: 7, familles: ["a", "b", "c"], marche: ["b", "c"] };
    const joueursAvant = { u1: { username: "u1", main: ["a", "a", "b", "c"], popularite: 0, points: 4, arrivee: 0 } };
    const r = computeMancheDuel({ state, joueursAvant, actions: {}, config: CONFIG });
    assert.deepStrictEqual(r.final.map((x) => [x.discordId, x.score]), [["u1", 6]]);
  }

  // ── High score et inactivité ──────────────────────────────────────────
  assert.strictEqual(isNewHighScore(null, 10), true);
  assert.strictEqual(isNewHighScore({ points: 10 }, 10), false);
  assert.strictEqual(isNewHighScore(null, 0), false);
  assert.strictEqual(isStale({ termine: false, lastActivityAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), staleHours: 2 }), true);
  assert.strictEqual(isStale({ termine: false, lastActivityAt: new Date().toISOString(), staleHours: 2 }), false);

  console.log("draftDuel.test.js : OK");
}

main();
