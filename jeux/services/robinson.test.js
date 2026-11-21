import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import {
  loadRobinsonConfig,
  tirerMeteo,
  prevoirMeteo,
  rendement,
  besoinNuit,
  repasDeLaNuit,
  planchesRequises,
  radeauPret,
  stocksDuSoir,
  resoudreNuit,
  computeMancheScore,
  isTooSoonSinceLastClosure,
  groupesBadge,
  recordVote,
  readVote,
  tallyVotes,
  embarquer,
  readABord,
  readJoursJoues,
  resetRobinson,
  readState,
} from "./robinson.js";
import { decodePlateau, encodePlateau, buildPlateauSvg } from "./robinsonImage.js";
import { postRobinson, outcomeLabel } from "../discord/handlers/robinson.js";

const config = await loadRobinsonConfig();
const suite = (valeurs) => {
  let i = 0;
  return () => valeurs[i++ % valeurs.length];
};
const ZERO = { poisson: 0, eau: 0, bois: 0 };

test("tirage météo : respecte les poids", () => {
  // Poids 45/25/20/10 sur 100 : bornes 0,45 / 0,70 / 0,90
  assert.equal(tirerMeteo(config, () => 0), "soleil");
  assert.equal(tirerMeteo(config, () => 0.449), "soleil");
  assert.equal(tirerMeteo(config, () => 0.45), "nuages");
  assert.equal(tirerMeteo(config, () => 0.75), "pluie");
  assert.equal(tirerMeteo(config, () => 0.95), "tempete");
});

test("prévision : juste sous la fiabilité, sinon une autre météo", () => {
  assert.equal(prevoirMeteo("pluie", config, () => 0.74), "pluie");
  for (const x of [0, 0.4, 0.99]) {
    const fausse = prevoirMeteo("pluie", config, suite([0.8, x]));
    assert.notEqual(fausse, "pluie");
    assert.ok(config.meteos[fausse]);
  }
});

test("rendements et repas", () => {
  assert.equal(rendement(config, "soleil", "peche"), 5);
  assert.equal(rendement(config, "pluie", "eau"), 6);
  assert.equal(rendement(config, "tempete", "bois"), 2);
  assert.equal(rendement(config, "soleil", "radeau"), 0);
  assert.deepEqual(besoinNuit(5, config), { poisson: 5, eau: 5, bois: 3 });
  assert.equal(repasDeLaNuit(1, 10, config), null, "nuit 1 gratuite");
  assert.equal(repasDeLaNuit(3, 0, config), null, "personne à nourrir");
  assert.deepEqual(repasDeLaNuit(2, 4, config), { poisson: 4, eau: 4, bois: 2 });
});

test("Radeau prêt : 2 planches par joueur du jour, au moins un joueur", () => {
  assert.equal(planchesRequises(12, config), 24);
  assert.equal(radeauPret(24, 12, config), true);
  assert.equal(radeauPret(23, 12, config), false);
  assert.equal(radeauPret(10, 0, config), false);
});

test("stocks du soir : récoltes puis repas, sans plancher", () => {
  const { soir, recoltes } = stocksDuSoir({ poisson: 3, eau: 0, bois: 1 }, { peche: 2, bois: 1 }, 4, 2, "soleil", config);
  assert.deepEqual(recoltes, { poisson: 10, eau: 0, bois: 5 });
  assert.deepEqual(soir, { poisson: 9, eau: -4, bois: 4 });
});

const nuit = (over) =>
  resoudreNuit({ jour: 3, stocks: { poisson: 10, eau: 10, bois: 10 }, planches: 0, counts: {}, V: 0, nbABord: 0, meteo: "nuages", meteoAube: "soleil", config, ...over });

test("nuit : famine dès qu'une ressource manque, stocks affichés à 0", () => {
  const r = nuit({ counts: { peche: 1, bois: 1 }, V: 3, stocks: { poisson: 0, eau: 2, bois: 0 } });
  assert.equal(r.issue, "defaite");
  assert.equal(r.cause, "famine");
  assert.deepEqual(r.manque, ["eau"]);
  assert.equal(r.stocks.eau, 0);
  // Exactement assez : pas de famine
  assert.equal(nuit({ counts: { peche: 1, bois: 1 }, V: 3, stocks: { poisson: 0, eau: 3, bois: 0 } }).issue, null);
});

test("nuit 1 : pas de repas", () => {
  const r = nuit({ jour: 1, stocks: ZERO, counts: { radeau: 2 }, V: 2, meteoAube: "pluie" });
  assert.equal(r.issue, null);
  assert.equal(r.repas, null);
  assert.equal(r.planches, 2);
});

test("aube : départ seulement au soleil, Radeau prêt et quelqu'un à bord", () => {
  const prêt = { planches: 6, counts: { peche: 1, eau: 1, bois: 1 }, V: 3 };
  assert.equal(nuit({ ...prêt, nbABord: 1 }).issue, "victoire_radeau");
  assert.equal(nuit({ ...prêt, nbABord: 0 }).issue, null, "personne à bord");
  assert.equal(nuit({ ...prêt, nbABord: 3, meteoAube: "pluie" }).issue, null, "pas de soleil");
  assert.equal(nuit({ ...prêt, planches: 5, nbABord: 3 }).issue, null, "pas assez de planches");
  // Les planches du jour comptent
  assert.equal(nuit({ planches: 5, counts: { radeau: 1, peche: 1, eau: 1 }, V: 3, nbABord: 1 }).issue, "victoire_radeau");
  // Repas avant l'aube : une famine empêche le départ
  assert.equal(nuit({ ...prêt, nbABord: 1, stocks: ZERO, counts: { radeau: 3 } }).cause, "famine");
});

