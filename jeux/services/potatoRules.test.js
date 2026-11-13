import assert from "assert";
import {
  CHAUFFES,
  MANCHES_GAGNANTES,
  SEUIL_MAX,
  SEUIL_MIN,
  TEMP_DEPART,
  chauffer,
  chauffesDe,
  choixKevina,
  chauffePermise,
  creerDuel,
  etatPatate,
  etatVisible,
  indice,
  reperes,
  seuilsPossibles,
} from "./potatoRules.js";

// Tirage sans événement, seuil au maximum
const calme = () => 0.99;
// Suite de tirages imposée, puis calme
const suite = (valeurs) => {
  const v = [...valeurs];
  return () => (v.length ? v.shift() : 0.99);
};

// ── Départ ──
{
  const d = creerDuel({ commence: "bot", rng: calme });
  assert.deepStrictEqual([d.temp, d.seuil, d.actif, d.numero, d.evenement], [TEMP_DEPART, SEUIL_MAX, "bot", 1, null]);
  assert.deepStrictEqual(d.obs, [{ t: TEMP_DEPART, i: "froide" }]);
  for (let i = 0; i < 200; i++) {
    const s = creerDuel().seuil;
    assert.ok(s >= SEUIL_MIN && s <= SEUIL_MAX && s % 5 === 0, `seuil ${s}`);
  }
}

// ── Indices ──
assert.deepStrictEqual([indice(30), indice(25), indice(15), indice(10), indice(5)], ["froide", "fume", "fume", "siffle", "siffle"]);

// ── Chauffe simple, erreurs ──
{
  const d = creerDuel({ rng: calme });
  assert.deepStrictEqual(chauffer(d, "bot", 0, { rng: calme }), { erreur: "pasTonTour" });
  assert.deepStrictEqual(chauffer(d, "joueur", 3, { rng: calme }), { erreur: "choix" });
  assert.deepStrictEqual(chauffer(d, "joueur", 1, { rng: calme }), {});
  assert.deepStrictEqual([d.temp, d.actif, d.vue, d.chauffes], [TEMP_DEPART + 10, "bot", 1, [{ id: "joueur", v: 10 }]]);
  assert.strictEqual(d.dernier.chauffe, 10);
}

// ── Explosion : manche au joueur qui n'a pas chauffé, le perdant commence la suivante ──
{
  const d = creerDuel({ rng: calme });
  d.seuil = TEMP_DEPART + 10;
  assert.deepStrictEqual(chauffer(d, "joueur", 1, { rng: calme }), { explose: true });
  assert.deepStrictEqual(d.manches, { joueur: 0, bot: 1 });
  assert.deepStrictEqual(d.historique[0], { gagnant: "bot", perdant: "joueur", seuil: TEMP_DEPART + 10, temp: TEMP_DEPART + 10, chauffes: [{ id: "joueur", v: 10 }] });
  assert.deepStrictEqual([d.numero, d.temp, d.actif, d.chauffes, d.termine], [2, TEMP_DEPART, "joueur", [], false]);
  assert.strictEqual(d.dernier.explose, true);
  // Deuxième manche perdue par le joueur : partie finie
  d.seuil = TEMP_DEPART + 5;
  chauffer(d, "joueur", 0, { rng: calme });
  assert.strictEqual(d.manches.bot, MANCHES_GAGNANTES);
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "bot"]);
  assert.deepStrictEqual(chauffer(d, "joueur", 0), { erreur: "termine" });
}

