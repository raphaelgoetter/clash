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
  jouerJoker,
  jokersDuJour,
  consulterIndice,
  compterPassants,
  resetPont,
  listChoix,
  readUsernames,
  readAvatars,
} from "./pont.js";
import { postPont, versV2 } from "../discord/handlers/pont.js";
import { lignesMatin, lignesResultat, positionsPassants } from "./pontImage.js";

const choix = (pierre, cordes) => {
  const out = {};
  for (let i = 0; i < pierre; i++) out[`p${i}`] = { cote: PIERRE };
  for (let i = 0; i < cordes; i++) out[`c${i}`] = { cote: CORDES };
  return out;
};
const cfg = (pierre, cordes, evenement = null) => ({ jour: 1, pierre, cordes, evenement });

// Instants fixes (heure de Paris en hiver = UTC+1)
const A = (heureParis) => Date.UTC(2026, 10, 20, heureParis - 1, 30);

test("calendrier : Troll repu au Jour 3, Grande finale au Jour 7, cordes ≥ pierre", async () => {
  const config = await loadPontConfig();
  assert.equal(jourConfig(config, 3).evenement, REPU);
  assert.equal(jourConfig(config, 7).evenement, FINALE);
  for (let j = 1; j <= config.duree_jours; j++) {
    const c = jourConfig(config, j);
    assert.ok(c.cordes >= c.pierre, `Jour ${j}`);
  }
});

test("le troll attrape le pont le plus chargé, butin partagé × multiplicateur", () => {
  const r = resoudreJour(choix(17, 11), new Set(), cfg(1, 3));
  assert.equal(r.attrape, PIERRE);
  assert.equal(r.gagnant, CORDES);
  assert.equal(r.gainBase, 460); // 4,64 pièces arrondies au dixième
  const gagnants = r.resultats.filter((x) => x.passe);
  assert.equal(gagnants.length, 11);
  assert.ok(gagnants.every((x) => x.gain === r.gainBase));
  assert.ok(r.resultats.filter((x) => !x.passe).every((x) => x.gain === 0));
});

test("égalité : personne n'est attrapé, chacun gagne le multiplicateur de son pont", () => {
  const r = resoudreJour(choix(5, 5), new Set(["c0"]), cfg(1, 2));
  assert.equal(r.attrape, null);
  assert.equal(r.personneAttrape, true);
  assert.deepEqual(r.gainParCote, { [PIERRE]: 100, [CORDES]: 200 });
  assert.ok(r.resultats.every((x) => x.passe));
  assert.equal(r.resultats.find((x) => x.discordId === "p0").gain, 100);
  assert.equal(r.resultats.find((x) => x.discordId === "c1").gain, 200);
  assert.equal(r.resultats.find((x) => x.discordId === "c0").gain, 400); // Joker
});

test("Troll repu sur un pont vide : personne d'attrapé, gains en Grande finale doublés", () => {
  const r = resoudreJour(choix(4, 0), new Set(), cfg(1, 3, REPU));
  assert.equal(r.attrape, CORDES);
  assert.equal(r.personneAttrape, true);
  assert.ok(r.resultats.every((x) => x.passe && x.gain === 100));
  const f = resoudreJour(choix(3, 3), new Set(), cfg(1, 3, FINALE));
  assert.deepEqual(f.gainParCote, { [PIERRE]: 200, [CORDES]: 600 });
});

test("pont vide en face : aucun butin", () => {
  const r = resoudreJour(choix(6, 0), new Set(), cfg(1, 3));
  assert.equal(r.attrape, PIERRE);
  assert.equal(r.gainBase, 0);
});

test("Troll repu : il attrape le pont le moins chargé", () => {
  const r = resoudreJour(choix(9, 4), new Set(), cfg(1, 3, REPU));
  assert.equal(r.attrape, CORDES);
  assert.equal(r.gagnant, PIERRE);
  assert.equal(r.gainBase, 40); // 0,44
});

test("Grande finale ×2 et Joker ×2 se cumulent", () => {
  const r = resoudreJour(choix(4, 2), new Set(["c0"]), cfg(1, 3, FINALE));
  assert.equal(r.gainBase, 1200);
  assert.equal(r.resultats.find((x) => x.discordId === "c0").gain, r.gainBase * 2);
  assert.equal(r.resultats.find((x) => x.discordId === "c1").gain, r.gainBase);
});

test("Joker d'un attrapé : aucun gain", () => {
  const r = resoudreJour(choix(4, 2), new Set(["p0"]), cfg(1, 1));
  assert.equal(r.resultats.find((x) => x.discordId === "p0").gain, 0);
});

