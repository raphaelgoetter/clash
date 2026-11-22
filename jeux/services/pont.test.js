import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import {
  PIERRE,
  CORDES,
  REPU,
  FINALE,
  jourConfig,
  loadPontConfig,
  resoudreJour,
  texteIndice,
  buildRanking,
  formatPieces,
  jourOuvert,
  enregistrerChoix,
  lancerRumeur,
  listRumeurs,
  rumeursAnnoncees,
  menteurs,
  rumeursPrecedentes,
  VERITE,
  MENSONGE,
  RIEN,
  JOUR_DE_VERITE,
  consulterIndice,
  compterPassants,
  resetPont,
  addPoints,
  addPasse,
  listChoix,
  readUsernames,
  readAvatars,
  MATIN,
  APRES_MIDI,
  transitionPrete,
  loadVraiFaux,
  questionDuJour,
  repondreVraiFaux,
  porteursBonus,
  compterReponsesVraiFaux,
  readPoints,
  readState,
  horaires,
} from "./pont.js";
import { postPont, versV2, lignesClassement, maPosition } from "../discord/handlers/pont.js";
import { lignesMatin, lignesResultat, positionsPassants } from "./pontImage.js";

const choix = (pierre, cordes) => {
  const out = {};
  for (let i = 0; i < pierre; i++) out[`p${i}`] = { cote: PIERRE };
  for (let i = 0; i < cordes; i++) out[`c${i}`] = { cote: CORDES };
  return out;
};
const cfg = (pierre, cordes, evenement = null) => ({ jour: 1, pierre, cordes, evenement });

// Instants fixes (heure de Paris en hiver = UTC+1, en été = UTC+2)
const A = (heureParis) => Date.UTC(2026, 10, 20, heureParis - 1, 30);
const E = (heureParis) => Date.UTC(2026, 6, 20, heureParis - 2, 30);

test("calendrier : Troll repu au Jour 3, Fête du village au Jour 7, cordes ≥ pierre", async () => {
  const config = await loadPontConfig();
  assert.equal(jourConfig(config, 3).evenement, REPU);
  assert.equal(jourConfig(config, 7).evenement, FINALE);
  for (let j = 1; j <= config.duree_jours; j++) {
    const c = jourConfig(config, j);
    assert.ok(c.cordes >= c.pierre, `Jour ${j}`);
  }
});

test("le troll attrape le pont le plus chargé, butin partagé × multiplicateur", () => {
  const r = resoudreJour(choix(17, 11), cfg(1, 3));
  assert.equal(r.attrape, PIERRE);
  assert.equal(r.gagnant, CORDES);
  assert.equal(r.gainBase, 500); // 4,64 pièces, arrondi à l'entier supérieur
  const gagnants = r.resultats.filter((x) => x.passe);
  assert.equal(gagnants.length, 11);
  assert.ok(gagnants.every((x) => x.gain === r.gainBase));
  assert.ok(r.resultats.filter((x) => !x.passe).every((x) => x.gain === 0));
});

test("égalité : personne n'est attrapé, chacun gagne le multiplicateur de son pont", () => {
  const r = resoudreJour(choix(5, 5), cfg(1, 2));
  assert.equal(r.attrape, null);
  assert.equal(r.personneAttrape, true);
  assert.deepEqual(r.gainParCote, { [PIERRE]: 100, [CORDES]: 200 });
  assert.ok(r.resultats.every((x) => x.passe));
  assert.equal(r.resultats.find((x) => x.discordId === "p0").gain, 100);
  assert.equal(r.resultats.find((x) => x.discordId === "c1").gain, 200);
});

test("Troll repu sur un pont vide : personne d'attrapé, gains doublés à la Fête du village", () => {
  const r = resoudreJour(choix(4, 0), cfg(1, 3, REPU));
  assert.equal(r.attrape, CORDES);
  assert.equal(r.personneAttrape, true);
  assert.ok(r.resultats.every((x) => x.passe && x.gain === 100));
  const f = resoudreJour(choix(3, 3), cfg(1, 3, FINALE));
  assert.deepEqual(f.gainParCote, { [PIERRE]: 200, [CORDES]: 600 });
});

