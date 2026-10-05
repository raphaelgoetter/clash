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
  jokerEnConflit,
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
  // gagne gain_perte et reçoit une autre carte du marché
  {
    const joueurs = { p1: { main: ["b"], joker: 3 }, p2: { main: ["c"], joker: 1 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"], config: CONFIG });
    assert.deepStrictEqual(joueurs.p1.main, ["a"]);
    assert.strictEqual(joueurs.p1.joker, 3);
    assert.deepStrictEqual(joueurs.p2.main, ["e"]);
    assert.strictEqual(joueurs.p2.joker, 1 + CONFIG.joker.gain_perte);
    assert.ok(r.lignes.some((l) => l.type === "perdue" && l.discordId === "p2" && l.voulue === "a" && l.key === "e"));
    assert.deepStrictEqual([...r.marche].sort(), ["b", "c"]);
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
    const COUT = CONFIG.joker.couts.saboter;
    const base = (j1, j2 = {}) => ({
      p1: { main: ["a", "a", "b", "c"], joker: COUT, points: 0, ...j1 },
      p2: { main: ["d", "d", "a", "e"], joker: COUT, points: 0, ...j2 },
    });
    const tour = (joueursAvant, actions) => computeTour({ joueursAvant, actions, marche: ["e"], familles: ["a", "b", "c", "d", "e"], config: CONFIG, dernier: false });

    // Validité : points suffisants, cible autre que soi, champs complets
    const j = base();
    assert.ok(jokerValide({ type: "voir", cible: "p2" }, "p1", j, CONFIG));
    assert.ok(!jokerValide({ type: "voir", cible: "p1" }, "p1", j, CONFIG));
    assert.ok(!jokerValide({ type: "voir", cible: "p2" }, "p1", base({ joker: 0 }), CONFIG));
    assert.ok(!jokerValide({ type: "echanger", cible: "p2", carte: "a" }, "p1", j, CONFIG));
    assert.ok(!jokerValide({ type: "priorite" }, "p1", j, CONFIG, false));

    // Voir main : main de la cible ; le Joker seul suffit à jouer le tour
    // (points dépensés, +gain_tour)
    {
      const t = tour(base(), { p1: { joker: { type: "voir", cible: "p2" } } });
      assert.ok(t.lignes.some((l) => l.action === "voir" && l.cible === "p2" && l.main.length === 4));
      assert.strictEqual(t.joueurs.p1.joker, COUT - CONFIG.joker.couts.voir + CONFIG.joker.gain_tour);
      assert.strictEqual(t.joueurs.p2.joker, COUT);
    }

    // Exemple de Raphael : 3 Géants + 1 Prince, Échange Joker seul (sans
    // marché) Prince contre le Géant d'un adversaire → quadruplé
    {
      const joueursAvant = { p1: { main: ["g", "g", "g", "p"], joker: COUT, points: 0 }, p2: { main: ["g", "a", "a", "b"], joker: 0, points: 0 } };
      const t = computeTour({
        joueursAvant,
        actions: { p1: { joker: { type: "echanger", cible: "p2", carte: "g", maCarte: "p" } } },
        marche: ["a", "b"],
        familles: ["g", "p", "a", "b"],
        config: CONFIG,
        dernier: false,
      });
      assert.deepStrictEqual(t.carres, ["p1"]);
    }

    // Même carte unique donnée au marché et à l'Échange Joker : le Joker
    // n'est ni joué ni payé, le marché se fait
    {
      const joueursAvant = { p1: { main: ["g", "g", "g", "p"], joker: COUT, points: 0 }, p2: { main: ["g", "a", "a", "b"], joker: 0, points: 0 } };
      const action = { prise: "a", depot: "p", joker: { type: "echanger", cible: "p2", carte: "g", maCarte: "p" } };
      assert.ok(jokerEnConflit(action, joueursAvant.p1.main));
      const t = computeTour({ joueursAvant, actions: { p1: action }, marche: ["a", "b"], familles: ["g", "p", "a", "b"], config: CONFIG, dernier: false });
      assert.deepStrictEqual([...t.joueurs.p1.main].sort(), ["a", "g", "g", "g"]);
      assert.strictEqual(t.joueurs.p1.joker, COUT + CONFIG.joker.gain_tour);
      assert.ok(!jokerEnConflit({ ...action, depot: "g" }, joueursAvant.p1.main));
    }

    // Échanger carte : réussi, puis carte absente (point perdu)
    {
      const t = tour(base(), { p1: { joker: { type: "echanger", cible: "p2", carte: "a", maCarte: "b" } } });
      assert.deepStrictEqual([...t.joueurs.p1.main].sort(), ["a", "a", "a", "c"]);
      assert.deepStrictEqual([...t.joueurs.p2.main].sort(), ["b", "d", "d", "e"]);
      const rate = tour(base(), { p1: { joker: { type: "echanger", cible: "p2", carte: "c", maCarte: "b" } } });
      assert.ok(rate.lignes.some((l) => l.action === "echanger" && l.echec === "absente"));
      assert.strictEqual(rate.joueurs.p1.joker, CONFIG.joker.gain_tour);
    }

    // Saboter : une carte de la cible part au marché contre une autre
    {
      const t = tour(base(), { p1: { joker: { type: "saboter", cible: "p2" } } });
      const l = t.lignes.find((x) => x.action === "saboter");
      assert.strictEqual(l.recue, "e");
      assert.ok(t.joueurs.p2.main.includes("e") && t.marche.includes(l.retiree));
    }

    // Protéger : l'action ciblée échoue, les deux points sont dépensés
    {
      const t = tour(base(), { p1: { joker: { type: "saboter", cible: "p2" } }, p2: { joker: { type: "proteger" } } });
      assert.ok(t.lignes.some((l) => l.action === "saboter" && l.echec === "protege"));
      assert.deepStrictEqual([...t.joueurs.p2.main].sort(), ["a", "d", "d", "e"]);
      assert.strictEqual(t.joueurs.p1.joker + t.joueurs.p2.joker, 2 * CONFIG.joker.gain_tour);
    }

    // Saboter peut empêcher un carré tout juste complété
    {
      const joueursAvant = base({}, { main: ["d", "d", "d", "a"], joker: 0 });
      const t = computeTour({
        joueursAvant,
        actions: { p2: { prise: "d", depot: "a" }, p1: { joker: { type: "saboter", cible: "p2" } } },
        marche: ["d", "e"],
        familles: ["a", "b", "c", "d", "e"],
        config: CONFIG,
        dernier: false,
      });
      assert.deepStrictEqual(t.carres, []);
    }

    // Bot : protection avec 3 identiques, sabotage du leader avec 2 points
    assert.deepStrictEqual(jokerDuBot("p1", base({ main: ["a", "a", "a", "b"] }), CONFIG), { type: "proteger" });
    assert.deepStrictEqual(jokerDuBot("p1", base({}, { points: 9 }), CONFIG), { type: "saboter", cible: "p2" });
    assert.strictEqual(jokerDuBot("p1", base({ joker: COUT - 1 }), CONFIG), null);
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
      config: CONFIG,
      dernier: false,
    });
    assert.deepStrictEqual(t.carres, ["p1"]);
    assert.strictEqual(t.joueurs.p1.points, 5 + CONFIG.points_carre);
    assert.strictEqual(t.joueurs.p1.carres, 1);
    assert.strictEqual(t.joueurs.p2.points, 2);
    assert.ok(t.redistribution);
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
