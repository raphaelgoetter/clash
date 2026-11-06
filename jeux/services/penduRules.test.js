import assert from "assert";
import {
  ERREURS_MAX,
  abandonner,
  appliquerDelais,
  chargerMots,
  creerDuel,
  departager,
  lettresDecouvertes,
  lettresFausses,
  motif,
  normaliser,
  proposerLettre,
  proposerMot,
} from "./penduRules.js";
import { buildFinalSvg, decodeFinal, decodeVue, encodeFinal, encodeVue, finalGenerateur, tailleTuiles } from "./penduImage.js";

const now = 1_000_000;
const duel = () => creerDuel({ mot: "éléphant", now });

// ── Liste de mots : 4 à 11 lettres, sans œ ni tiret ──
{
  const mots = chargerMots();
  assert.ok(mots.length > 5000);
  assert.ok(mots.includes("jazz")); // mots courts, les plus durs
  for (const m of mots) {
    assert.ok(normaliser(m).length === m.length && m.length >= 4 && m.length <= 11, m);
  }
}

// ── Lettres : accents ignorés, mot trouvé ──
{
  const d = duel();
  assert.strictEqual(d.cible, "ELEPHANT");
  assert.deepStrictEqual(proposerLettre(d, "joueur", "é", { now }), { ok: true, present: true, nb: 2 });
  assert.strictEqual(motif(d, "joueur"), "E_E_____");
  assert.strictEqual(motif(d, "bot"), "________"); // chacun de son côté
  assert.deepStrictEqual(proposerLettre(d, "joueur", "E"), { erreur: "dejaJouee" });
  assert.deepStrictEqual(proposerLettre(d, "joueur", "Z"), { ok: true, present: false, nb: 0 });
  assert.deepStrictEqual(lettresFausses(d, "joueur"), ["Z"]);
  for (const l of "LPHANT") proposerLettre(d, "joueur", l);
  assert.strictEqual(d.joueurs.joueur.fin, "trouve");
  assert.strictEqual(d.joueurs.joueur.erreurs, 1);
  assert.strictEqual(d.termine, false); // l'adversaire joue encore
}

// ── Mot faux : 2 erreurs ; 6 erreurs : pendu ──
{
  const d = duel();
  assert.deepStrictEqual(proposerMot(d, "bot", "elephants"), { ok: true, juste: false });
  assert.strictEqual(d.joueurs.bot.erreurs, 2);
  for (const l of "BCDFQ") proposerLettre(d, "bot", l);
  assert.strictEqual(d.joueurs.bot.erreurs, ERREURS_MAX);
  assert.strictEqual(d.joueurs.bot.fin, "pendu");
  assert.deepStrictEqual(proposerLettre(d, "bot", "E"), { erreur: "fini" });
  assert.deepStrictEqual(proposerMot(d, "joueur", "Éléphant"), { ok: true, juste: true });
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "joueur"]);
}

// ── Départage ──
{
  // Deux mots trouvés : le moins d'erreurs ; même nombre : nul
  const d = duel();
  proposerLettre(d, "joueur", "Z");
  proposerMot(d, "joueur", "elephant");
  proposerMot(d, "bot", "elephant");
  assert.strictEqual(d.gagnant, "bot");
  const e = duel();
  proposerMot(e, "joueur", "elephant");
  proposerMot(e, "bot", "elephant");
  assert.strictEqual(e.gagnant, "nul");
  // Deux pendus : le plus de lettres découvertes ; même nombre : nul
  const f = duel();
  proposerLettre(f, "joueur", "E");
  for (const s of ["joueur", "bot"]) for (let i = 0; i < 3; i++) proposerMot(f, s, `faux${i}`);
  assert.strictEqual(lettresDecouvertes(f, "joueur"), 2);
  assert.strictEqual(f.gagnant, "joueur");
  f.joueurs.joueur.lettres = [];
  assert.strictEqual(departager(f), "nul");
}

// ── Délai : 1 minute sans action, pendu (« temps ») ──
{
  const d = duel();
  proposerLettre(d, "joueur", "A", { now: now + 50_000 });
  assert.deepStrictEqual(appliquerDelais(d, 60_000, now + 60_001), ["bot"]);
  assert.strictEqual(d.joueurs.bot.fin, "temps");
  assert.deepStrictEqual(appliquerDelais(d, 60_000, now + 110_001), ["joueur"]);
  // Deux pendus au délai : le joueur a découvert le A
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "joueur"]);
}

