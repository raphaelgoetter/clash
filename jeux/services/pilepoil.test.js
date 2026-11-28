import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import {
  jouerEssai,
  readPartie,
  readPointsMois,
  readJoursMois,
  readSerie,
  readState,
  readSolution,
  listParties,
  resetPilePoil,
  getHistoriqueEntry,
} from "./pilepoil.js";
import { postPilePoil, heurePublication, lignesClassementJour, lignesClassementMois } from "../discord/handlers/pilepoil.js";

test("heure de publication : 9 h en hiver, 10 h en été (cron à 8h02 UTC)", () => {
  assert.equal(heurePublication(new Date(Date.UTC(2026, 11, 3))), "9h");
  assert.equal(heurePublication(new Date(Date.UTC(2026, 6, 3))), "10h");
});

test("classements : jamais de mention, rang au point échappé", () => {
  const lignes = lignesClassementJour({ joueurs: 3, trouves: 2, parEssais: { 2: ["a"], 4: ["b"] }, rates: ["c"] }, { a: "Alice", b: "Bob", c: "Chloé" });
  assert.ok(lignes.some((l) => l.includes("🎯 **2 essais** : Alice")));
  assert.ok(lignes.some((l) => l.includes("❌ **Pas trouvé** : Chloé")));
  assert.ok(!lignes.join("").includes("<@"));
  const mois = lignesClassementMois(
    [
      { username: "A", points: 10, jours: 2 },
      { username: "B", points: 10, jours: 2 },
      { username: "C", points: 3, jours: 1 },
    ],
    5,
  );
  assert.deepEqual(mois.map((l) => l.split("\\.")[0]), ["1", "1", "3"]);
});

if (Redis.isFake) {
  test("essais : 6 au plus, points du jour, classement du mois et série (faux Redis)", async () => {
    await resetPilePoil("test");
    const opts = { solution: "47+38=85", essaisMax: 6, seasonId: 139, username: "Un" };
    assert.equal((await jouerEssai("test", 1, "u1", "4738", opts)).statut, "invalide");
    const r1 = await jouerEssai("test", 1, "u1", "123446", opts);
    assert.equal(r1.statut, "ok");
    assert.ok(!r1.partie.trouve);
    const r2 = await jouerEssai("test", 1, "u1", "473885", opts);
    assert.ok(r2.partie.trouve);
    assert.equal(r2.partie.points, 5);
    assert.equal((await jouerEssai("test", 1, "u1", "473885", opts)).statut, "termine");
    assert.equal((await readPointsMois("test", 139)).u1, 5);
    assert.equal((await readJoursMois("test", 139)).u1, 1, "un jour joué, pas un par essai");
    assert.equal((await readSerie("test", "u1")).serie, 1);

    // Six essais ratés : plus d'essai, 0 point mais classé
    for (let i = 0; i < 6; i++) await jouerEssai("test", 1, "u2", "000000", opts);
    assert.equal((await jouerEssai("test", 1, "u2", "473885", opts)).statut, "termine");
    assert.equal((await readPartie("test", 1, "u2")).essais.length, 6);
    assert.equal((await readPointsMois("test", 139)).u2, 0);
    // L'espace public n'est pas touché
    assert.equal(Object.keys(await listParties("public", 1)).length, 0);
    await resetPilePoil("test");
  });

  test("salon de test : jamais de ping, clés de test, 5 PNJ, récap du lendemain (faux Redis)", async () => {
    await resetPilePoil("test");
    await resetPilePoil("public");
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
      const jour1 = new Date(Date.UTC(2026, 10, 30, 8, 2));
      const jour2 = new Date(Date.UTC(2026, 11, 1, 8, 2));
      await postPilePoil("salon-test", { force: true, noPing: false, isPublic: false, pnj: true, now: jour1 });
      await postPilePoil("salon-test", { force: true, noPing: false, isPublic: false, pnj: true, now: jour2 });
      const posts = appels.filter((a) => a.method === "POST");
      assert.equal(posts.length, 2);
      for (const p of posts) {
        assert.equal(p.body.content, undefined);
        assert.equal(p.body.allowed_mentions, undefined);
        assert.ok(!JSON.stringify(p.body).includes("<@"), "aucune mention");
        assert.equal(p.body.flags, 1 << 15, "Components V2");
      }
      assert.ok(appels.every((a) => !a.url.includes("/roles")), "aucune lecture des rôles");
      assert.equal(Object.keys(await listParties("test", 1)).length, 5);
      assert.equal(Object.keys(await listParties("test", 2)).length, 5);
      // Le message du jour 2 révèle la solution du jour 1 et clôt novembre
      const texte = JSON.stringify(posts[1].body);
      assert.ok(texte.includes("Résultat d'hier (n°1)"));
      assert.ok(texte.includes("Classement final du mois de Novembre"));
      assert.equal((await getHistoriqueEntry("test", 1)).joueurs, 5);
      assert.equal((await readState("test")).jour, 2);
      assert.ok(await readSolution("test", 2));
      // Rien dans l'espace public
      assert.equal(await readState("public"), null);

      // Salon public : jamais de PNJ, même demandés ; ping seulement au lancement
      await postPilePoil("salon-public", { force: true, noPing: true, isPublic: true, pnj: true, now: jour1 });
      assert.equal(Object.keys(await listParties("public", 1)).length, 0);
      // Cron sur un jeu en pause : rien
      const state = await readState("public");
      const { writeState } = await import("./pilepoil.js");
      await writeState("public", { ...state, pause: true });
      assert.equal((await postPilePoil("salon-public", { isPublic: true, requireActiveState: true, now: jour2 })).reason, "pause");
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetPilePoil("test");
      await resetPilePoil("public");
    }
  });
}
