import assert from "assert";
import { BOSS_POTATO } from "./bossPotato.js";
import { CHAUFFE_IMPOSEE, SEUIL_MAX, SEUIL_MIN, chauffePermise, evenementDe } from "./potatoRules.js";
import { rngBossDe } from "./bossRng.js";

// Kévina garde les réglages du mode normal (duel.json)
const config = { erreur_kevina: 0.3 };

// Aucun hasard hors de la graine
const random = Math.random;
Math.random = () => {
  throw new Error("Math.random interdit dans le Boss");
};

// Partie complète : `choix(d, i)` donne la chauffe du joueur (n° 0, 1, 2).
// Renvoie l'état final, les seuils vus à chaque manche et les réponses.
function partie(graine, choix) {
  const d = BOSS_POTATO.creer({ graine, config });
  const seuils = { [d.numero]: d.seuil };
  const etats = [structuredClone(d)];
  for (let i = 0; i < 200 && !d.termine; i++) {
    let k = choix(d, i);
    if (!chauffePermise(d, "joueur", k)) k = CHAUFFE_IMPOSEE;
    const r = BOSS_POTATO.jouer(d, { k, vue: d.vue }, { graine, config });
    assert.ok(!r.erreur, `coup refusé : ${r.erreur}`);
    assert.ok(r.texte);
    if (r.avantKevina) assert.strictEqual(r.avantKevina.actif, "bot");
    // Le joueur reprend la main, ou la partie est finie
    assert.ok(d.termine || d.actif === "joueur");
    seuils[d.numero] ??= d.seuil;
    etats.push(structuredClone(d));
  }
  return { d, seuils, etats };
}

const prudent = () => 0;
const audacieux = () => 2;
const melange = (graine) => {
  const rng = rngBossDe(graine, "test");
  return () => Math.floor(rng() * 3);
};

// ── Même graine + mêmes actions = mêmes états (températures secrètes comprises) ──
{
  const a = partie("abc", melange("x"));
  const b = partie("abc", melange("x"));
  assert.deepStrictEqual(a.etats, b.etats);
  assert.ok(a.d.termine);
}

// ── Le joueur commence la première manche ──
assert.strictEqual(BOSS_POTATO.creer({ graine: "abc", config }).actif, "joueur");

// ── Seuil d'une manche : ne dépend que de la graine et du numéro de manche ──
{
  const a = partie("graine1", prudent);
  const b = partie("graine1", audacieux);
  for (const m of Object.keys(a.seuils)) if (b.seuils[m] !== undefined) assert.strictEqual(a.seuils[m], b.seuils[m]);
  for (const s of Object.values(a.seuils)) assert.ok(s >= SEUIL_MIN && s <= SEUIL_MAX);
}

// ── Graines différentes = donnes différentes ──
{
  const graines = ["a", "b", "c", "d", "e", "f"];
  const premiers = graines.map((g) => BOSS_POTATO.creer({ graine: g, config }).seuil);
  assert.ok(new Set(premiers).size > 1, "seuils identiques pour toutes les graines");
  const parties = graines.map((g) => JSON.stringify(partie(g, prudent).etats));
  assert.strictEqual(new Set(parties).size, graines.length);
}

// ── Parties complètes : fin propre, résultats, scores dans leurs plages ──
const resultats = new Set();
for (let i = 0; i < 60; i++) {
  const { d } = partie(`g${i}`, i % 3 === 0 ? prudent : i % 3 === 1 ? audacieux : melange(`m${i}`));
  assert.ok(d.termine);
  assert.strictEqual(Math.max(d.manches.joueur, d.manches.bot), 2);
  const res = BOSS_POTATO.resultat(d);
  resultats.add(res);
  const s = BOSS_POTATO.score(d);
  if (res === "victoire") assert.ok(s >= 100 && s < 140, `score victoire ${s}`);
  else assert.ok(s >= 0 && s < 50, `score défaite ${s}`);
  assert.ok(BOSS_POTATO.score(d, { inactif: true }) < 50);
}
assert.ok(resultats.has("victoire") && resultats.has("defaite"), "victoires et défaites attendues sur 60 parties");

// ── Erreurs : vue dépassée, chauffe imposée, partie terminée ──
{
  const d = BOSS_POTATO.creer({ graine: "err", config });
  assert.strictEqual(BOSS_POTATO.jouer(d, { k: 0, vue: d.vue + 1 }, { graine: "err", config }).erreur, "perime");
  d.evenement = { type: "impose", id: "joueur" };
  assert.ok(evenementDe(d, "joueur"));
  const r = BOSS_POTATO.jouer(d, { k: 0, vue: d.vue }, { graine: "err", config });
  assert.strictEqual(r.erreur, "impose");
  assert.ok(r.message);
  const fini = partie("err", prudent).d;
  assert.strictEqual(BOSS_POTATO.jouer(fini, { k: 0, vue: fini.vue }, { graine: "err", config }).erreur, "termine");
}

// ── Ordre des scores ──
{
  const etat = (joueur, bot, coupsJoueur, gagnant = null) => ({ manches: { joueur, bot }, coupsJoueur, termine: Boolean(gagnant), gagnant });
  const s = (e, o) => BOSS_POTATO.score(e, o);
  const v20 = s(etat(2, 0, 8, "joueur"));
  const v20long = s(etat(2, 0, 12, "joueur"));
  const v21 = s(etat(2, 1, 6, "joueur"));
  const d12 = s(etat(1, 2, 3, "bot"));
  const d02 = s(etat(0, 2, 30, "bot"));
  const d02court = s(etat(0, 2, 4, "bot"));
  assert.ok(v20 > v20long && v20long > v21 && v21 >= 100);
  assert.ok(d12 < 50 && d12 > d02 && d02 > d02court && d02court >= 0);
  // Inactivité : < 50 même en menant
  assert.ok(s(etat(1, 0, 40), { inactif: true }) < 50);
  assert.ok(s(etat(2, 0, 4, "joueur"), { inactif: true }) < 50);
  assert.strictEqual(s(etat(0, 0, 0), { inactif: true }), 0);
}

Math.random = random;
console.log("bossPotato.test.js OK");