// ── Événements ──
{
  // Glaçon tiré au 2e tour (température > départ) : −15 °C aussitôt
  const d = creerDuel({ rng: calme });
  chauffer(d, "joueur", 2, { rng: suite([0.1, 0]) });
  assert.deepStrictEqual(d.evenement, { type: "glacon", id: "bot", avant: TEMP_DEPART + 15 });
  assert.strictEqual(d.temp, TEMP_DEPART);
  // Pas de Glaçon à température de départ
  const e = creerDuel({ rng: suite([0.99, 0.1, 0]) });
  assert.strictEqual(e.evenement.type, "piment");
  assert.deepStrictEqual(chauffesDe(e, "joueur"), CHAUFFES);
  // Piment : +15 maintenant, encore +15 au début du tour adverse
  chauffer(e, "joueur", 2, { rng: calme });
  assert.deepStrictEqual([e.temp, e.actif, e.piment], [TEMP_DEPART + 30, "bot", null]);
  assert.deepStrictEqual(e.chauffes, [{ id: "joueur", v: 15 }, { id: "joueur", v: 15 }]);
}
{
  // Piment qui fait exploser la patate chez l'adversaire au début de son tour
  const d = creerDuel({ rng: calme });
  d.seuil = TEMP_DEPART + 20;
  d.evenement = { type: "piment", id: "joueur" };
  assert.deepStrictEqual(chauffer(d, "joueur", 1, { rng: calme }), {});
  assert.deepStrictEqual(d.manches, { joueur: 1, bot: 0 });
  assert.strictEqual(d.historique[0].piment, true);
  assert.deepStrictEqual([d.numero, d.actif, d.piment], [2, "bot", null]);
  // Kévina avec le Piment, à 10 °C de l'explosion connue : seul +5 piège
  // l'adversaire sans la faire exploser elle-même
  const k = creerDuel({ rng: calme });
  Object.assign(k, { actif: "bot", temp: 60, seuil: 70, evenement: { type: "piment", id: "bot" } });
  k.fourchettes.bot = { lo: 70, hi: 70 };
  assert.strictEqual(choixKevina(k, "bot", { rng: calme }), 0);
}
{
  // Gants : la patate passe brûlante et explose aussitôt chez l'adversaire
  const d = creerDuel({ rng: calme });
  d.seuil = TEMP_DEPART + 10;
  d.evenement = { type: "gants", id: "joueur" };
  assert.deepStrictEqual(chauffer(d, "joueur", 2, { rng: calme }), { explose: true });
  assert.deepStrictEqual(d.manches, { joueur: 1, bot: 0 });
  assert.deepStrictEqual(d.historique[0], { gagnant: "joueur", perdant: "bot", seuil: TEMP_DEPART + 10, temp: TEMP_DEPART + 15, chauffes: [{ id: "joueur", v: 15 }], renvoi: true });
  assert.strictEqual(d.dernier.gants, true);
  // Le perdant (Kévina) commence la manche suivante
  assert.deepStrictEqual([d.numero, d.actif, d.temp], [2, "bot", TEMP_DEPART]);
}
{
  // Sauvé par un Glaçon : la patate refroidit sous le seuil, la manche continue
  const d = creerDuel({ rng: calme });
  d.seuil = TEMP_DEPART + 20;
  chauffer(d, "joueur", 0, { rng: calme });
  d.evenement = { type: "gants", id: "bot" };
  chauffer(d, "bot", 2, { rng: suite([0.1, 0]) });
  assert.deepStrictEqual([d.manches, d.actif, d.temp], [{ joueur: 0, bot: 0 }, "joueur", TEMP_DEPART + 5]);
  assert.strictEqual(d.evenement.type, "glacon");
  // Sauvé par ses propres Gants : il la renvoie, elle explose chez l'autre
  const e = creerDuel({ rng: calme });
  e.seuil = TEMP_DEPART + 5;
  e.evenement = { type: "gants", id: "joueur" };
  chauffer(e, "joueur", 0, { rng: suite([0.1, 3 / 6]) });
  assert.deepStrictEqual([e.actif, e.evenement.type, e.manches.joueur], ["bot", "gants", 0]);
  chauffer(e, "bot", 0, { rng: calme });
  assert.deepStrictEqual(e.manches, { joueur: 0, bot: 1 });
}

