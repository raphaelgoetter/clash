import assert from "assert";
import fs from "fs";
import {
  scoreDeck,
  contratBonus,
  contratsDisponibles,
  findContrat,
  multiplicateurDuJour,
  choisirDeckFinal,
  cartesDeDepart,
  tirerCarte,
  cartesSouhaitables,
  resoudreVoeux,
  computeCloture,
  computeFinal,
  isTooSoonSinceLastClosure,
  combinaisonsEnCours,
  formatPions,
} from "./draftroyale.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/draftroyale/draftroyale.json", import.meta.url), "utf8"));

// Catalogue de test minimal, indépendant de data/cardNames.json
const CARTES = [
  ["sq1", "common", "troop", "skeleton", 1],
  ["sq2", "rare", "troop", "skeleton", 3],
  ["sq3", "epic", "troop", "skeleton", 3],
  ["sq4", "legendary", "troop", "skeleton", 4],
  ["sort1", "common", "spell", null, 2],
  ["sort2", "rare", "spell", null, 4],
  ["bat1", "rare", "building", null, 5],
  ["champ1", "champion", "troop", "human", 4],
  ["champ2", "champion", "troop", "human", 5],
  ["vol1", "epic", "flying", null, 4],
  ["leg1", "legendary", "troop", null, 6],
];
const CATALOG = new Map(CARTES.map(([cardKey, rarity, type, family, elixir]) => [cardKey, { cardKey, fr: cardKey, rarity, type, family, elixir }]));
const cards = (keys) => keys.map((k) => CATALOG.get(k));

