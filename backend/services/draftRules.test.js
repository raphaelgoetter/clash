import assert from "assert";
import fs from "fs";
import {
  compterCartes,
  plusGrandGroupe,
  aUnCarre,
  pointsMain,
  nbFamilles,
  distribuer,
  ajouterJoueur,
  echangeValide,
  resoudreEchanges,
  computeTour,
  classement,
  choixGlouton,
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

  // ── Cartes en jeu : joueurs + en_plus, au moins min ───────────────────
  assert.strictEqual(nbFamilles(3, { min: 6, en_plus: 0 }), 6);
  assert.strictEqual(nbFamilles(15, { min: 6, en_plus: 0 }), 15);
  assert.strictEqual(nbFamilles(2, { min: 0, en_plus: 1 }), 3);

  // ── Distribution : 5 exemplaires par carte, 4 par main, jamais de carré ──
  for (let i = 0; i < 50; i++) {
    const d = distribuer({ familles: ["a", "b", "c"], joueurIds: ["p1", "p2"], config: CONFIG });
    assert.strictEqual(d.mains.p1.length, 4);
    assert.strictEqual(d.marche.length, 15 - 8);
    assert.ok(!aUnCarre(d.mains.p1, CONFIG) && !aUnCarre(d.mains.p2, CONFIG));
  }

  // ── Arrivée : une carte de plus en jeu au-delà du minimum ─────────────
  {
    const marche = Array(10).fill("a").concat(Array(5).fill("b"));
    const sous = ajouterJoueur({ familles: ["a", "b", "c"], marche, nbJoueursAvant: 0, reglesFamilles: { min: 3, en_plus: 0 }, config: CONFIG, catalog: CATALOG });
    assert.strictEqual(sous.familles.length, 3);
    assert.strictEqual(sous.marche.length, 11);
    const au = ajouterJoueur({ familles: ["a", "b", "c"], marche, nbJoueursAvant: 3, reglesFamilles: { min: 3, en_plus: 0 }, config: CONFIG, catalog: CATALOG });
    assert.strictEqual(au.familles.length, 4);
    assert.strictEqual(au.marche.length + au.main.length, 15 + 5);
  }

  // ── Échanges ─────────────────────────────────────────────────────────
  assert.ok(echangeValide({ prise: "a", depot: "b" }, ["b"], ["a"]));
  assert.ok(!echangeValide({ prise: "a" }, ["b"], ["a"]));
  assert.ok(!echangeValide({ prise: "z", depot: "b" }, ["b"], ["a"]));

  // Carte non disputée : obtenue, popularité inchangée ; dépôt au marché
  {
    const joueurs = { p1: { main: ["b", "c", "c", "d"], popularite: 2 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" } }, marche: ["a", "e"] });
    assert.deepStrictEqual([...joueurs.p1.main].sort(), ["a", "c", "c", "d"]);
    assert.strictEqual(joueurs.p1.popularite, 2);
    assert.deepStrictEqual([...r.marche].sort(), ["b", "e"]);
  }

  // Assez d'exemplaires pour tous : pas de dispute
  {
    const joueurs = { p1: { main: ["b"], popularite: 0 }, p2: { main: ["c"], popularite: 0 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "a", "e"] });
    assert.ok(r.lignes.every((l) => l.type === "prise" && !l.disputee));
  }

  // Dispute : le plus populaire gagne (popularité à 0), le perdant +1 et
  // reçoit une autre carte du marché
  {
    const joueurs = { p1: { main: ["b"], popularite: 3 }, p2: { main: ["c"], popularite: 1 } };
    const r = resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"] });
    assert.deepStrictEqual(joueurs.p1.main, ["a"]);
    assert.strictEqual(joueurs.p1.popularite, 0);
    assert.deepStrictEqual(joueurs.p2.main, ["e"]);
    assert.strictEqual(joueurs.p2.popularite, 2);
    assert.ok(r.lignes.some((l) => l.type === "perdue" && l.discordId === "p2" && l.voulue === "a" && l.key === "e"));
    assert.deepStrictEqual([...r.marche].sort(), ["b", "c"]);
  }

  // Égalité de popularité : tirage au sort, un seul gagnant
  {
    let gagnants = new Set();
    for (let i = 0; i < 40; i++) {
      const joueurs = { p1: { main: ["b"], popularite: 0 }, p2: { main: ["c"], popularite: 0 } };
      resoudreEchanges({ joueurs, actions: { p1: { prise: "a", depot: "b" }, p2: { prise: "a", depot: "c" } }, marche: ["a", "e"] });
      const g = ["p1", "p2"].filter((id) => joueurs[id].main[0] === "a");
      assert.strictEqual(g.length, 1);
      gagnants.add(g[0]);
    }
    assert.strictEqual(gagnants.size, 2);
  }

  // Échange incomplet : main inchangée
  {
    const joueurs = { p1: { main: ["b"], popularite: 0 } };
    resoudreEchanges({ joueurs, actions: { p1: { prise: "a" } }, marche: ["a"] });
    assert.deepStrictEqual(joueurs.p1.main, ["b"]);
  }

  // ── Tour : carré → décompte pour tous puis redistribution ──────────────
  {
    const joueursAvant = {
      p1: { main: ["a", "a", "a", "b"], popularite: 0, points: 5 },
      p2: { main: ["c", "c", "d", "e"], popularite: 0, points: 0 },
    };
    const t = computeTour({
      joueursAvant,
      actions: { p1: { prise: "a", depot: "b" } },
      marche: ["a", "a", "c", "d", "d", "d", "e", "e", "e", "e", "b", "b", "b", "c", "c"].slice(0, 7),
      familles: ["a", "b", "c", "d", "e"],
      config: CONFIG,
      dernier: false,
    });
    assert.deepStrictEqual(t.carres, ["p1"]);
    assert.strictEqual(t.joueurs.p1.points, 5 + CONFIG.points_carre);
    assert.strictEqual(t.joueurs.p1.carres, 1);
    assert.strictEqual(t.joueurs.p2.points, 2);
    assert.ok(t.redistribution);
    assert.strictEqual(t.marche.length, 25 - 8);
    assert.strictEqual(joueursAvant.p1.main.length, 4); // non muté
  }

  // Sans carré : pas de décompte, sauf au dernier tour
  {
    const joueursAvant = { p1: { main: ["a", "a", "b", "c"], popularite: 0, points: 0 } };
    const base = { joueursAvant, actions: {}, marche: ["d"], familles: ["a", "b", "c", "d"], config: CONFIG };
    assert.strictEqual(computeTour({ ...base, dernier: false }).scores, null);
    const fin = computeTour({ ...base, dernier: true });
    assert.strictEqual(fin.joueurs.p1.points, 2);
    assert.ok(!fin.redistribution);
  }

  // ── Classement : points, puis carrés, puis arrivée ─────────────────────
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