test("pont vide en face : aucun butin", () => {
  const r = resoudreJour(choix(6, 0), cfg(1, 3));
  assert.equal(r.attrape, PIERRE);
  assert.equal(r.gainBase, 0);
});

test("Troll repu : il attrape le pont le moins chargé", () => {
  const r = resoudreJour(choix(9, 4), cfg(1, 3, REPU));
  assert.equal(r.attrape, CORDES);
  assert.equal(r.gagnant, PIERRE);
  assert.equal(r.gainBase, 100); // 0,44 arrondi à 1
});

test("Fête du village : gains doublés", () => {
  const r = resoudreJour(choix(4, 2), cfg(1, 3, FINALE));
  assert.equal(r.gainBase, 1200);
  assert.ok(r.resultats.filter((x) => x.cote === CORDES).every((x) => x.gain === 1200));
});

test("pièce du matin : gardée (+1) si son porteur passe, versée au butin s'il est attrapé", () => {
  // 9 sur la pierre (attrapés, dont 2 porteurs), 4 sur les cordes (dont 1 porteur)
  const r = resoudreJour(choix(9, 4), cfg(1, 3), ["p0", "p1", "c0", "absent"]);
  assert.equal(r.attrape, PIERRE);
  assert.equal(r.bonusPerdus, 2);
  assert.equal(r.gainBase, 900); // 3 × (9 + 2) ÷ 4 = 8,25, arrondi à 9
  const gain = (id) => r.resultats.find((x) => x.discordId === id).gain;
  assert.equal(gain("c0"), 1000, "butin + sa pièce du matin");
  assert.equal(gain("c1"), 900);
  assert.equal(gain("p0"), 0, "attrapé : pièce perdue");
  assert.ok(!r.resultats.some((x) => x.discordId === "absent"), "sans traversée, pas de pièce");
  // Égalité : tout le monde passe, les porteurs gardent leur pièce
  const e = resoudreJour(choix(3, 3), cfg(1, 2), ["p0"]);
  assert.equal(e.bonusPerdus, 0);
  assert.equal(e.resultats.find((x) => x.discordId === "p0").gain, 200);
  // Sans porteur : règle inchangée
  assert.equal(resoudreJour(choix(17, 11), cfg(1, 3)).gainBase, 500);
});

test("questions Vrai/Faux : parties de 7, réponses équilibrées", async () => {
  const config = await loadPontConfig();
  const vf = await loadVraiFaux();
  assert.ok(vf.parties.length >= 1);
  for (const partie of vf.parties) {
    assert.equal(partie.length, config.duree_jours);
    assert.ok(partie.every((q) => q.affirmation && typeof q.reponse === "boolean"));
    const vrais = partie.filter((q) => q.reponse).length;
    assert.ok(vrais >= 3 && vrais <= 4, "3 ou 4 VRAI par partie");
  }
  assert.equal(questionDuJour(vf, 1, 1), vf.parties[1][0]);
});

test("transitions : annonce 8 h au moins, ponts à 14h, résolution au jour de jeu suivant", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const lendemain = (hParis) => A(hParis) + 24 * 3_600_000;
  const annonce = { phase: "annonce", publishedAt: iso(A(10)) };
  assert.equal(transitionPrete(annonce, A(14)), false);
  assert.equal(transitionPrete(annonce, lendemain(8)), true);
  const matin = { phase: MATIN, publishedAt: iso(A(8)) };
  assert.equal(transitionPrete(matin, A(13)), false);
  assert.equal(transitionPrete(matin, A(14)), true); // 14h30
  assert.equal(transitionPrete(matin, lendemain(8)), true, "passage de 14h manqué : rattrapé");
  const apresMidi = { phase: APRES_MIDI, publishedAt: iso(A(14)) };
  assert.equal(transitionPrete(apresMidi, A(23)), false);
  assert.equal(transitionPrete(apresMidi, lendemain(7)), false); // 7h30
  assert.equal(transitionPrete(apresMidi, lendemain(8)), true); // 8h30
  assert.equal(transitionPrete(null, A(10)), true);
});

