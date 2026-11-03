import assert from "assert";
import {
  NB_MANCHES,
  PROPOSITIONS_MAX,
  THEMES,
  cloreManche,
  creerDuel,
  jouerKevina,
  lettresJouables,
  mancheCourante,
  mancheOuverte,
  mancheSuivante,
  normaliser,
  passer,
  proposer,
  tempsEcoule,
  valider,
} from "./bacRules.js";

// Tirage reproductible
function rngFixe(seed = 1) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Duel dont la manche en cours porte sur `theme` et `lettre`
function duelSur(theme, lettre) {
  const d = creerDuel({ rng: rngFixe(), now: 0 });
  Object.assign(mancheCourante(d), { theme, lettre });
  return d;
}

// ── Normalisation : casse, accents, ligatures, séparateurs ──
assert.strictEqual(normaliser("Œuf-Écureuil d'Été"), "oeufecureuildete");

// ── Validation tolérante ──
assert.deepStrictEqual(valider("animaux", "K", "kangourou"), { ok: true, cle: "kangourou" });
assert.strictEqual(valider("animaux", "K", "  KANGOUROUS ").ok, true); // casse, pluriel
assert.strictEqual(valider("animaux", "E", "écureuil").ok, true);
assert.strictEqual(valider("animaux", "E", "ecureuil").ok, true); // sans accent
assert.strictEqual(valider("animaux", "C", "chevaux").ok, true); // pluriel en -aux
assert.strictEqual(valider("animaux", "M", "merle de Lawrence").ok, true); // mot principal
assert.strictEqual(valider("animaux", "C", "le chat").ok, true); // article
assert.deepStrictEqual(valider("animaux", "K", "chat"), { ok: false, raison: "lettre" });
assert.deepStrictEqual(valider("animaux", "K", "kzzzt"), { ok: false, raison: "inconnu" });
assert.deepStrictEqual(valider("animaux", "K", " "), { ok: false, raison: "vide" });
assert.strictEqual(valider("pays", "I", "l'Inde").ok, true);
assert.strictEqual(valider("pays", "A", "Angleterre").ok, true); // nom d'usage
assert.strictEqual(valider("villes", "R", "La Rochelle").ok, true); // sans l'article
assert.strictEqual(valider("villes", "L", "La Rochelle").ok, true); // avec
assert.strictEqual(valider("villes", "H", "Le Havre").ok, true);
assert.strictEqual(valider("prenoms", "J", "jean-pierre").ok, true);
assert.strictEqual(valider("clash", "B", "Bébé dragon").ok, true);
assert.strictEqual(valider("fruits", "P", "Pommes").ok, true);
assert.strictEqual(valider("metiers", "B", "boulanger").ok, true);
assert.strictEqual(valider("sports", "T", "tennis").ok, true);

// ── Chaque thème a assez de lettres jouables pour une partie ──
for (const id of Object.keys(THEMES)) assert.ok(lettresJouables(id).length >= 5, `${id} : trop peu de lettres`);

// ── Partie : 5 thèmes différents ──
{
  const d = creerDuel({ rng: rngFixe(3), now: 0 });
  assert.strictEqual(new Set(d.themes).size, NB_MANCHES);
  assert.ok(lettresJouables(mancheCourante(d).theme).includes(mancheCourante(d).lettre));
}

// ── Propositions : acceptée remplace, refusée ne change rien, la 2e fige ──
{
  const d = duelSur("animaux", "K");
  assert.deepStrictEqual(proposer(d, "joueur", "koala"), { ok: true, raison: null });
  assert.deepStrictEqual(proposer(d, "joueur", "kzzzt"), { ok: false, raison: "inconnu" });
  const m = mancheCourante(d);
  assert.strictEqual(m.reponses.joueur.mot, "Koala");
  assert.strictEqual(m.fige.joueur, true);
  assert.strictEqual(PROPOSITIONS_MAX, 2);
  assert.deepStrictEqual(proposer(d, "joueur", "kiwi"), { erreur: "fige" });
}

// ── Points : 1 par bonne réponse, 0,5 chacun pour la même ──
{
  const d = duelSur("animaux", "K");
  proposer(d, "joueur", "Kangourous");
  passer(d, "joueur");
  proposer(d, "bot", "kangourou");
  assert.strictEqual(mancheOuverte(d), true);
  passer(d, "bot");
  assert.strictEqual(mancheOuverte(d), false);
  assert.deepStrictEqual(mancheCourante(d).points, { joueur: 0.5, bot: 0.5 });

  const e = duelSur("animaux", "K");
  proposer(e, "joueur", "koala");
  proposer(e, "bot", "kiwi");
  cloreManche(e); // temps écoulé : réponses figées
  assert.deepStrictEqual(mancheCourante(e).points, { joueur: 1, bot: 1 });

  const f = duelSur("animaux", "K");
  proposer(f, "joueur", "koala");
  cloreManche(f);
  assert.deepStrictEqual(f.scores, { joueur: 1, bot: 0 });
}

// ── Temps, manche suivante, fin de partie (égalité possible) ──
{
  const d = creerDuel({ rng: rngFixe(5), now: 0 });
  assert.strictEqual(tempsEcoule(d, 60_000, 60_000), false);
  assert.strictEqual(tempsEcoule(d, 60_000, 60_001), true);
  assert.deepStrictEqual(mancheSuivante(d), { erreur: "ouverte" });
  for (let k = 0; k < NB_MANCHES; k++) {
    cloreManche(d);
    if (k < NB_MANCHES - 1) assert.deepStrictEqual(mancheSuivante(d, { now: 1 }), {});
  }
  assert.strictEqual(d.termine, true);
  assert.strictEqual(d.gagnant, "nul");
}

// ── Kévina : un mot valide du thème, ou rien ──
{
  const rng = rngFixe(9);
  for (let k = 0; k < 30; k++) {
    const d = creerDuel({ rng, now: 0 });
    jouerKevina(d, "bot", { trouve: 1, rng });
    const m = mancheCourante(d);
    assert.strictEqual(m.fige.bot, true);
    assert.ok(m.reponses.bot, `${m.theme} en ${m.lettre} : pas de réponse`);
    assert.strictEqual(valider(m.theme, m.lettre, m.reponses.bot.mot).ok, true);
  }
  const d = creerDuel({ rng, now: 0 });
  jouerKevina(d, "bot", { trouve: 0, rng });
  assert.strictEqual(mancheCourante(d).reponses.bot, null);
  assert.strictEqual(mancheCourante(d).fige.bot, true);
}

console.log("bacRules.test.js OK");