// ── Solo : un seul siège, gagné si trouvé ──
{
  const d = creerDuel({ mot: "jazz", now, sieges: ["joueur"] });
  assert.deepStrictEqual(Object.keys(d.joueurs), ["joueur"]);
  for (const l of "EASIO") proposerLettre(d, "joueur", l);
  proposerMot(d, "joueur", "jizz");
  assert.deepStrictEqual([d.joueurs.joueur.fin, d.termine, d.gagnant], ["pendu", true, null]);
  const e = creerDuel({ mot: "jazz", now, sieges: ["joueur"] });
  for (const l of "JAZ") proposerLettre(e, "joueur", l);
  assert.deepStrictEqual([e.termine, e.gagnant], [true, "joueur"]);
  const f = creerDuel({ mot: "jazz", now, sieges: ["joueur"] });
  assert.deepStrictEqual(appliquerDelais(f, 60_000, now + 60_001), ["joueur"]);
  assert.deepStrictEqual([f.termine, f.gagnant], [true, null]);
  const g = creerDuel({ mot: "jazz", now, sieges: ["joueur"] });
  abandonner(g, "joueur");
  assert.deepStrictEqual([g.termine, g.gagnant], [true, null]);
}

// ── Abandon : défaite immédiate ──
{
  const d = duel();
  assert.deepStrictEqual(abandonner(d, "bot"), { ok: true });
  assert.deepStrictEqual([d.termine, d.gagnant, d.abandon], [true, "joueur", "bot"]);
  assert.deepStrictEqual(abandonner(d, "joueur"), { erreur: "termine" });
}

// ── Images : la vue ne contient jamais le mot ──
{
  const d = duel();
  proposerLettre(d, "joueur", "E");
  proposerLettre(d, "joueur", "S");
  const param = encodeVue({ motif: motif(d, "joueur"), fausses: lettresFausses(d, "joueur"), erreurs: 1, fin: null });
  assert.ok(!Buffer.from(param, "base64url").toString().includes("PHANT"));
  assert.deepStrictEqual(decodeVue(param), { motif: "E_E_____", fausses: ["S"], erreurs: 1, fin: null });
  assert.strictEqual(decodeVue("n'importe quoi"), null);
  const final = { mot: "éléphant", joueurs: [{ nom: "Alice 🎉", erreurs: 2, decouvertes: 8, fin: "trouve" }, { nom: "Bob", erreurs: 6, decouvertes: 3, fin: "pendu" }], gagnant: 0 };
  assert.deepStrictEqual(decodeFinal(encodeFinal(final)), { ...final, joueurs: [{ ...final.joueurs[0], nom: "Alice" }, final.joueurs[1]] });
  const solo = { mot: "jazz", joueurs: [final.joueurs[1]], gagnant: -1 };
  assert.deepStrictEqual(decodeFinal(encodeFinal(solo)), solo);
}

// ── Générateur : mot choisi, gagné ou perdu ──
{
  const gagne = finalGenerateur({ mot: "Plâtre", resultat: "gagne", erreurs: 3, nom: "Alice" });
  assert.deepStrictEqual(gagne, { mot: "plâtre", joueurs: [{ nom: "Alice", erreurs: 3, decouvertes: 6, fin: "trouve" }], gagnant: -1 });
  const perdu = finalGenerateur({ mot: "photographe", resultat: "temps", lettres: 4, nom: "Bob" });
  assert.deepStrictEqual(perdu.joueurs[0], { nom: "Bob", erreurs: ERREURS_MAX, decouvertes: 4, fin: "temps" });
  assert.strictEqual(finalGenerateur({ mot: "jazz", resultat: "perdu", nom: "C" }, () => 0.99).joueurs[0].decouvertes, 3);
  assert.strictEqual(finalGenerateur({ mot: "jazz", resultat: "gagne", erreurs: 9, nom: "C" }).joueurs[0].erreurs, ERREURS_MAX - 1);
  assert.ok(finalGenerateur({ mot: "pomme de terre", resultat: "gagne", nom: "C" }).erreur);
  assert.ok(finalGenerateur({ mot: "anticonstitutionnellement", resultat: "gagne", nom: "C" }).erreur);
  // Mot long : accepté, tuiles réduites dans la largeur de l'image (700 - 2 × 24)
  const long = finalGenerateur({ mot: "anticonstitutionnel", resultat: "gagne", nom: "C" });
  assert.deepStrictEqual(decodeFinal(encodeFinal(long)).mot, "anticonstitutionnel");
  assert.ok(buildFinalSvg(long).includes(`font-size="${Math.round(tailleTuiles(19).taille * 0.62)}"`));
  for (let n = 1; n <= 20; n++) {
    const { taille, ecart } = tailleTuiles(n);
    assert.ok(n * taille + (n - 1) * ecart <= 652, `${n} lettres`);
  }
  assert.deepStrictEqual(tailleTuiles(8), { taille: 54, ecart: 8 });
  assert.ok(decodeFinal(encodeFinal(gagne)));
}

console.log("penduRules.test.js OK");