test("horaires : matin et ponts suivent les crons UTC (8h/14h en hiver, 9h/15h en été)", () => {
  assert.deepEqual(horaires(A(10)), { matin: 8, ponts: 14, indiceExact: 17, indiceFourchette: 20 });
  assert.deepEqual(horaires(E(10)), { matin: 9, ponts: 15, indiceExact: 18, indiceFourchette: 21 });
  const matinEte = { phase: MATIN, publishedAt: new Date(E(9)).toISOString() };
  assert.equal(transitionPrete(matinEte, E(14)), false, "14h30 en été : pas encore");
  assert.equal(transitionPrete(matinEte, E(15)), true);
  assert.equal(texteIndice({ pierre: 12, cordes: 5 }, E(17)), "Pierre 12, Cordes 5.");
  assert.match(texteIndice({ pierre: 12, cordes: 5 }, E(20)), /mène de/);
  assert.equal(texteIndice({ pierre: 12, cordes: 5 }, E(21)), "La pierre semble plus chargée.");
});

test("rumeurs : pont annoncé d'après le pont choisi, menteurs, sans pont = absent", () => {
  const choixDuJour = { a: { cote: PIERRE }, b: { cote: CORDES }, c: { cote: PIERRE }, d: { cote: CORDES } };
  const rumeurs = { a: { mode: VERITE }, b: { mode: MENSONGE }, c: { mode: RIEN }, d: { mode: VERITE }, e: { mode: VERITE } };
  assert.deepEqual(rumeursAnnoncees(choixDuJour, rumeurs), { [PIERRE]: ["a", "b"], [CORDES]: ["d"] });
  assert.deepEqual(menteurs(choixDuJour, rumeurs), ["b"]);
  assert.deepEqual(menteurs(choixDuJour, { e: { mode: MENSONGE } }), [], "pas de pont, pas de mensonge");
});

test("Jour de vérité (J5) : tout mensonge annonce le vrai pont, aucun menteur", async () => {
  const config = await loadPontConfig();
  assert.equal(jourConfig(config, 5).evenement, JOUR_DE_VERITE);
  const choixDuJour = { a: { cote: PIERRE }, b: { cote: CORDES } };
  const rumeurs = { a: { mode: MENSONGE }, b: { mode: VERITE } };
  assert.deepEqual(rumeursAnnoncees(choixDuJour, rumeurs, { verite: true }), { [PIERRE]: ["a"], [CORDES]: ["b"] });
  assert.deepEqual(menteurs(choixDuJour, rumeurs, { verite: true }), []);
  assert.deepEqual(menteurs(choixDuJour, rumeurs), ["a"]);
  assert.equal(lignesMatin(JOUR_DE_VERITE)[1], "Toutes les rumeurs sont vraies");
});

test("rumeurs les jours impairs, détecteur sur le jour de rumeurs précédent", async () => {
  const config = await loadPontConfig();
  assert.deepEqual(config.jours_rumeurs, [1, 3, 5, 7]);
  assert.ok(config.jours_indice.every((j) => !config.jours_rumeurs.includes(j)), "Indice et Rumeurs en alternance");
  assert.equal(rumeursPrecedentes(config, 1), null);
  assert.equal(rumeursPrecedentes(config, 3), 1);
  assert.equal(rumeursPrecedentes(config, 7), 5);
});

test("indice : exact jusqu'à 17h, fourchette jusqu'à 20h, tendance ensuite", () => {
  const rep = { pierre: 12, cordes: 5 };
  assert.equal(texteIndice(rep, A(15)), "Pierre 12, Cordes 5.");
  for (const u of [0, 0.3, 0.6, 0.99]) {
    const m = /La pierre mène de (\d+) à (\d+) joueurs\./.exec(texteIndice(rep, A(18), () => u));
    assert.ok(m);
    const [bas, haut] = [Number(m[1]), Number(m[2])];
    assert.equal(haut - bas, 4);
    assert.ok(bas >= 1 && bas <= 7 && haut >= 7, "l'écart réel (7) est dans la fourchette");
  }
  assert.equal(texteIndice(rep, A(21)), "La pierre semble plus chargée.");
  assert.equal(texteIndice({ pierre: 3, cordes: 9 }, A(23)), "Les cordes semblent plus chargées.");
  assert.equal(texteIndice({ pierre: 3, cordes: 9 }, A(7)), "Les cordes semblent plus chargées.");
});

