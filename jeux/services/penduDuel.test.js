import assert from "assert";
import { Redis } from "@upstash/redis";
import { proposerMot } from "./penduRules.js";
import { agirPvp, isNewRecord, lireRecord, ouvrirPvp, pvpAbandonnee, readPvp, rejoindrePvp, serieApres, INACTIVITE_PVP_MS } from "./penduDuel.js";

// ── serieApres : +1 par victoire, 0 par défaite, intacte sur un nul ──
assert.strictEqual(serieApres(3, "victoire"), 4);
assert.strictEqual(serieApres(3, "defaite"), 0);
assert.strictEqual(serieApres(3, "nul"), 3);

// ── isNewRecord : record strictement battu, jamais une série nulle ──
assert.strictEqual(isNewRecord(null, 1), true);
assert.strictEqual(isNewRecord(null, 0), false);
assert.strictEqual(isNewRecord({ serie: 7 }, 7), false);

// ── Partie abandonnée après INACTIVITE_PVP_MS sans action ──
assert.strictEqual(pvpAbandonnee({ statut: "enCours", dernierCoupAt: 0 }, INACTIVITE_PVP_MS + 1), true);
assert.strictEqual(pvpAbandonnee({ statut: "lobby", dernierCoupAt: 0 }, INACTIVITE_PVP_MS + 1), false);

// ── Partie complète (Redis en mémoire) ──
if (Redis.isFake) {
  const t0 = Date.parse("2026-11-03T20:00:00Z");
  const { partie } = await ouvrirPvp({ channelId: "salon", lanceur: "A", nom: "Alice" });
  assert.strictEqual(partie.statut, "lobby");
  assert.ok((await ouvrirPvp({ channelId: "salon", lanceur: "C", nom: "Chloé" })).dejaEnCours);
  await agirPvp((p) => rejoindrePvp(p, "B", "Bob", { now: t0, rng: () => 0.1 }), { now: t0 });
  const p = await readPvp();
  assert.deepStrictEqual(p.sieges, { joueur: "A", bot: "B" });

  // Alice trouve ; Bob ne joue plus : pendu au délai, au premier passage après
  await agirPvp((x) => {
    proposerMot(x.duel, "joueur", x.duel.mot, { now: t0 + 10_000 });
    return { coup: true };
  }, { now: t0 + 10_000 });
  const { partie: fin, resultat } = await agirPvp(() => ({}), { now: t0 + 61_000 });
  assert.deepStrictEqual(resultat.delais, ["bot"]);
  assert.strictEqual(resultat.vientDeFinir, true);
  assert.deepStrictEqual([fin.statut, fin.duel.gagnant, fin.series.joueur.serie, fin.series.bot.serie], ["fini", "joueur", 1, 0]);
  assert.strictEqual((await lireRecord()).username, "Alice");

  // Partie finie : une nouvelle peut s'ouvrir
  assert.strictEqual((await ouvrirPvp({ channelId: "salon", lanceur: "C", nom: "Chloé" })).partie.statut, "lobby");
}

console.log("penduDuel.test.js OK");
