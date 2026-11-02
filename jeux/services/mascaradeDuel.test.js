import assert from "assert";
import { Redis } from "@upstash/redis";
import { agirDuel, isNewRecord, lireRecord, nouveauDuel, serieApres, verifierDelaiSolo } from "./mascaradeDuel.js";

// ── serieApres : +1 par victoire, 0 par défaite, intacte sur un nul ──
assert.strictEqual(serieApres(3, "victoire"), 4);
assert.strictEqual(serieApres(3, "defaite"), 0);
assert.strictEqual(serieApres(3, "nul"), 3);

// ── isNewRecord : record strictement battu, jamais une série nulle ──
assert.strictEqual(isNewRecord(null, 1), true);
assert.strictEqual(isNewRecord(null, 0), false);
assert.strictEqual(isNewRecord({ serie: 7 }, 7), false); // égalité : le détenteur garde le record
assert.strictEqual(isNewRecord({ serie: 7 }, 8), true);

// ── verifierDelaiSolo : action contre Kévina en retard = défaite ──
{
  const config = { delai_tour_minutes: 1 };
  const d = { termine: false, tourDepuis: 1_000_000, attente: null };
  assert.strictEqual(verifierDelaiSolo(d, config, 1_000_000 + 60_000), false);
  assert.strictEqual(verifierDelaiSolo(d, config, 1_000_000 + 60_001), true);
  assert.deepStrictEqual([d.termine, d.gagnant, d.delai], [true, "bot", true]);
  // Chrono décalé dans le futur (étapes encore affichées) : pas de délai
  assert.strictEqual(verifierDelaiSolo({ termine: false, tourDepuis: 2_000_000 }, config, 1_990_000), false);
}

// ── Contre Kévina (Redis en mémoire) ──
if (Redis.isFake) {
  const now = new Date("2026-10-27T20:00:00Z");
  const finir = (gagnant) => agirDuel("1", (d) => Object.assign(d, { termine: true, gagnant }), { nom: "libertade", now });

  await nouveauDuel("1");
  assert.deepStrictEqual((await finir("joueur")).duel.series.serie, 1);
  await nouveauDuel("1");
  assert.strictEqual((await finir("nul")).duel.series.serie, 1); // nul : série intacte
  await nouveauDuel("1");
  assert.strictEqual((await finir("joueur")).duel.series.serie, 2);
  assert.strictEqual((await lireRecord("bot")).serie, 2);

  // Partie abandonnée (relance sans finir) : comptée comme une défaite
  await nouveauDuel("1");
  await nouveauDuel("1");
  const { duel } = await finir("joueur");
  assert.deepStrictEqual([duel.series.avant, duel.series.serie], [0, 1]);
  assert.strictEqual((await lireRecord("bot")).serie, 2);
}

console.log("mascaradeDuel.test.js OK");