test("indice : coude à coude (hors chiffres exacts) et personne", () => {
  assert.equal(texteIndice({ pierre: 6, cordes: 4 }, A(18)), "Coude à coude entre les deux ponts.");
  assert.equal(texteIndice({ pierre: 6, cordes: 4 }, A(15)), "Pierre 6, Cordes 4.");
  assert.equal(texteIndice({ pierre: 0, cordes: 0 }, A(15)), "Personne n'a encore traversé.");
});

test("classement : pièces puis jours passés", () => {
  const r = buildRanking({ a: 300, b: 300, c: 500 }, { a: 1, b: 2, c: 0 });
  assert.deepEqual(r.map((x) => x.discordId), ["c", "b", "a"]);
});

test("formatPieces : une décimale, virgule", () => {
  assert.equal(formatPieces(460), "4,6");
  assert.equal(formatPieces(300), "3");
  assert.equal(formatPieces(0), "0");
});

test("ponts ouverts jusqu'à minuit (heure de Paris)", () => {
  const publie = A(14);
  assert.equal(jourOuvert(new Date(publie).toISOString(), A(23)), true);
  assert.equal(jourOuvert(new Date(publie).toISOString(), Date.UTC(2026, 10, 20, 23, 30)), false); // 0h30
  assert.equal(jourOuvert(new Date(publie).toISOString(), Date.UTC(2026, 10, 21, 6, 30)), false); // 7h30 le lendemain
  assert.equal(jourOuvert(new Date(publie).toISOString(), Date.UTC(2026, 10, 21, 7, 30)), false); // 8h30
});

test("textes de l'image", () => {
  assert.equal(lignesMatin(null).length, 1);
  assert.equal(lignesMatin(REPU)[1], "Il attrape le pont le moins chargé");
  const l = lignesResultat({ attrape: PIERRE, gagnant: CORDES, gainBase: 500, pierre: 17, cordes: 11 });
  assert.deepEqual(l, ["17 joueurs attrapés sur la pierre", "Cordes : +5 pièces chacun"]);
  assert.deepEqual(lignesResultat({ attrape: null, pierre: 3, cordes: 3, gainParCote: { pierre: 100, cordes: 200 } }), [
    "Égalité : le troll se rendort",
    "Pierre +1 · Cordes +2 pièces chacun",
  ]);
});

test("positions des avatars : tous affichés, dans l'image", () => {
  for (const n of [1, 6, 25, 40]) {
    const pos = positionsPassants("droite", n);
    assert.equal(pos.length, n);
    assert.ok(pos.every((p) => p.x > 0 && p.x < 900 && p.y > 100 && p.y <= 385 && p.r >= 8));
  }
});

test("Components V2 : un conteneur par embed, image en galerie, ping en bloc texte", () => {
  const embeds = [
    { title: "A", description: "a", image: { url: "https://x/1" } },
    { title: "B", description: "b", image: { url: "https://x/2" }, footer: { text: "pied" } },
  ];
  const boutons = [{ type: 1, components: [{ type: 2, style: 2, label: "Règles", custom_id: "pont_regles" }] }];
  const sansPing = versV2(embeds, boutons);
  assert.equal(sansPing.flags, 1 << 15);
  assert.equal(sansPing.content, undefined);
  assert.equal(sansPing.embeds, undefined);
  assert.equal(sansPing.allowed_mentions, undefined);
  assert.equal(sansPing.components.length, 2);
  assert.deepEqual(sansPing.components[1].components.map((c) => c.type), [10, 12, 10, 1]);
  assert.equal(sansPing.components[1].components[2].content, "-# pied");
  const avecPing = versV2(embeds, boutons, "42");
  assert.deepEqual(avecPing.components[0], { type: 10, content: "<@&42>" });
  assert.deepEqual(avecPing.allowed_mentions, { parse: [], roles: ["42"] });
});

