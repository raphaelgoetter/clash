import assert from "assert";
import {
  CARTES,
  COUTS_ANNONCE,
  MANCHES_GAGNANTES,
  PAQUET,
  cartesJouables,
  choisir,
  choixAttenteKevina,
  choixKevina,
  creerDuel,
  jouer,
} from "./mascaradeRules.js";

// Tirage reproductible
function rngFixe(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// Duel dans un état choisi : mains (le joueur actif a déjà pioché), pioche,
// Réserve ; le reste comme au début d'une manche.
function duelDe({ joueur, bot, pioche = ["squelettes", "squelettes", "squelettes"], reserve = "gobelins", actif = "joueur" }) {
  const d = creerDuel({ commence: actif, rng: rngFixe() });
  Object.assign(d, {
    main: { joueur: [...joueur], bot: [...bot] },
    pioche: [...pioche],
    reserve,
    actif,
    piochee: (actif === "joueur" ? joueur : bot).at(-1),
    attente: null,
    guet: null,
  });
  return d;
}

function main() {
  // ── Paquet : 17 cartes, coûts annonçables par la Boule de feu ──
  assert.strictEqual(PAQUET.length, 17);
  assert.strictEqual(PAQUET.filter((c) => c === "squelettes").length, 4);
  assert.deepStrictEqual(COUTS_ANNONCE, [3, 4, 5, 7, 9]);
  assert.strictEqual(CARTES.triple.cout, 9);

  // ── Mise en place : Réserve, 2 écartées, 1 carte chacun, le premier pioche ──
  {
    const d = creerDuel({ rng: rngFixe(7) });
    assert.strictEqual(d.ecartees.length, 2);
    assert.ok(d.reserve);
    assert.deepStrictEqual([d.main.joueur.length, d.main.bot.length], [2, 1]);
    assert.strictEqual(d.pioche.length, 17 - 5 - 1);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Prince : l'adversaire défausse et repioche ; Trois mousquetaires défaussés = manche perdue ──
  {
    assert.deepStrictEqual([CARTES.prince.nb, CARTES.buche.nb], [2, 1]);
    const d = duelDe({ joueur: ["prince", "squelettes"], bot: ["gel"] });
    jouer(d, "joueur", "prince");
    assert.deepStrictEqual(d.defausse.bot, ["gel"]);
    // Le bot a repioché puis pioché son tour : 2 cartes
    assert.strictEqual(d.main.bot.length, 2);
    assert.strictEqual(d.actif, "bot");

    const t = duelDe({ joueur: ["prince", "squelettes"], bot: ["triple"] });
    jouer(t, "joueur", "prince");
    const h = t.historique[0];
    assert.deepStrictEqual([h.gagnant, h.fin, h.mains, h.reserve], ["joueur", "defausse", { joueur: "squelettes", bot: null }, "gobelins"]);
    assert.deepStrictEqual(h.defausse, { joueur: ["prince"], bot: ["triple"] });
    assert.strictEqual(t.manches.joueur, 1);
    assert.strictEqual(t.numero, 2);
  }

  // ── Prince sans rien à piocher (pioche et Réserve vides) : éliminé ──
  {
    const d = duelDe({ joueur: ["prince", "gobelins"], bot: ["gel"], pioche: [], reserve: null });
    jouer(d, "joueur", "prince");
    assert.strictEqual(d.historique[0].fin, "sansCarte");
    assert.strictEqual(d.historique[0].gagnant, "joueur");
  }

  // ── Boule de feu : touche si le coût annoncé est celui de la carte adverse ──
  {
    const d = duelDe({ joueur: ["bdf", "squelettes"], bot: ["prince"] });
    assert.deepStrictEqual(jouer(d, "joueur", "bdf", { cible: 2 }), { erreur: "cible" });
    jouer(d, "joueur", "bdf", { cible: 5 });
    assert.strictEqual(d.historique[0].fin, "bdf");
    const rate = duelDe({ joueur: ["bdf", "squelettes"], bot: ["prince"] });
    jouer(rate, "joueur", "bdf", { cible: 4 });
    assert.strictEqual(rate.historique.length, 0);
    assert.strictEqual(rate.dernier.effet.touche, false);
  }

  // ── Chevalier : protégé jusqu'à son prochain tour ──
  {
    const d = duelDe({ joueur: ["chevalier", "triple"], bot: ["prince"], pioche: ["squelettes", "gobelins", "gobelins"] });
    jouer(d, "joueur", "chevalier");
    // Le bot pioche des Squelettes, joue le Prince : sans effet
    jouer(d, "bot", "prince");
    assert.strictEqual(d.dernier.effet.protege, true);
    assert.ok(d.main.joueur.includes("triple"));
    assert.strictEqual(d.historique.length, 0);
    // Au tour suivant du joueur, la protection tombe
    assert.strictEqual(d.protege.joueur, false);
  }

  // ── Bûche : la carte la moins chère perd la manche ; égalité : rien ──
  {
    const d = duelDe({ joueur: ["buche", "mega"], bot: ["chevalier"] });
    jouer(d, "joueur", "buche");
    assert.strictEqual(d.historique[0].fin, "comparaison");
    assert.strictEqual(d.historique[0].gagnant, "joueur");
    const egal = duelDe({ joueur: ["buche", "gel"], bot: ["bdf"] });
    jouer(egal, "joueur", "buche");
    assert.strictEqual(egal.historique.length, 0);
    assert.strictEqual(egal.connu.bot, "gel");
  }

  // ── Gobelins et Tornade : information sur la carte adverse ──
  {
    const d = duelDe({ joueur: ["gobelins", "squelettes"], bot: ["mega"] });
    jouer(d, "joueur", "gobelins");
    assert.strictEqual(d.connu.joueur, "mega");
    const t = duelDe({ joueur: ["tornade", "chevalier"], bot: ["mega"] });
    jouer(t, "joueur", "tornade");
    assert.deepStrictEqual(t.main.joueur, ["mega"]);
    assert.strictEqual(t.main.bot[0], "chevalier");
    assert.deepStrictEqual([t.connu.joueur, t.connu.bot], ["chevalier", "mega"]);
  }

  // ── Gel : l'adversaire doit jouer la carte qu'il pioche ──
  {
    const d = duelDe({ joueur: ["gel", "squelettes"], bot: ["bdf"], pioche: ["gobelins", "squelettes", "squelettes"] });
    jouer(d, "joueur", "gel");
    assert.deepStrictEqual(cartesJouables(d, "bot"), ["gobelins"]);
    assert.deepStrictEqual(jouer(d, "bot", "bdf", { cible: 3 }), { erreur: "gel" });
  }

  // ── Trois mousquetaires : jamais jouables, sauf imposés par le Gel (manche perdue) ──
  {
    const d = duelDe({ joueur: ["triple", "squelettes"], bot: ["bdf"] });
    assert.deepStrictEqual(cartesJouables(d, "joueur"), ["squelettes"]);
    assert.deepStrictEqual(jouer(d, "joueur", "triple"), { erreur: "triple" });
    const g = duelDe({ joueur: ["gel", "squelettes"], bot: ["bdf"], pioche: ["triple", "squelettes", "squelettes"] });
    jouer(g, "joueur", "gel");
    assert.deepStrictEqual(cartesJouables(g, "bot"), ["triple"]);
    jouer(g, "bot", "triple");
    assert.deepStrictEqual([g.historique[0].gagnant, g.historique[0].fin], ["joueur", "triple"]);
  }

  // ── Squelettes : on voit le sommet, puis on le laisse ou le glisse dessous ──
  {
    const d = duelDe({ joueur: ["squelettes", "chevalier"], bot: ["bdf"], pioche: ["prince", "gobelins", "gel"] });
    jouer(d, "joueur", "squelettes");
    assert.deepStrictEqual(d.attente, { type: "squelettes", id: "joueur", carte: "prince" });
    assert.deepStrictEqual(cartesJouables(d, "joueur"), []);
    choisir(d, "joueur", "dessous");
    assert.deepStrictEqual(d.pioche, ["gel", "prince"]);
    assert.ok(d.main.bot.includes("gobelins"));
    // Laissée : l'adversaire la pioche, et le joueur le sait s'il la garde
    const l = duelDe({ joueur: ["squelettes", "chevalier"], bot: ["bdf"], pioche: ["prince", "gobelins", "gel"] });
    jouer(l, "joueur", "squelettes");
    choisir(l, "joueur", "laisser");
    jouer(l, "bot", "bdf", { cible: 9 });
    assert.strictEqual(l.connu.joueur, "prince");
  }

  // ── Méga chevalier : prend la Réserve, en remet une face cachée (Trois mousquetaires compris, sans perdre) ──
  {
    const d = duelDe({ joueur: ["mega", "triple"], bot: ["buche"], reserve: "gobelins" });
    jouer(d, "joueur", "mega");
    assert.deepStrictEqual(d.attente, { type: "mega", id: "joueur", cartes: ["triple", "gobelins"] });
    choisir(d, "joueur", 1);
    assert.deepStrictEqual(d.main.joueur, ["gobelins"]);
    assert.strictEqual(d.reserve, "triple");
    assert.strictEqual(d.reserveConnue.joueur, "triple");
    assert.strictEqual(d.historique.length, 0);
  }

  // ── Fin de pioche : la carte la plus chère gagne, puis l'élixir dépensé ──
  {
    const d = duelDe({ joueur: ["squelettes", "mega"], bot: ["prince"], pioche: [] });
    jouer(d, "joueur", "squelettes");
    assert.deepStrictEqual([d.historique[0].gagnant, d.historique[0].fin], ["joueur", "pioche"]);
    const e = duelDe({ joueur: ["gobelins", "gel"], bot: ["bdf"], pioche: [] });
    e.elixir.bot = 1;
    jouer(e, "joueur", "gobelins");
    assert.deepStrictEqual([e.historique[0].gagnant, e.historique[0].fin], ["joueur", "elixir"]);
    // Le perdant commence la manche suivante
    assert.strictEqual(e.actif, "bot");
  }

  // ── Partie : premier à MANCHES_GAGNANTES manches ──
  {
    const d = creerDuel({ rng: rngFixe(3) });
    d.manches.joueur = MANCHES_GAGNANTES - 1;
    Object.assign(d, { main: { joueur: ["buche", "mega"], bot: ["squelettes"] }, actif: "joueur", piochee: "mega", attente: null });
    jouer(d, "joueur", "buche");
    assert.strictEqual(d.termine, true);
    assert.strictEqual(d.gagnant, "joueur");
    assert.deepStrictEqual(jouer(d, "bot", "squelettes"), { erreur: "termine" });
  }

  // ── Kévina : coups légaux, Boule de feu sur la carte connue ──
  {
    const rng = rngFixe(11);
    for (let k = 0; k < 15; k++) {
      const d = creerDuel({ rng });
      while (!d.termine && d.historique.length < 2) {
        if (d.attente) choisir(d, d.attente.id, choixAttenteKevina(d, d.attente.id, { mondes: 8, rng }));
        else {
          const c = choixKevina(d, d.actif, { mondes: 8, erreur: 0.3, rng });
          assert.deepStrictEqual(jouer(d, d.actif, c.carte, { cible: c.cible }), {});
        }
      }
    }
    const d = duelDe({ joueur: ["bdf", "squelettes"], bot: ["mega"] });
    d.connu.joueur = "mega";
    assert.deepStrictEqual(choixKevina(d, "joueur", { mondes: 20, rng: rngFixe(5) }), { carte: "bdf", cible: 7 });
  }
}

main();
console.log("mascaradeRules.test.js OK");