test("dernier jour sans départ : défaite « pas de départ »", () => {
  const r = nuit({ jour: config.duree_jours, counts: { peche: 1, eau: 1, bois: 1 }, V: 3, meteoAube: "tempete" });
  assert.equal(r.issue, "defaite");
  assert.equal(r.cause, "pas_de_depart");
});

test("score de manche : départ plus tôt = mieux, toute victoire bat toute défaite", () => {
  const d = config.duree_jours;
  assert.equal(computeMancheScore("victoire_radeau", 5, d), 1004);
  assert.equal(computeMancheScore("victoire_radeau", 8, d), 1001);
  assert.ok(computeMancheScore("victoire_radeau", 8, d) > computeMancheScore("victoire_jour11", 8, d));
  assert.equal(computeMancheScore("defaite", 6, d), 6);
  assert.equal(outcomeLabel("victoire_jour11"), "🚢 Victoire (survie)");
});

test("garde-fou anti-double-avancée", () => {
  const now = Date.UTC(2026, 10, 21, 12);
  assert.equal(isTooSoonSinceLastClosure(new Date(now - 2 * 3_600_000).toISOString(), now), true);
  assert.equal(isTooSoonSinceLastClosure(new Date(now - 20 * 3_600_000).toISOString(), now), false);
});

test("badge : groupes par jours joués, partis et restés", () => {
  const jours = { a: 7, b: 7, c: 3, d: 1 };
  assert.deepEqual(groupesBadge(jours).tous, [
    { jours: 7, ids: ["a", "b"] },
    { jours: 3, ids: ["c"] },
    { jours: 1, ids: ["d"] },
  ]);
  const { partis, restes } = groupesBadge(jours, { a: "5", c: "6" });
  assert.deepEqual(partis, [{ jours: 7, ids: ["a"] }, { jours: 3, ids: ["c"] }]);
  assert.deepEqual(restes, [{ jours: 7, ids: ["b"] }, { jours: 1, ids: ["d"] }]);
});

test("image : la vraie météo de demain n'est jamais encodée, rendu sans erreur", () => {
  const d = encodePlateau({
    jour: 4,
    duree: 7,
    meteo: "soleil",
    prevision: "pluie",
    passees: ["nuages", "pluie", "tempete"],
    stocks: { poisson: 18, eau: 9, bois: 7 },
    besoin: { poisson: 15, eau: 15, bois: 8 },
    planches: 14,
    objectif: 30,
    aBord: 0,
  });
  const p = decodePlateau(d);
  assert.equal(p.prevision, "pluie");
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(d, "base64url").toString())).sort(), ["a", "b", "d", "h", "j", "m", "o", "p", "pl", "s"]);
  assert.equal(decodePlateau("n'importe quoi"), null);
  assert.ok(buildPlateauSvg(p, config).startsWith("<svg"));
});

if (Redis.isFake) {
  test("votes : définitifs, jours joués comptés une fois, embarquement durable", async () => {
    await resetRobinson({ clearManches: true });
    assert.deepEqual(await recordVote(1, "u1", "peche", "Alice"), { status: "recorded" });
    assert.deepEqual(await recordVote(1, "u1", "peche", "Alice"), { status: "already_recorded" });
    assert.deepEqual(await recordVote(1, "u1", "eau", "Alice"), { status: "rejected", existing: "peche" });
    await recordVote(1, "u2", "radeau", "Bob");
    await recordVote(2, "u1", "bois", "Alice");
    assert.deepEqual(await tallyVotes(1), { peche: 1, radeau: 1 });
    assert.equal(await readVote(1, "u3"), null);
    assert.deepEqual(await readJoursJoues(), { u1: 2, u2: 1 });
    assert.equal(await embarquer("u1", 2), true);
    assert.equal(await embarquer("u1", 3), false, "déjà à bord");
    assert.deepEqual(await readABord(), { u1: "2" });
    await resetRobinson({ clearManches: true });
  });

  test("partie : jamais de ping hors public, PNJ en test, Components V2, anti-spoiler", async () => {
    await resetRobinson({ clearManches: true });
    const vraiFetch = globalThis.fetch;
    const tokenAvant = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test";
    const appels = [];
    globalThis.fetch = async (url, opts = {}) => {
      appels.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null });
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    };
    try {
      // noPing: false volontaire : le verrou interne doit suffire hors public
      for (let i = 0; i < 3; i++) await postRobinson("salon-test", { force: true, noPing: false, isPublic: false, pnj: true });
      const posts = appels.filter((a) => a.method === "POST");
      assert.equal(posts.length, 3);
      for (const p of posts) {
        assert.equal(p.body.flags, 1 << 15, "Components V2");
        assert.ok(!JSON.stringify(p.body).includes("<@"), "aucune mention");
      }
      assert.ok(appels.every((a) => !a.url.includes("/roles")), "aucune lecture des rôles");
      const state = await readState();
      assert.equal(state.jour, 2);
      assert.equal(Object.keys(await readJoursJoues()).filter((id) => id.startsWith("pnj-")).length, 5);
      // La vraie météo de demain n'apparaît dans aucun message
      const envoye = JSON.stringify(appels.filter((a) => a.body).map((a) => a.body));
      const d = envoye.match(/plateau\?d=([A-Za-z0-9_-]+)/g).map((m) => decodePlateau(m.split("=")[1]));
      assert.ok(d.every((p) => !("meteoSuivante" in p)));

      // Salon public : jamais de PNJ, même demandés
      await resetRobinson({ clearManches: true });
      await postRobinson("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      await postRobinson("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      assert.deepEqual(await readJoursJoues(), {});
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetRobinson({ clearManches: true });
    }
  });
}