if (Redis.isFake) {
  test("choix définitif, rumeur définitive, Indice mémorisé (faux Redis)", async () => {
    await resetPont({ clearManches: true });
    assert.deepEqual(await enregistrerChoix(2, "u1", PIERRE, { username: "Un" }), { ok: true, cote: PIERRE });
    assert.deepEqual(await enregistrerChoix(2, "u1", CORDES, {}), { ok: false, cote: PIERRE });
    await enregistrerChoix(2, "u2", CORDES, {});
    assert.equal(await compterPassants(2), 2);

    assert.deepEqual(await lancerRumeur(3, "u1", MENSONGE), { ok: true, mode: MENSONGE });
    assert.deepEqual(await lancerRumeur(3, "u1", VERITE), { ok: false, mode: MENSONGE });
    assert.deepEqual(await lancerRumeur(3, "u2", "n'importe quoi"), { ok: false, mode: null });
    assert.deepEqual(Object.keys(await listRumeurs(3)), ["u1"]);

    const premier = await consulterIndice(2, "u3", A(9));
    assert.deepEqual(premier, { nouveau: true, texte: "Pierre 1, Cordes 1." });
    await enregistrerChoix(2, "u4", PIERRE, {});
    assert.deepEqual(await consulterIndice(2, "u3", A(9)), { nouveau: false, texte: "Pierre 1, Cordes 1." });
    await resetPont({ clearManches: true });
  });
}

if (Redis.isFake) {
  test("salon de test : jamais de ping, 5 PNJ traversent chaque jour (faux Redis)", async () => {
    await resetPont({ clearManches: true });
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
      // Annonce, matin J1, après-midi J1, matin J2
      for (let i = 0; i < 4; i++) await postPont("salon-test", { force: true, noPing: false, isPublic: false, pnj: true });
      const posts = appels.filter((a) => a.method === "POST");
      assert.equal(posts.length, 4);
      for (const p of posts) {
        assert.equal(p.body.content, undefined);
        assert.equal(p.body.allowed_mentions, undefined);
        assert.ok(!JSON.stringify(p.body).includes("<@"), "aucune mention");
        assert.equal(p.body.flags, 1 << 15, "Components V2");
      }
      // Compteur de passants : PATCH du message en V2, galerie conservée
      const patch = appels.find((a) => a.method === "PATCH");
      assert.equal(patch.body.flags, 1 << 15);
      assert.ok(JSON.stringify(patch.body).includes("5 joueurs"));
      assert.ok(JSON.stringify(patch.body).includes('"type":12'));
      assert.ok(appels.every((a) => !a.url.includes("/roles")), "aucune lecture des rôles");
      const j1 = await listChoix(1);
      assert.equal(Object.keys(j1).filter((id) => id.startsWith("pnj-")).length, 5);
      assert.equal(await compterReponsesVraiFaux(1), 5, "les PNJ répondent au Vrai/Faux");
      assert.equal(await compterReponsesVraiFaux(2), 5);
      assert.equal((await readUsernames())["pnj-1"], "Josette");
      assert.equal((await readAvatars())["pnj-3"], "clay-03");

      // Salon public : jamais de PNJ, même demandés
      await resetPont({ clearManches: true });
      await postPont("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      await postPont("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      assert.equal(Object.keys(await listChoix(1)).length, 0);
      assert.equal(await compterReponsesVraiFaux(1), 0);
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetPont({ clearManches: true });
    }
  });
}

