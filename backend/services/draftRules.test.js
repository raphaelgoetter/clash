import assert from "assert";
import fs from "fs";
import {
  compterCartes,
  plusGrandGroupe,
  aUnCarre,
  pointsMain,
  nbFamilles,
  choisirFamilles,
  distribuer,
  ajouterJoueur,
  echangeValide,
  resoudreEchanges,
  computeTour,
  classement,
  choixGlouton,
  jokerValide,
  lireBonus,
  voirMain,
  choisirVedettes,
  nbVedettes,
  jokerDuBot,
} from "./draftRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/draftroyale/draftroyale.json", import.meta.url), "utf8"));
const CATALOG = new Map(["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => [k, { cardKey: k, fr: k }]));
const fixe = (v) => () => v;

function main() {
  // ── Mains et points ────────────────────────────────────────────────
  assert.strictEqual(compterCartes(["a", "b", "a"]).get("a"), 2);
  assert.strictEqual(plusGrandGroupe(["a", "b", "a", "c"]), 2);
  assert.strictEqual(pointsMain(["a", "b", "c", "d"], CONFIG), 1);
  assert.strictEqual(pointsMain(["a", "a", "a", "d"], CONFIG), 3);
  assert.ok(aUnCarre(["a", "a", "a", "a"], CONFIG));
  assert.strictEqual(pointsMain(["a", "a", "a", "a"], CONFIG), CONFIG.points_carre);
  // Carte vedette : son quadruplé vaut points_vedette
  assert.strictEqual(pointsMain(["a", "a", "a", "a"], CONFIG, ["b", "a"]), CONFIG.points_vedette);
  assert.strictEqual(pointsMain(["a", "a", "a", "a"], CONFIG, ["b"]), CONFIG.points_carre);
  assert.strictEqual(pointsMain(["a", "a", "a", "c"], CONFIG, ["a"]), 3);
  // Une vedette pour 5 joueurs, jamais les mêmes d'une donne à l'autre si
  // possible, les vedettes déjà annoncées gardées
  assert.strictEqual(nbVedettes(3, CONFIG), 1);
  assert.strictEqual(nbVedettes(15, CONFIG), 3);
  assert.strictEqual(nbVedettes(16, CONFIG), 4);
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(choisirVedettes(["a", "b", "c"], 2, { precedentes: ["a"] }).sort(), ["b", "c"]);
  assert.deepStrictEqual(choisirVedettes(["a"], 2, { precedentes: ["a"] }), ["a"]);
  assert.strictEqual(choisirVedettes(["a", "b", "c", "d"], 2, { gardees: ["c"] })[0], "c");

  // ── Cartes en jeu : ⌈5N / 4⌉ cartes à 4 exemplaires ──────────────────
  assert.strictEqual(nbFamilles(1, CONFIG), 2);
  assert.strictEqual(nbFamilles(3, CONFIG), 4);
  assert.strictEqual(nbFamilles(4, CONFIG), 5);
  assert.strictEqual(nbFamilles(15, CONFIG), 19);

  // ── Ordre d'entrée des cartes : la liste prioritaire, puis le hasard ──
  {
    const catalog = new Map(["Princess", "Prince", "Giant", "x", "y"].map((k) => [k, {}]));
    assert.deepStrictEqual(choisirFamilles(2, CONFIG, catalog), ["Princess", "Prince"]);
    assert.deepStrictEqual(choisirFamilles(1, CONFIG, catalog, ["Princess", "Prince"]), ["Giant"]);
    assert.strictEqual(choisirFamilles(5, CONFIG, catalog).length, 5);
  }

  // ── Distribution : 4 par main, une carte par joueur au marché, le reste
  // en réserve, jamais de carré ──────────────────────────────────────
  for (let i = 0; i < 50; i++) {
    const d = distribuer({ familles: ["a", "b", "c", "d"], joueurIds: ["p1", "p2", "p3"], config: CONFIG });
    assert.strictEqual(d.mains.p1.length, 4);
    assert.strictEqual(d.marche.length, 3);
    assert.strictEqual(d.reserve.length, 1);
    assert.ok(["p1", "p2", "p3"].every((id) => !aUnCarre(d.mains[id], CONFIG)));
  }

  // ── Arrivées : cartes ajoutées selon le nombre de joueurs, marché d'une
  // carte par joueur, marché existant jamais retiré, aucune carte perdue ──
  {
    let partie = { familles: [], marche: [], reserve: [] };
    const mains = [];
    for (let n = 0; n < 6; n++) {
      const avant = [...partie.marche];
      const a = ajouterJoueur({ ...partie, nbJoueursAvant: n, config: CONFIG, catalog: CATALOG });
      assert.strictEqual(a.familles.length, nbFamilles(n + 1, CONFIG));
      assert.strictEqual(a.marche.length, n + 1);
      assert.deepStrictEqual(a.marche.slice(0, avant.length), avant);
      assert.ok(!aUnCarre(a.main, CONFIG));
      mains.push(a.main);
      partie = a;
      const total = mains.flat().length + partie.marche.length + partie.reserve.length;
      assert.strictEqual(total, partie.familles.length * CONFIG.exemplaires);
    }
  }

  // ── Échanges ─────────────────────────────────────────────────────────
  assert.ok(echangeValide({ prise: "a", depot: "b" }, ["b"], ["a"]));
  assert.ok(!echangeValide({ prise: "a" }, ["b"], ["a"]));
  assert.ok(!echangeValide({ prise: "z", depot: "b" }, ["b"], ["a"]));

  // Carte non disputée : obtenue, points Joker inchangés ; dépôt au marché
  {
    const joueurs = { p1: { main: ["b", "c", "c", "d"], joker: 2 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" } }, marche: ["a", "e"], config: CONFIG });
    assert.deepStrictEqual([...joueurs.p1.main].sort(), ["a", "c", "c", "d"]);
    assert.strictEqual(joueurs.p1.joker, 2);
    assert.deepStrictEqual([...r.marche].sort(), ["b", "e"]);
  }

  // Assez d'exemplaires pour tous : pas de dispute
  {
    const joueurs = { p1: { main: ["b"], joker: 0 }, p2: { main: ["c"], joker: 0 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "a", "e"], config: CONFIG });
    assert.ok(r.lignes.every((l) => l.type === "prise" && !l.disputee));
  }

  // Dispute : le plus de points Joker gagne (points conservés), le perdant
  // garde sa carte (pas d'échange) et gagne gain_perte
  {
    const joueurs = { p1: { main: ["b"], joker: 3 }, p2: { main: ["c"], joker: 1 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"], config: CONFIG });
    assert.deepStrictEqual(joueurs.p1.main, ["a"]);
    assert.strictEqual(joueurs.p1.joker, 3);
    assert.deepStrictEqual(joueurs.p2.main, ["c"]);
    assert.strictEqual(joueurs.p2.joker, 1 + CONFIG.joker.gain_perte);
    assert.ok(r.lignes.some((l) => l.type === "perdue" && l.discordId === "p2" && l.voulue === "a" && l.depot === "c"));
    assert.deepStrictEqual([...r.marche].sort(), ["b", "e"]);
  }

  // Carte verrouillée : personne ne la prend, échange annulé
  {
    const joueurs = { p1: { main: ["b"], joker: 0 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" } }, marche: ["a"], config: CONFIG, verrous: new Set(["a"]) });
    assert.deepStrictEqual(joueurs.p1.main, ["b"]);
    assert.deepStrictEqual(r.marche, ["a"]);
    assert.ok(r.lignes.some((l) => l.type === "verrouillee" && l.voulue === "a"));
  }

  // Priorité : servie avant les points Joker
  {
    const joueurs = { p1: { main: ["b"], joker: 0 }, p2: { main: ["c"], joker: 5 } };
    resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"], config: CONFIG, priorites: new Set(["p1"]) });
    assert.deepStrictEqual(joueurs.p1.main, ["a"]);
  }

  // Égalité de points Joker : tirage au sort, un seul gagnant
  {
    let gagnants = new Set();
    for (let i = 0; i < 40; i++) {
      const joueurs = { p1: { main: ["b"], joker: 0 }, p2: { main: ["c"], joker: 0 } };
      resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"], config: CONFIG });
      const g = ["p1", "p2"].filter((id) => joueurs[id].main[0] === "a");
      assert.strictEqual(g.length, 1);
      gagnants.add(g[0]);
    }
    assert.strictEqual(gagnants.size, 2);
  }

  // Échange incomplet : main inchangée
  {
    const joueurs = { p1: { main: ["b"], joker: 0 } };
    resoudreEchanges({ joueurs, actions: { p1: { prise: "a" } }, marche: ["a"], config: CONFIG });
    assert.deepStrictEqual(joueurs.p1.main, ["b"]);
  }

  // ── Joker ────────────────────────────────────────────────────────────
  {
    const joueurs = { p1: { main: ["a", "a", "b", "c"], joker: 2 }, p2: { main: ["d", "d", "a", "e"], joker: 0 } };
    const ctx = { id: "p1", joueurs, marche: ["e", "a"], config: CONFIG };

    // Menu « Bonus du tour »
    assert.deepStrictEqual(lireBonus("aucun", ctx), { joker: null });
    assert.deepStrictEqual(lireBonus("priorite", ctx), { joker: { type: "priorite" } });
    assert.deepStrictEqual(lireBonus("verrouiller:e", ctx), { joker: { type: "verrouiller", carte: "e" } });
    assert.strictEqual(lireBonus("verrouiller:z", ctx).erreur, "carte");
    assert.strictEqual(lireBonus("verrouiller:e", { ...ctx, id: "p2" }).erreur, "points");
    assert.strictEqual(lireBonus("saboter", ctx).erreur, "inconnue");

    // Validité : Priorité seulement avec un échange, Verrouiller sur le marché
    assert.ok(!jokerValide({ type: "priorite" }, "p1", joueurs, CONFIG, { echangeOk: false }));
    assert.ok(jokerValide({ type: "verrouiller", carte: "e" }, "p1", joueurs, CONFIG, { echangeOk: false, marche: ["e"] }));
    assert.ok(!jokerValide({ type: "verrouiller", carte: "e" }, "p1", joueurs, CONFIG, { marche: ["a"] }));

    // Espionner : instantané, une fois par tour
    const r = voirMain({ id: "p1", cible: "p2", joueurs, actions: {}, config: CONFIG });
    assert.deepStrictEqual(r.vu, { cible: "p2", main: ["d", "d", "a", "e"] });
    assert.strictEqual(voirMain({ id: "p1", cible: "p2", joueurs, actions: { p1: { vu: r.vu } }, config: CONFIG }).erreur, "deja");
    assert.strictEqual(voirMain({ id: "p1", cible: "p1", joueurs, actions: {}, config: CONFIG }).erreur, "cible");
    assert.strictEqual(voirMain({ id: "p2", cible: "p1", joueurs, actions: {}, config: CONFIG }).erreur, "points");

    // Tour : Verrouiller (payé, joue le tour seul) bloque la prise adverse ;
    // l'espionnage est mentionné au bilan sans jouer le tour
    const t = computeTour({
      joueursAvant: joueurs,
      actions: { p1: { joker: { type: "verrouiller", carte: "a" }, vu: r.vu }, p2: { prise: "a", depot: "e" } },
      marche: ["e", "a"],
      familles: ["a", "b", "c", "d", "e"],
      config: CONFIG,
      dernier: false,
    });
    assert.strictEqual(t.joueurs.p1.joker, 2 - CONFIG.joker.couts.verrouiller + CONFIG.joker.gain_tour);
    assert.deepStrictEqual([...t.joueurs.p2.main].sort(), ["a", "d", "d", "e"]);
    assert.ok(t.lignes.some((l) => l.action === "verrouiller" && l.carte === "a"));
    assert.ok(t.lignes.some((l) => l.action === "espionner" && l.cible === "p2"));

    // Bot : Priorité quand sa prise complète un quadruplé
    assert.deepStrictEqual(jokerDuBot("p1", { p1: { main: ["a", "a", "a", "b"], joker: 1 } }, "a", CONFIG), { type: "priorite" });
    assert.strictEqual(jokerDuBot("p1", { p1: { main: ["a", "a", "b", "c"], joker: 1 } }, "a", CONFIG), null);
  }

  // ── Tour : carré → décompte pour tous puis redistribution ──────────────
  {
    const joueursAvant = {
      p1: { main: ["a", "a", "a", "b"], joker: 0, points: 5 },
      p2: { main: ["c", "c", "d", "e"], joker: 0, points: 0 },
    };
    const t = computeTour({
      joueursAvant,
      actions: { p1: { prise: "a", depot: "b" } },
      marche: ["a", "d"],
      reserve: ["b", "b", "c", "d", "d", "d", "e", "e", "e", "e"],
      familles: ["a", "b", "c", "d", "e"],
      vedettes: ["a"],
      config: CONFIG,
      dernier: false,
    });
    assert.deepStrictEqual(t.carres, ["p1"]);
    assert.strictEqual(t.joueurs.p1.points, 5 + CONFIG.points_vedette);
    assert.ok(t.scores.find((x) => x.discordId === "p1").vedette);
    assert.strictEqual(t.joueurs.p1.carres, 1);
    assert.strictEqual(t.joueurs.p2.points, 2);
    assert.ok(t.redistribution);
    assert.ok(t.vedettes.length === 1 && t.vedettes[0] !== "a");
    assert.strictEqual(t.marche.length, 2);
    assert.strictEqual(t.reserve.length, 20 - 8 - 2);
    assert.strictEqual(joueursAvant.p1.main.length, 4); // non muté
  }

  // Sans carré : pas de décompte, sauf au dernier tour
  {
    const joueursAvant = { p1: { main: ["a", "a", "b", "c"], joker: 0, points: 0 } };
    const base = { joueursAvant, actions: {}, marche: ["d"], familles: ["a", "b", "c", "d"], config: CONFIG };
    assert.strictEqual(computeTour({ ...base, dernier: false }).scores, null);
    const fin = computeTour({ ...base, dernier: true });
    assert.strictEqual(fin.joueurs.p1.points, 2);
    assert.ok(!fin.redistribution);
  }

  // ── Classement : points + Joker restants, puis quadruplés, puis arrivée ──
  {
    const c = classement({ x: { username: "x", points: 10, joker: 3, carres: 1 }, y: { username: "y", points: 12, joker: 0, carres: 1 } });
    assert.deepStrictEqual(c.map((r) => [r.discordId, r.score]), [["x", 13], ["y", 12]]);
  }
  {
    const c = classement({
      x: { username: "x", points: 12, carres: 1, arrivee: 2 },
      y: { username: "y", points: 12, carres: 1, arrivee: 0 },
      z: { username: "z", points: 12, carres: 0, arrivee: 1 },
    });
    assert.deepStrictEqual(c.map((r) => r.discordId), ["y", "x", "z"]);
  }

  // ── Stratégie gloutonne : complète le plus gros groupe ────────────────
  assert.deepStrictEqual(choixGlouton(["a", "a", "a", "b"], ["a", "c"], fixe(0)), { prise: "a", depot: "b" });

  console.log("draftRules.test.js : OK");
}

main();
