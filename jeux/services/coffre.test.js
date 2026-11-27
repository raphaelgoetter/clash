import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import {
  IDS_SYMBOLES,
  tirerCode,
  reponse,
  essaiValide,
  pointsOuverture,
  tirerIndice,
  indiceDuJoueur,
  respecteIndice,
  texteIndice,
  rngDepuis,
  buildRanking,
  bilanJour,
  tousLesCodes,
  jourOuvert,
  heureOuverture,
  jouerEssai,
  readPartie,
  readPoints,
  readEssaisTotal,
  readCode,
  readState,
  listParties,
  resetCoffre,
} from "./coffre.js";
import { encodePlateau, decodePlateau } from "./coffreImage.js";
import {
  postCoffre,
  transitionPrete,
  majBrouillon,
  composantsPlateau,
  lireBrouillon,
  ecrireBrouillon,
} from "../discord/handlers/coffre.js";

// Instants fixes (heure de Paris en hiver = UTC+1, en été = UTC+2)
const A = (heureParis, jour = 20) => Date.UTC(2026, 10, jour, heureParis - 1, 30);
const E = (heureParis) => Date.UTC(2026, 6, 20, heureParis - 2, 30);

test("code : 4 symboles tous différents parmi les 6", () => {
  for (let i = 0; i < 50; i++) {
    const code = tirerCode(4);
    assert.equal(code.length, 4);
    assert.equal(new Set(code).size, 4);
    assert.ok(code.every((s) => IDS_SYMBOLES.includes(s)));
  }
  assert.equal(tousLesCodes(4).length, 360);
});

test("réponse : bien placés et mal placés", () => {
  const code = ["etoile", "coeur", "triangle", "losange"];
  assert.deepEqual(reponse(code, ["triangle", "carre", "etoile", "coeur"]), { bien: 0, mal: 3 });
  assert.deepEqual(reponse(code, ["etoile", "coeur", "triangle", "rond"]), { bien: 3, mal: 0 });
  assert.deepEqual(reponse(code, code), { bien: 4, mal: 0 });
  assert.deepEqual(reponse(code, ["rond", "carre", "losange", "etoile"]), { bien: 0, mal: 2 });
});

test("essai valide : 4 symboles connus et différents", () => {
  assert.ok(essaiValide(["rond", "carre", "losange", "etoile"]));
  assert.ok(!essaiValide(["rond", "rond", "losange", "etoile"]));
  assert.ok(!essaiValide(["rond", "carre", "losange"]));
  assert.ok(!essaiValide(["rond", "carre", "losange", null]));
  assert.ok(!essaiValide(["rond", "carre", "losange", "licorne"]));
});

test("points : 5 au premier essai, 1 au cinquième", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => pointsOuverture(n, 5)), [5, 4, 3, 2, 1]);
});

test("indice : toujours vrai, reproductible et propre à chaque joueur", () => {
  for (let i = 0; i < 300; i++) {
    const code = tirerCode(4);
    const indice = tirerIndice(code, Math.random);
    assert.ok(respecteIndice(code, indice), JSON.stringify({ code, indice }));
  }
  const code = ["etoile", "coeur", "triangle", "losange"];
  assert.deepEqual(indiceDuJoueur(code, "p1", 2, "u1"), indiceDuJoueur(code, "p1", 2, "u1"));
  const differents = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(indiceDuJoueur(code, "p1", 2, `u${i}`))));
  assert.ok(differents.size > 5, "des indices variés selon les joueurs");
  assert.equal(texteIndice({ type: "position", symbole: "triangle", position: 2 }), "🔺 est en 3e place");
  assert.equal(texteIndice({ type: "ailleurs", symbole: "rond", position: 0 }), "🟣 est dans le code, mais pas en 1re place");
  assert.notEqual(rngDepuis("a")(), rngDepuis("b")());
});

test("classement : points puis le moins d'essais", () => {
  const r = buildRanking({ a: 9, b: 9, c: 12 }, { a: 14, b: 11, c: 20 });
  assert.deepEqual(r.map((x) => x.discordId), ["c", "b", "a"]);
});

test("bilan du jour : joueurs, ouvertures, meilleur", () => {
  const b = bilanJour({
    a: { essais: [1, 2, 3], ouvert: true },
    b: { essais: [1, 2], ouvert: true },
    c: { essais: [1, 2, 3, 4, 5], ouvert: false },
  });
  assert.equal(b.joueurs, 3);
  assert.equal(b.ouverts, 2);
  assert.equal(b.meilleur, 2);
  assert.deepEqual(b.parEssais, { 2: 1, 3: 1 });
});

test("horaires : coffre fermé de minuit au cron, ouverture 8h30 l'hiver, 9h30 l'été", () => {
  assert.equal(heureOuverture(A(12)), 8);
  assert.equal(heureOuverture(E(12)), 9);
  const publie = new Date(A(8)).toISOString();
  assert.ok(jourOuvert(publie, A(23)));
  assert.ok(!jourOuvert(publie, A(1, 21)), "après minuit");
  assert.ok(!jourOuvert(publie, A(10, 21)), "jour de jeu suivant");
});

test("transition : annonce 8 h au moins, puis jour de jeu suivant", () => {
  const annonce = { phase: "annonce", publishedAt: new Date(A(10)).toISOString() };
  assert.ok(!transitionPrete(annonce, A(15)));
  assert.ok(transitionPrete(annonce, A(9, 21)));
  const jour = { phase: "jour", jour: 2, publishedAt: new Date(A(9)).toISOString() };
  assert.ok(!transitionPrete(jour, A(23)));
  assert.ok(transitionPrete(jour, A(9, 21)));
});