if (Redis.isFake) {
  test("classement : passages affichés pour tous, rang partagé si pièces et passages égaux", async () => {
    await resetPont({ clearManches: true });
    const ranking = buildRanking(
      { pnj1: 2200, pnj2: 900, pnj3: 900, pnj4: 700, pnj5: 700 },
      { pnj1: 7, pnj2: 3, pnj3: 2, pnj4: 2, pnj5: 2 },
      { pnj1: "A", pnj2: "Gérard", pnj3: "Ginette", pnj4: "Bernadette", pnj5: "Jean-Mi" },
    );
    assert.deepEqual(await lignesClassement(ranking, 10), [
      "1\\. A (22 pièces, 7 passages)",
      "2\\. Gérard (9 pièces, 3 passages)",
      "3\\. Ginette (9 pièces, 2 passages)",
      "4\\. Bernadette (7 pièces, 2 passages)",
      "4\\. Jean-Mi (7 pièces, 2 passages)",
    ]);
  });
}

if (Redis.isFake) {
  test("position du joueur dans la confirmation : rang partagé, rien sans classement", async () => {
    await resetPont({ clearManches: true });
    assert.equal(await maPosition("u9"), null);
    await addPoints("u1", 640);
    await addPoints("u2", 900);
    await addPoints("u3", 640);
    for (let i = 0; i < 3; i++) await addPasse("u1");
    for (let i = 0; i < 3; i++) await addPasse("u3");
    await addPasse("u2");
    assert.equal(await maPosition("u2"), "📊 Tu es 1er : 9 pièces, 1 passage.");
    assert.equal(await maPosition("u1"), "📊 Tu es 2e : 6,4 pièces, 3 passages.");
    assert.equal(await maPosition("u3"), "📊 Tu es 2e : 6,4 pièces, 3 passages.");
    await resetPont({ clearManches: true });
  });
}

if (Redis.isFake) {
  test("journée en deux phases : Vrai/Faux le matin, ponts l'après-midi, pièce bonus au résultat (faux Redis)", async () => {
    await resetPont({ clearManches: true });
    const vraiFetch = globalThis.fetch;
    const tokenAvant = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test";
    const posts = [];
    globalThis.fetch = async (url, opts = {}) => {
      if (opts.method === "POST") posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    };
    const ids = (body) => JSON.stringify(body).match(/pont_[a-z]+:[^"]*/g) ?? [];
    const opts = { force: true, noPing: true, isPublic: false, pnj: false };
    try {
      await postPont("salon-test", opts); // annonce
      await postPont("salon-test", opts); // matin J1
      assert.deepEqual(ids(posts[1]), ["pont_vf:1:vrai", "pont_vf:1:faux"]);
      const question = questionDuJour(await loadVraiFaux(), (await readState()).vfPartie, 1);
      assert.ok(JSON.stringify(posts[1]).includes(question.affirmation.slice(0, 30)));
      // u1 et u2 répondent juste, u3 se trompe ; réponse définitive
      assert.equal((await repondreVraiFaux(1, "u1", question.reponse, question)).correct, true);
      await repondreVraiFaux(1, "u2", question.reponse, question);
      assert.equal((await repondreVraiFaux(1, "u3", !question.reponse, question)).correct, false);
      assert.deepEqual(await repondreVraiFaux(1, "u3", question.reponse, question), { ok: false, reponse: !question.reponse, correct: false });
      assert.deepEqual((await porteursBonus(1)).sort(), ["u1", "u2"]);

      await postPont("salon-test", opts); // après-midi J1
      assert.ok(ids(posts[2]).includes("pont_pierre:1"));
      // u1 (porteur) passe seul sur les cordes ; u2 (porteur) et u3 attrapés
      await enregistrerChoix(1, "u1", CORDES, {});
      await enregistrerChoix(1, "u2", PIERRE, {});
      await enregistrerChoix(1, "u3", PIERRE, {});
      await postPont("salon-test", opts); // résolution, matin J2
      // ×1 × (2 attrapés + 1 pièce bonus) ÷ 1 = 3, + sa pièce du matin
      const points = await readPoints();
      assert.equal(points.u1, 400);
      assert.equal(points.u2, 0);
      assert.ok(JSON.stringify(posts[3]).includes("(et 1 pièce bonus)"));
      assert.deepEqual(ids(posts[3]), ["pont_vf:2:vrai", "pont_vf:2:faux"]);
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetPont({ clearManches: true });
    }
  });
}