test("indice : exact le matin, fourchette l'après-midi, tendance le soir", () => {
  const rep = { pierre: 12, cordes: 5 };
  assert.equal(texteIndice(rep, A(9)), "Pierre 12, Cordes 5.");
  for (const u of [0, 0.3, 0.6, 0.99]) {
    const m = /La pierre mène de (\d+) à (\d+) passants\./.exec(texteIndice(rep, A(14), () => u));
    assert.ok(m);
    const [bas, haut] = [Number(m[1]), Number(m[2])];
    assert.equal(haut - bas, 4);
    assert.ok(bas >= 1 && bas <= 7 && haut >= 7, "l'écart réel (7) est dans la fourchette");
  }
  assert.equal(texteIndice(rep, A(20)), "La pierre semble plus chargée.");
  assert.equal(texteIndice({ pierre: 3, cordes: 9 }, A(23)), "Les cordes semblent plus chargées.");
  assert.equal(texteIndice({ pierre: 3, cordes: 9 }, A(7)), "Les cordes semblent plus chargées.");
});

test("indice : coude à coude (hors matin) et personne", () => {
  assert.equal(texteIndice({ pierre: 6, cordes: 4 }, A(14)), "Coude à coude entre les deux ponts.");
  assert.equal(texteIndice({ pierre: 6, cordes: 4 }, A(10)), "Pierre 6, Cordes 4.");
  assert.equal(texteIndice({ pierre: 0, cordes: 0 }, A(10)), "Personne n'a encore traversé.");
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

test("jour ouvert de 8h à 8h (heure de Paris)", () => {
  const publie = A(9);
  assert.equal(jourOuvert(new Date(publie).toISOString(), A(23)), true);
  assert.equal(jourOuvert(new Date(publie).toISOString(), Date.UTC(2026, 10, 21, 6, 30)), true); // 7h30 le lendemain
  assert.equal(jourOuvert(new Date(publie).toISOString(), Date.UTC(2026, 10, 21, 7, 30)), false); // 8h30
});

test("textes de l'image", () => {
  assert.equal(lignesMatin(null).length, 1);
  assert.equal(lignesMatin(REPU)[1], "Il attrape le pont le moins chargé");
  const l = lignesResultat({ attrape: PIERRE, gagnant: CORDES, gainBase: 460, pierre: 17, cordes: 11 });
  assert.deepEqual(l, ["17 passants attrapés sur la pierre", "Cordes : +4,6 pièces chacun"]);
  assert.deepEqual(lignesResultat({ attrape: null, pierre: 3, cordes: 3, gainParCote: { pierre: 100, cordes: 200 } }), [
    "Égalité : le troll hésite",
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
  test("choix définitif, Joker unique, Indice mémorisé (faux Redis)", async () => {
    await resetPont({ clearManches: true });
    assert.deepEqual(await enregistrerChoix(2, "u1", PIERRE, { username: "Un" }), { ok: true, cote: PIERRE });
    assert.deepEqual(await enregistrerChoix(2, "u1", CORDES, {}), { ok: false, cote: PIERRE });
    await enregistrerChoix(2, "u2", CORDES, {});
    assert.equal(await compterPassants(2), 2);

    assert.deepEqual(await jouerJoker(2, "u1"), { ok: true, jour: 2 });
    assert.deepEqual(await jouerJoker(4, "u1"), { ok: false, jour: 2 });
    assert.deepEqual([...(await jokersDuJour(2))], ["u1"]);
    assert.equal((await jokersDuJour(4)).size, 0);

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
      for (let i = 0; i < 3; i++) await postPont("salon-test", { force: true, noPing: false, isPublic: false, pnj: true });
      const posts = appels.filter((a) => a.method === "POST");
      assert.equal(posts.length, 3);
      for (const p of posts) {
        assert.equal(p.body.content, undefined);
        assert.equal(p.body.allowed_mentions, undefined);
        assert.ok(!JSON.stringify(p.body).includes("<@"), "aucune mention");
        assert.equal(p.body.flags, 1 << 15, "Components V2");
      }
      // Compteur de passants : PATCH du message en V2, galerie conservée
      const patch = appels.find((a) => a.method === "PATCH");
      assert.equal(patch.body.flags, 1 << 15);
      assert.ok(JSON.stringify(patch.body).includes("5 passants"));
      assert.ok(JSON.stringify(patch.body).includes('"type":12'));
      assert.ok(appels.every((a) => !a.url.includes("/roles")), "aucune lecture des rôles");
      const j2 = await listChoix(2);
      assert.equal(Object.keys(j2).filter((id) => id.startsWith("pnj-")).length, 5);
      assert.equal((await readUsernames())["pnj-1"], "Josette");
      assert.equal((await readAvatars())["pnj-3"], "clay-03");

      // Salon public : jamais de PNJ, même demandés
      await resetPont({ clearManches: true });
      await postPont("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      await postPont("salon-public", { force: true, noPing: true, isPublic: true, pnj: true });
      assert.equal(Object.keys(await listChoix(1)).length, 0);
    } finally {
      globalThis.fetch = vraiFetch;
      if (tokenAvant === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = tokenAvant;
      await resetPont({ clearManches: true });
    }
  });
}