test("plateau : encodé dans l'URL et décodé à l'identique, rejet des valeurs fausses", () => {
  const plateau = {
    jour: 3,
    duree: 7,
    essaisMax: 5,
    essais: [{ symboles: ["etoile", "coeur", "triangle", "rond"], bien: 3, mal: 0 }],
    ouvert: false,
    points: 0,
    indice: { type: "ailleurs", symbole: "triangle", position: 0 },
  };
  assert.deepEqual(decodePlateau(encodePlateau(plateau)), plateau);
  assert.equal(decodePlateau("n'importe quoi"), null);
  const faux = Buffer.from(JSON.stringify({ j: 1, n: 7, m: 5, e: ["0123x0"], o: 0, p: 0, i: null })).toString("base64url");
  assert.equal(decodePlateau(faux), null);
});

test("brouillon : menus, symbole déplacé, Essayer actif seulement avec 4 symboles", () => {
  assert.deepEqual(lireBrouillon("01xx"), ["rond", "carre", null, null]);
  assert.equal(ecrireBrouillon(["rond", null, "etoile", null]), "0x3x");
  const vide = composantsPlateau(2, [null, null, null, null]);
  assert.equal(vide.length, 5, "4 menus + 1 rangée de boutons");
  assert.ok(vide[4].components[0].disabled);
  // Le symbole choisi quitte son ancienne place
  const message = { components: composantsPlateau(2, ["rond", "carre", "losange", null]) };
  const apres = majBrouillon(message, 2, 3, "rond");
  assert.equal(apres[4].components[0].custom_id, "coffre_essai:2:x120");
  const complet = majBrouillon(message, 2, 3, "etoile");
  assert.equal(complet[4].components[0].custom_id, "coffre_essai:2:0123");
  assert.ok(!complet[4].components[0].disabled);
  assert.ok(complet[3].components[0].options.find((o) => o.value === "etoile").default);
  // Libellés des menus ≤ 100 caractères (limite Discord)
  for (const row of vide.slice(0, 4)) for (const o of row.components[0].options) assert.ok(o.label.length <= 100);
});

if (Redis.isFake) {
  test("essais : 5 au plus, points à l'ouverture, essais comptés (faux Redis)", async () => {
    await resetCoffre({ clearManches: true });
    const code = ["etoile", "coeur", "triangle", "losange"];
    const opts = { code, essaisMax: 5, username: "Un", pnj: true };
    assert.equal((await jouerEssai(1, "u1", ["rond", "rond", "carre", "etoile"], opts)).statut, "invalide");
    const r1 = await jouerEssai(1, "u1", ["triangle", "carre", "etoile", "coeur"], opts);
    assert.equal(r1.statut, "ok");
    assert.deepEqual(r1.reponse, { bien: 0, mal: 3 });
    const r2 = await jouerEssai(1, "u1", code, opts);
    assert.ok(r2.partie.ouvert);
    assert.equal(r2.partie.points, 4);
    assert.equal((await jouerEssai(1, "u1", code, opts)).statut, "termine");
    assert.equal((await readPoints()).u1, 4);
    assert.equal((await readEssaisTotal()).u1, 2);

    // Cinq essais ratés : plus d'essai, 0 point mais classé
    for (let i = 0; i < 5; i++) await jouerEssai(1, "u2", ["rond", "carre", "etoile", "coeur"], opts);
    assert.equal((await jouerEssai(1, "u2", code, opts)).statut, "termine");
    assert.equal((await readPartie(1, "u2")).essais.length, 5);
    assert.equal((await readPoints()).u2, 0);
    await resetCoffre({ clearManches: true });
  });

  test("salon de test : jamais de ping, 5 PNJ jouent chaque coffre (faux Redis)", async () => {
    await resetCoffre({ clearManches: true });
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
      // Annonce, Jour 1, Jour 2
      for (let i = 0; i < 3; i++) await postCoffre("salon-test", { force: true, noPing: false, isPublic: false, pnj: true });
      const posts = appels.filter((a) => a.method === "POST");
      assert.equal(posts.length, 3);
      for (const p of posts) {
        assert.equal(p.body.content, undefined);
        assert.equal(p.body.allowed_mentions, undefined);
        assert.ok(!JSON.stringify(p.body).includes("<@"), "aucune mention");
        assert.equal(p.body.flags, 1 << 15, "Components V2");
      }
      assert.ok(appels.every((a) => !a.url.includes("/roles")), "aucune lecture des rôles");
      assert.equal(Object.keys(await listParties(1)).filter((id) => id.startsWith("pnj-")).length, 5);
      assert.equal(Object.keys(await listParties(2)).length, 5);
      // Le message du Jour 2 révèle le code du Jour 1
      const code1 = await readCode(1);
      assert.ok(JSON.stringify(posts[2].body).includes("Résultat du Jour 1"));
      assert.ok(code1 && (await readCode(2)));
      assert.equal((await readState()).jour, 2);

      // Salon public : jamais de PNJ, même demandés
      await resetCoffre({ clearManches: true });
      await postCoffre("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      await postCoffre("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      assert.equal(Object.keys(await listParties(1)).length, 0);
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetCoffre({ clearManches: true });
    }
  });
}
