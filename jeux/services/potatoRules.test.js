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
  creerDuel,
  etatPatate,
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
  assert.strictEqual(e.evenement.type, "four");
  assert.deepStrictEqual(chauffesDe(e, "joueur"), CHAUFFES.map((c) => c * 2));
  assert.deepStrictEqual(chauffesDe(e, "bot"), CHAUFFES);
  chauffer(e, "joueur", 2, { rng: calme });
  assert.strictEqual(e.temp, TEMP_DEPART + 30);
}
{
  // Gants : la chauffe qui ferait exploser ne chauffe pas, la patate passe
  const d = creerDuel({ rng: calme });
  d.seuil = TEMP_DEPART + 10;
  d.evenement = { type: "gants", id: "joueur" };
  assert.deepStrictEqual(chauffer(d, "joueur", 2, { rng: calme }), {});
  assert.deepStrictEqual([d.temp, d.actif, d.bornes, d.manches.bot], [TEMP_DEPART, "bot", [TEMP_DEPART + 15], 0]);
  assert.strictEqual(d.dernier.gants, true);
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
  // Thermomètre : écart de 20, +15 laisse l'adversaire à 5 °C de l'explosion
  d.evenement = { type: "thermo", id: "bot" };
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 2);
  // Écart de 10 : seul +5 ne fait pas exploser
  d.temp = 70;
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 0);
  // Gants : chauffe maximale
  d.evenement = { type: "gants", id: "bot" };
  assert.strictEqual(choixKevina(d, "bot", { rng: calme }), 2);
}

console.log("potatoRules.test.js OK");
