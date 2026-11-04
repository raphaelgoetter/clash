import assert from "assert";
import { Redis } from "@upstash/redis";
import { valider } from "./bacRules.js";
import { accepterMots, agirDuel, chargerAjouts, enregistrerContestation, retirerAjouts, isNewRecord, lireContestations, lireRecord, nouveauDuel, pvpAbandonnee, serieApres, viderContestations, INACTIVITE_PVP_MS } from "./bacDuel.js";

// ── serieApres : +1 par victoire, 0 par défaite, intacte sur un nul ──
assert.strictEqual(serieApres(3, "victoire"), 4);
assert.strictEqual(serieApres(3, "defaite"), 0);
assert.strictEqual(serieApres(3, "nul"), 3);

// ── isNewRecord : record strictement battu, jamais une série nulle ──
assert.strictEqual(isNewRecord(null, 1), true);
assert.strictEqual(isNewRecord(null, 0), false);
assert.strictEqual(isNewRecord({ serie: 7 }, 7), false);
assert.strictEqual(isNewRecord({ serie: 7 }, 8), true);

// ── 1v1 abandonné après INACTIVITE_PVP_MS sans action ──
assert.strictEqual(pvpAbandonnee({ statut: "enCours", dernierCoupAt: 0 }, INACTIVITE_PVP_MS), false);
assert.strictEqual(pvpAbandonnee({ statut: "enCours", dernierCoupAt: 0 }, INACTIVITE_PVP_MS + 1), true);
assert.strictEqual(pvpAbandonnee({ statut: "lobby", dernierCoupAt: 0 }, INACTIVITE_PVP_MS + 1), false);

// ── Contre Kévina (Redis en mémoire) ──
if (Redis.isFake) {
  const now = new Date("2026-11-03T20:00:00Z");
  const finir = (gagnant) => agirDuel("1", (d) => Object.assign(d, { termine: true, gagnant }), { nom: "libertade", now });

  await nouveauDuel("1", { preparer: (d) => (d.prepare = true) });
  assert.strictEqual((await finir("joueur")).duel.prepare, true);
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

  // Difficile : série et record à part, la série normale reste intacte
  await nouveauDuel("1", { difficulte: "difficile" });
  const dif = (await finir("joueur")).duel;
  assert.deepStrictEqual([dif.difficulte, dif.series.avant, dif.series.serie], ["difficile", 0, 1]);
  assert.strictEqual((await lireRecord("bot", "difficile")).serie, 1);
  assert.strictEqual((await lireRecord("bot")).serie, 2);
  await nouveauDuel("1");
  assert.strictEqual((await finir("joueur")).duel.series.serie, 2);
}

// ── Contestations : regroupées par thème et mot normalisé ──
if (Redis.isFake) {
  const now = new Date("2026-11-03T20:00:00Z");
  await enregistrerContestation({ theme: "acteurs", lettre: "P", mot: "Pattinson", pseudo: "A", now });
  await enregistrerContestation({ theme: "acteurs", lettre: "P", mot: "pattinson", pseudo: "B", now });
  const [c] = await lireContestations();
  assert.deepStrictEqual([c.champ, c.nb, c.joueurs, c.lettres], ["acteurs:pattinson", 2, ["A", "B"], ["P"]]);
  await viderContestations([c.champ]);
  assert.deepStrictEqual(await lireContestations(), []);
}

// ── Mots acceptés : valables tout de suite, contestation retirée ──
if (Redis.isFake) {
  assert.strictEqual(valider("fruits", "R", "rhubarbe").ok, false);
  await enregistrerContestation({ theme: "fruits", lettre: "R", mot: "rhubarbe", pseudo: "A", now: new Date(0) });
  await accepterMots([{ theme: "fruits", mot: "Rhubarbe" }, { theme: "musique", mot: "Rim'K" }]);
  assert.deepStrictEqual(await lireContestations(), []);
  assert.deepStrictEqual(await chargerAjouts(), { fruits: ["Rhubarbe"], musique: ["Rim'K"] });
  assert.strictEqual(valider("fruits", "R", "rhubarbes").ok, true);
  assert.strictEqual(valider("musique", "R", "rimk").ok, true); // personne : nom complet
  await retirerAjouts(["fruits:rhubarbe", "musique:rimk"]);
  await chargerAjouts();
  assert.strictEqual(valider("fruits", "R", "rhubarbe").ok, false);
}

console.log("bacDuel.test.js OK");