{
  // Retour à l'envoyeur : la patate revient, le même joueur rejoue (pas de second Retour)
  const d = creerDuel({ rng: calme });
  d.evenement = { type: "retour", id: "joueur" };
  chauffer(d, "joueur", 0, { rng: suite([0.1, 0.99]) });
  assert.deepStrictEqual([d.actif, d.temp, d.dernier.retour], ["joueur", TEMP_DEPART + 5, true]);
  assert.notStrictEqual(d.evenement?.type, "retour");
  // Courant d'air : état caché à tous, aucun indice noté
  const e = creerDuel({ rng: calme });
  const avant = e.obs.length;
  e.evenement = null;
  chauffer(e, "joueur", 0, { rng: suite([0.1, 5.5 / 7]) });
  assert.strictEqual(e.evenement.type, "courant");
  assert.strictEqual(etatVisible(e), "cache");
  assert.strictEqual(e.obs.length, avant);
  // Chauffe imposée : +10 °C seulement, Kévina s'y plie même en erreur
  const f = creerDuel({ rng: calme });
  f.evenement = { type: "impose", id: "joueur" };
  assert.deepStrictEqual([0, 1, 2].map((k) => chauffePermise(f, "joueur", k)), [false, true, false]);
  assert.deepStrictEqual(chauffer(f, "joueur", 2, { rng: calme }), { erreur: "impose" });
  assert.strictEqual(choixKevina({ ...f, evenement: { type: "impose", id: "bot" } }, "bot", { erreur: 1 }), 1);
  assert.deepStrictEqual(chauffer(f, "joueur", 1, { rng: calme }), {});
  assert.strictEqual(f.temp, TEMP_DEPART + 10);
}

{
  // Thermomètre : fourchette de 10 °C qui contient la température d'explosion,
  // toujours entre 70 et 130 °C, retenue jusqu'à la fin de la manche
  for (let i = 0; i < 300; i++) {
    const d = creerDuel({ rng: calme });
    d.seuil = 70 + 5 * (i % 13);
    chauffer(d, "joueur", 0, { rng: suite([0.1, 2 / 7, Math.random()]) });
    const { lo, hi, type } = d.evenement;
    assert.strictEqual(type, "thermo");
    assert.ok(hi - lo === 10 && lo <= d.seuil && d.seuil <= hi && lo >= 70 && hi <= 130, `${lo}-${hi} pour ${d.seuil}`);
    assert.deepStrictEqual(d.fourchettes.bot, { lo, hi });
  }
}

// ── Seuils possibles et Kévina ──
{
  const d = creerDuel({ rng: calme });
  // Patate à 90 °C qui fume : seuil entre 95 et 115
  Object.assign(d, { temp: 90, obs: [{ t: 90, i: "fume" }], bornes: [] });
  assert.deepStrictEqual(seuilsPossibles(d), [105, 110, 115]);
  d.bornes = [110];
  assert.deepStrictEqual(seuilsPossibles(d), [105, 110]);
  assert.strictEqual(etatPatate({ seuil: 100, temp: 90 }), "siffle");
  // Repères : première fois vue fumer (siffler compte aussi), puis siffler
  d.obs = [{ t: 60, i: "froide" }, { t: 85, i: "fume" }, { t: 95, i: "siffle" }, { t: 80, i: "fume" }];
  assert.deepStrictEqual(reperes(d), { fume: 85, siffle: 95 });
  d.obs = [{ t: 60, i: "froide" }, { t: 75, i: "siffle" }];
  assert.deepStrictEqual(reperes(d), { fume: 75, siffle: 75 });
  d.obs = [{ t: 60, i: "froide" }];
  assert.deepStrictEqual(reperes(d), { fume: null, siffle: null });
}
{
  const d = creerDuel({ rng: calme });
  d.actif = "bot";
  d.temp = 60;
  d.seuil = 80;
  // Thermomètre (fourchette 80-90 °C, retenue) : +15 laisse l'adversaire
  // à 5 °C de 80 °C, sans risque pour elle
  d.evenement = { type: "thermo", id: "bot", lo: 80, hi: 90 };
  d.fourchettes.bot = { lo: 80, hi: 90 };
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 2);
  // À 70 °C : +5 est sans risque, +10 et +15 peuvent faire exploser
  d.temp = 70;
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 0);
  // Gants : chauffe maximale
  d.evenement = { type: "gants", id: "bot" };
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 2);
}

console.log("potatoRules.test.js OK");
