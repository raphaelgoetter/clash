import assert from "assert";
import {
  NB_MANCHES,
  NIVEAUX,
  DIFFICULTES,
  PROPOSITIONS_MAX,
  THEMES,
  cloreManche,
  contester,
  creerDuel,
  jouerKevina,
  lettresDeManche,
  lettresJouables,
  mancheCourante,
  mancheOuverte,
  mancheSuivante,
  niveauDe,
  nomsDeFamille,
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
assert.strictEqual(valider("mythologie", "Z", "zeus").ok, true);
assert.strictEqual(valider("mythologie", "H", "Hydre de Lerne").ok, true);
assert.strictEqual(valider("jeuxvideo", "P", "Pikachu").ok, true);
assert.strictEqual(valider("jeuxvideo", "P", "Peach").ok, true); // dernier mot de « Princesse Peach »
assert.strictEqual(valider("jeuxvideo", "M", "Master Chief").ok, true); // nom anglais
assert.strictEqual(valider("transports", "T", "trottinette").ok, true);
assert.strictEqual(valider("autos", "M", "Mercedes").ok, true); // forme courte de « Mercedes-Benz »
assert.strictEqual(valider("musique", "B", "The Beatles").ok, true);
assert.strictEqual(valider("fromages", "T", "Taleggio AOP").ok, true); // suffixe d'appellation
assert.strictEqual(valider("fromages", "F", "fromage").ok, false); // pas le mot générique
assert.strictEqual(valider("outils", "P", "pied à coulisse").ok, true);
assert.strictEqual(valider("outils", "P", "pied").ok, false); // nom composé gardé entier // groupe : son nom, sans « The »

// ── Personnes : seul le nom de famille compte ──
assert.deepStrictEqual(nomsDeFamille("Robert De Niro"), ["Niro", "De Niro"]);
assert.deepStrictEqual(nomsDeFamille("Madonna"), ["Madonna"]);
assert.deepStrictEqual(valider("acteurs", "D", "Depardieu"), { ok: true, cle: "gerarddepardieu" });
assert.deepStrictEqual(valider("acteurs", "D", "gérard depardieu"), { ok: true, cle: "gerarddepardieu" });
assert.deepStrictEqual(valider("acteurs", "G", "Gérard Depardieu"), { ok: false, raison: "nom" });
assert.strictEqual(valider("acteurs", "N", "De Niro").ok, true);
assert.strictEqual(valider("acteurs", "D", "De Niro").ok, true);
assert.strictEqual(valider("musique", "D", "Céline Dion").ok, true);
assert.strictEqual(valider("musique", "M", "Madonna").ok, true);

// ── Chaque thème a assez de lettres jouables et un niveau ──
for (const id of Object.keys(THEMES)) {
  assert.ok(lettresJouables(id).length >= 5, `${id} : trop peu de lettres`);
  assert.ok(niveauDe(id), `${id} : sans niveau`);
}
assert.strictEqual(Object.values(NIVEAUX).flat().length, Object.keys(THEMES).length);

// ── Partie : 8 thèmes différents, difficulté croissante (DIFFICULTES) ──
for (const difficulte of Object.keys(DIFFICULTES)) {
  assert.strictEqual(DIFFICULTES[difficulte].length, NB_MANCHES);
  for (const graine of [1, 3, 7]) {
    const d = creerDuel({ rng: rngFixe(graine), now: 0, difficulte });
    assert.strictEqual(d.difficulte, difficulte);
    assert.strictEqual(new Set(d.themes).size, NB_MANCHES);
    // Du plus facile au plus difficile
    assert.deepStrictEqual(d.themes.map(niveauDe), DIFFICULTES[difficulte].map((m) => m.niveau));
    for (let k = 1; k <= NB_MANCHES; k++) {
      const m = mancheCourante(d);
      assert.ok(lettresDeManche(m.theme, k, difficulte).includes(m.lettre), `${difficulte}, manche ${k} : ${m.lettre}`);
      cloreManche(d);
      if (!d.termine) mancheSuivante(d, { rng: rngFixe(k), now: 0 });
    }
  }
}
{
  // Normal : jamais de lettre rare ; difficile : lettres rares dès la 2e manche
  const toutes = lettresJouables("animaux");
  const moitie = Math.ceil(toutes.length / 2);
  assert.deepStrictEqual(lettresDeManche("animaux", 1, "normal"), toutes.slice(0, moitie));
  assert.deepStrictEqual(lettresDeManche("animaux", 3, "normal"), toutes);
  assert.deepStrictEqual(lettresDeManche("animaux", 1, "difficile"), toutes);
  assert.deepStrictEqual(lettresDeManche("animaux", 2, "difficile"), toutes.slice(moitie));
  assert.ok(!Object.values(DIFFICULTES.normal).some((m) => m.lettres === "rares"));
  // Partie lancée avant les modes (sans `difficulte`) : déroulé normal
  const d = creerDuel({ rng: rngFixe(2), now: 0 });
  delete d.difficulte;
  cloreManche(d);
  assert.deepStrictEqual(mancheSuivante(d, { rng: rngFixe(4), now: 0 }), {});
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

// ── Contester : le dernier mot refusé « pas dans la liste », une fois ──
{
  const d = duelSur("animaux", "K");
  proposer(d, "joueur", "chat"); // mauvaise lettre : pas contestable
  assert.deepStrictEqual(contester(d, "joueur", 1), { erreur: "contestation" });
  proposer(d, "joueur", "kzzzt");
  assert.deepStrictEqual(contester(d, "joueur", 1), { mot: "kzzzt", theme: "animaux", lettre: "K" });
  assert.deepStrictEqual(contester(d, "joueur", 1), { erreur: "contestation" });
  assert.strictEqual(mancheCourante(d).reponses.joueur, null); // reste refusé
  assert.deepStrictEqual(mancheCourante(d).contestes, { joueur: ["kzzzt"] }); // pour le récapitulatif
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
