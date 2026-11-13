import assert from "assert";
import { BOSS_FRISE } from "./bossFrise.js";

const config = await BOSS_FRISE.chargerConfig();

// Créneau juste (ou faux, décalé d'un cran) de la carte choisie du joueur
function creneauDe(d, { faux = false } = {}) {
  const carte = d.mains.joueur[d.choix.joueur ?? 0];
  const i = d.frise.findIndex((c) => c.annee > carte.annee);
  const juste = i === -1 ? d.frise.length : i;
  if (!faux) return juste;
  return juste > 0 ? juste - 1 : juste + 1;
}

// Partie complète : `strategie(d, tour)` → { index, faux }. Renvoie l'état
// final et la liste des états après chaque action.
function partie(graine, strategie) {
  const d = BOSS_FRISE.creer({ graine, config });
  const etats = [structuredClone(d)];
  for (let tour = 0; !d.termine; tour++) {
    assert.ok(tour < 200, "partie sans fin");
    assert.strictEqual(d.actif, "joueur");
    const { index = 0, faux = false } = strategie(d, tour);
    let r = BOSS_FRISE.jouer(d, { type: "carte", index, vue: d.vue }, { graine, config });
    assert.ok(!r.erreur, r.message);
    assert.strictEqual(r.avantKevina, null);
    r = BOSS_FRISE.jouer(d, { type: "placer", creneau: creneauDe(d, { faux }), vue: d.vue }, { graine, config });
    assert.ok(!r.erreur, r.message);
    assert.ok(r.texte.startsWith("Tu places"));
    if (r.avantKevina) assert.ok(r.texteKevina.startsWith("Kévina place"));
    etats.push(structuredClone(d));
  }
  return { d, etats };
}

const parfait = () => ({ index: 0 });
const maladroit = (d, tour) => ({ index: d.mains.joueur.length - 1, faux: tour % 2 === 0 });

// ── Même graine + mêmes actions = mêmes états ──
{
  const a = partie("abc", maladroit);
  const b = partie("abc", maladroit);
  assert.deepStrictEqual(a.etats, b.etats);
  assert.ok(a.d.termine && ["victoire", "nul", "defaite"].includes(BOSS_FRISE.resultat(a.d)));
}

// ── Graines différentes = donnes différentes ──
{
  const donne = (g) => {
    const d = BOSS_FRISE.creer({ graine: g, config });
    return [d.frise, d.mains, d.pioche].map((l) => JSON.stringify(l)).join("|");
  };
  assert.strictEqual(donne("abc"), donne("abc"));
  assert.notStrictEqual(donne("abc"), donne("abd"));
  assert.notStrictEqual(donne("abc"), donne("xyz"));
}

// ── Création : joueur qui commence, mains du mode normal ──
{
  const d = BOSS_FRISE.creer({ graine: "abc", config });
  assert.strictEqual(d.actif, "joueur");
  assert.strictEqual(d.mains.joueur.length, config.taille_main);
  assert.strictEqual(d.mains.bot.length, config.taille_main);
}

// ── Actions refusées : vue dépassée, carte ou créneau invalides ──
{
  const graine = "abc";
  const d = BOSS_FRISE.creer({ graine, config });
  const avant = structuredClone(d);
  assert.strictEqual(BOSS_FRISE.jouer(d, { type: "placer", creneau: 0, vue: d.vue + 1 }, { graine, config }).erreur, "perime");
  assert.strictEqual(BOSS_FRISE.jouer(d, { type: "carte", index: 99, vue: d.vue }, { graine, config }).erreur, "carte");
  assert.strictEqual(BOSS_FRISE.jouer(d, { type: "placer", creneau: 99, vue: d.vue }, { graine, config }).erreur, "creneau");
  assert.ok(BOSS_FRISE.jouer(d, { type: "placer", creneau: 99, vue: d.vue }, { graine, config }).message);
  assert.deepStrictEqual(d, avant);
}