function rngSeq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function main() {
  // ── Thèmes : paliers 3 et 4, le plus haut seulement ──────────────────
  {
    const s3 = scoreDeck(cards(["sq1", "sq2", "sq3"]), null, CONFIG);
    assert.ok(s3.details.some((d) => d.id === "theme_squelettes" && d.points === 6));
    const s4 = scoreDeck(cards(["sq1", "sq2", "sq3", "sq4"]), null, CONFIG);
    assert.strictEqual(s4.details.filter((d) => d.id === "theme_squelettes").length, 1);
    assert.ok(s4.details.some((d) => d.id === "theme_squelettes" && d.points === 12));
  }

  // ── Bonus de deck ──────────────────────────────────────────────────
  {
    const raretes = scoreDeck(cards(["sq1", "sq2", "sq3", "sq4", "champ1"]), null, CONFIG);
    assert.ok(raretes.details.some((d) => d.id === "raretes"));
    const trio = scoreDeck(cards(["sq1", "sort1", "bat1"]), null, CONFIG);
    assert.ok(trio.details.some((d) => d.id === "trio"));
    const cycle = scoreDeck(cards(["sq1", "sort1", "sq2"]), null, CONFIG); // moyenne 2
    assert.ok(cycle.details.some((d) => d.id === "cycle"));
    const lourd = scoreDeck(cards(["bat1", "leg1", "champ2"]), null, CONFIG); // moyenne 5,33
    assert.ok(lourd.details.some((d) => d.id === "lourd"));
  }

  // ── Contrat : bonus = points × (multiplicateur − 1), rien si raté ─────
  {
    assert.strictEqual(contratsDisponibles(CONFIG).length, CONFIG.themes.length * CONFIG.paliers.length);
    assert.strictEqual(multiplicateurDuJour(CONFIG, 1), 2);
    assert.strictEqual(multiplicateurDuJour(CONFIG, 5), null);
    const contrat = { ...findContrat(CONFIG, "squelettes:4"), multiplicateur: 2 };
    assert.strictEqual(contratBonus(contrat), 12);
    assert.strictEqual(contratBonus({ ...contrat, multiplicateur: 1.25 }), 3);
    const ok = scoreDeck(cards(["sq1", "sq2", "sq3", "sq4"]), contrat, CONFIG);
    assert.ok(ok.details.some((d) => d.id === "contrat" && d.points === 12));
    const rate = scoreDeck(cards(["sq1", "sq2", "sq3"]), contrat, CONFIG);
    assert.ok(!rate.details.some((d) => d.id === "contrat"));
    assert.ok(rate.total > 0); // aucune pénalité
  }

  // ── Deck final : retire la carte la moins utile, contrat compris ─────
  {
    const contrat = { ...findContrat(CONFIG, "squelettes:4"), multiplicateur: 2 };
    const main = ["sq1", "sq2", "sq3", "sq4", "sort1", "bat1", "champ1", "vol1", "leg1"];
    const deck = choisirDeckFinal(main, contrat, CONFIG, CATALOG);
    assert.strictEqual(deck.length, 8);
    assert.ok(["sq1", "sq2", "sq3", "sq4"].every((k) => deck.includes(k)));
    assert.deepStrictEqual(choisirDeckFinal(["sq1", "sq2"], null, CONFIG, CATALOG), ["sq1", "sq2"]);
  }

  // ── Combinaisons en cours : prochain palier, réalisables seulement ────
  {
    const pistes = combinaisonsEnCours(cards(["sq1", "sq2", "sq3", "sort1"]), CONFIG, 5);
    assert.ok(pistes.some((p) => p.label === "4 squelettes" && p.have === 3 && p.points === 12));
    assert.ok(pistes.some((p) => p.label === "3 sorts" && p.have === 1));
    assert.ok(!combinaisonsEnCours(cards(["sort1"]), CONFIG, 1).some((p) => p.label === "3 sorts"));
    // Réalisées incluses (jauge pleine) et en tête de liste
    assert.deepStrictEqual(pistes[0], { label: "3 squelettes", have: 3, need: 3, points: 6 });
    assert.strictEqual(formatPions({ have: 2, need: 3 }), "🟠🟠⚪");
  }

  // ── Arrivée en cours de partie : 2 cartes + 1 par jour manqué ─────────
  assert.strictEqual(cartesDeDepart(1, CONFIG), 2);
  assert.strictEqual(cartesDeDepart(4, CONFIG), 5);

  // ── Pioche : jamais une carte exclue ──────────────────────────────────
  {
    const exclues = [...CATALOG.keys()].filter((k) => k !== "vol1");
    assert.strictEqual(tirerCarte(exclues, CATALOG), "vol1");
    assert.strictEqual(tirerCarte([...CATALOG.keys()], CATALOG), null);
  }

  // ── Vœux : copies limitées, priorité popularité, retour par défaut ────
  {
    const marcheVeille = [
      { key: "champ1", discordId: "d", at: "2026-10-01T10:00:00Z" },
      { key: "sort2", discordId: "e", at: "2026-10-01T11:00:00Z" },
    ];
    const depot = (key) => [{ key, jour: 1 }];
    const joueurs = {
      a: { username: "A", main: ["sq1"], depots: depot("x1"), popularite: 3 },
      b: { username: "B", main: ["sq2"], depots: depot("x2"), popularite: 2 },
      c: { username: "C", main: ["sq3"], depots: depot("x3"), popularite: 0 },
      d: { username: "D", main: ["sq4"], depots: depot("champ1"), popularite: 0 },
      e: { username: "E", main: ["vol1"], depots: depot("sort2"), popularite: 0 },
    };
    const actionsRaw = {
      a: { voeux: ["champ1", null, null] },
      b: { voeux: ["champ1", "sort2", null] },
      c: { voeux: ["champ1", null, null] },
    };
    assert.deepStrictEqual(cartesSouhaitables(marcheVeille, joueurs.d, 2), ["sort2"]);
    const lignes = resoudreVoeux({ jour: 2, joueurs, actionsRaw, marcheVeille, config: CONFIG, rng: () => 0.5 });
    // 2 copies de champ1 : A (popularité 3) et B (2) servis, C récupère sa carte
    assert.ok(joueurs.a.main.includes("champ1"));
    assert.ok(joueurs.b.main.includes("champ1"));
    assert.ok(!joueurs.c.main.includes("champ1") && joueurs.c.main.includes("x3"));
    // D et E sans vœux : récupèrent leur propre carte
    assert.ok(joueurs.d.main.includes("champ1") && joueurs.e.main.includes("sort2"));
    // Popularité du déposant : +2 (A et B ont pris sa carte)
    assert.strictEqual(joueurs.d.popularite, 2);
    assert.ok(lignes.some((l) => l.type === "popularite" && l.discordId === "d" && l.nb === 2));
    assert.ok(Object.values(joueurs).every((j) => j.depots.length === 0));
  }

  // ── Clôture : marché du jour = dépôts du jour, dépôt de la veille consommé ──
  {
    const joueursAvant = {
      a: { username: "A", main: ["sq1"], depots: [{ key: "x1", jour: 1 }, { key: "sort1", jour: 2 }], popularite: 0 },
    };
    const r = computeCloture({ jour: 2, joueursAvant, actionsRaw: {}, marcheVeille: [{ key: "x1", discordId: "a" }], config: CONFIG, catalog: CATALOG, rng: Math.random });
    assert.deepStrictEqual(r.marcheJour.map((m) => m.key), ["sort1"]);
    assert.deepStrictEqual(r.joueursApres.a.depots.map((d) => d.key), ["sort1"]);
    assert.ok(r.joueursApres.a.main.includes("x1"));
    assert.strictEqual(r.final, null);
    assert.deepStrictEqual(joueursAvant.a.depots.length, 2); // pas de mutation de l'entrée
  }

  // ── Classement final : majorités partagées, popularité plafonnée, départage ──
  {
    const joueurs = {
      a: { username: "A", main: ["champ1", "sq1"], popularite: 9, arrivee: 1 },
      b: { username: "B", main: ["champ2", "sq2"], popularite: 0, arrivee: 0 },
      c: { username: "C", main: ["sq3"], popularite: 0, arrivee: 2 },
    };
    const ranking = computeFinal({ joueurs, config: CONFIG, catalog: CATALOG });
    const a = ranking.find((r) => r.discordId === "a");
    const b = ranking.find((r) => r.discordId === "b");
    assert.ok(a.details.some((d) => d.id === "maj_champions") && b.details.some((d) => d.id === "maj_champions"));
    assert.ok(a.details.some((d) => d.id === "popularite" && d.points === CONFIG.popularite_max));
    assert.strictEqual(ranking[0].discordId, "a");
    const egalite = computeFinal({
      joueurs: { x: { username: "X", main: [], popularite: 0, arrivee: 1 }, y: { username: "Y", main: [], popularite: 0, arrivee: 0 } },
      config: CONFIG,
      catalog: CATALOG,
    });
    assert.strictEqual(egalite[0].discordId, "y"); // arrivé en premier
  }

  // ── Dernier jour : computeCloture renvoie le classement final ─────────
  {
    const r = computeCloture({
      jour: CONFIG.duree_jours,
      joueursAvant: { a: { username: "A", main: ["sq1", "sq2", "sq3"], depots: [], popularite: 0 } },
      actionsRaw: {},
      marcheVeille: [],
      config: CONFIG,
      catalog: CATALOG,
      rng: rngSeq([0.1]),
    });
    assert.strictEqual(r.final.length, 1);
    assert.ok(r.final[0].score > 0);
  }

  assert.strictEqual(isTooSoonSinceLastClosure(null), false);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date().toISOString()), true);

  console.log("✓ draftroyale service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