// ── Parties complètes sur plusieurs graines : issues et tranches de score ──
const scores = { victoire: [], nul: [], defaite: [] };
for (let g = 0; g < 60; g++) {
  for (const strategie of [parfait, maladroit]) {
    const { d } = partie(`g${g}`, strategie);
    const issue = BOSS_FRISE.resultat(d);
    scores[issue].push(BOSS_FRISE.score(d));
    // Le joueur parfait ne perd jamais (il vide sa main en premier)
    if (strategie === parfait) assert.notStrictEqual(issue, "defaite");
    assert.ok(BOSS_FRISE.score(d, { inactif: true }) < 50);
  }
}
assert.ok(scores.victoire.length && scores.defaite.length, "victoires et défaites attendues");
assert.ok(scores.victoire.every((s) => s >= 100));
assert.ok(scores.nul.every((s) => s >= 50 && s < 100));
assert.ok(scores.defaite.every((s) => s >= 0 && s < 50));

// ── Ordre des scores (états construits) ──
{
  const carte = (id, par) => ({ id, libelle: `C${id}`, annee: 1000 + id, par });
  const fin = ({ gagnant, mainJoueur = 0, mainBot = 0, erreurs = 0, justes = 0 }) => ({
    termine: gagnant != null,
    gagnant,
    frise: [carte(0), ...Array.from({ length: justes + erreurs }, (_, k) => carte(k + 1, "joueur"))],
    mains: { joueur: Array.from({ length: mainJoueur }, (_, k) => carte(100 + k)), bot: Array.from({ length: mainBot }, (_, k) => carte(200 + k)) },
    erreurs: Array.from({ length: erreurs }, () => ({ id: "joueur" })),
  });
  const s = (o, opts) => BOSS_FRISE.score(fin(o), opts);
  // Victoire > nul > défaite, même avec beaucoup d'erreurs
  assert.ok(s({ gagnant: "joueur", mainBot: 1, erreurs: 20 }) >= 100);
  assert.ok(s({ gagnant: "joueur", mainBot: 1, erreurs: 20 }) > s({ gagnant: "nul", erreurs: 0 }));
  assert.ok(s({ gagnant: "nul", erreurs: 60 }) >= 50);
  assert.ok(s({ gagnant: "nul", erreurs: 60 }) > s({ gagnant: "bot", mainJoueur: 1, justes: 10 }));
  assert.ok(s({ gagnant: "bot", mainJoueur: 1, justes: 10 }) < 50);
  assert.ok(s({ gagnant: "bot", mainJoueur: 30, erreurs: 30 }) >= 0);
  // Départages : victoire avec moins d'erreurs, puis plus d'avance
  assert.ok(s({ gagnant: "joueur", mainBot: 1, erreurs: 0 }) > s({ gagnant: "joueur", mainBot: 5, erreurs: 1 }));
  assert.ok(s({ gagnant: "joueur", mainBot: 3, erreurs: 1 }) > s({ gagnant: "joueur", mainBot: 1, erreurs: 1 }));
  // Nul : moins d'erreurs ; défaite : moins de cartes en main, puis plus de cartes bien placées
  assert.ok(s({ gagnant: "nul", erreurs: 1 }) > s({ gagnant: "nul", erreurs: 3 }));
  assert.ok(s({ gagnant: "bot", mainJoueur: 1 }) > s({ gagnant: "bot", mainJoueur: 2, justes: 4 }));
  assert.ok(s({ gagnant: "bot", mainJoueur: 2, justes: 3 }) > s({ gagnant: "bot", mainJoueur: 2, justes: 1 }));
  // Inactivité : < 50, même sur un état gagnant ; dès le départ, plus bas qu'une défaite serrée
  assert.ok(s({ gagnant: "joueur", mainBot: 4 }, { inactif: true }) < 50);
  const depart = BOSS_FRISE.creer({ graine: "abc", config });
  assert.ok(BOSS_FRISE.score(depart, { inactif: true }) < s({ gagnant: "bot", mainJoueur: 1 }));
}

console.log("bossFrise.test.js OK");
