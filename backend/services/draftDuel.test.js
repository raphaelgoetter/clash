import assert from "assert";
import fs from "fs";
import {
  nbCartesMarchand,
  construireMarche,
  isMancheReady,
  applyJoin,
  computeMancheDuel,
  voeuxDuBot,
  carteLaMoinsUtile,
  isNewHighScore,
  isStale,
} from "./draftDuel.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/draftroyale/draftroyale.json", import.meta.url), "utf8"));

// Catalogue de test minimal, indépendant de data/cardNames.json
const CARTES = [
  ["sq1", "common", "troop", "skeleton", 1],
  ["sq2", "rare", "troop", "skeleton", 3],
  ["sq3", "epic", "troop", "skeleton", 3],
  ["sort1", "common", "spell", null, 2],
  ["bat1", "rare", "building", null, 5],
  ["champ1", "champion", "troop", "human", 4],
  ["vol1", "epic", "flying", null, 4],
  ["leg1", "legendary", "troop", null, 6],
  ["c1", "common", "troop", null, 3],
  ["c2", "common", "troop", null, 3],
  ["c3", "common", "troop", null, 3],
  ["c4", "common", "troop", null, 3],
];
const CATALOG = new Map(CARTES.map(([cardKey, rarity, type, family, elixir]) => [cardKey, { cardKey, fr: cardKey, rarity, type, family, elixir }]));

function main() {
  // ── Marchand : joueurs + 2, le solo compte pour 2 joueurs ─────────────
  assert.strictEqual(nbCartesMarchand(1, CONFIG), 4);
  assert.strictEqual(nbCartesMarchand(2, CONFIG), 4);
  assert.strictEqual(nbCartesMarchand(3, CONFIG), 5);

  // ── Marché : dépôts + cartes du Marchand uniques, jamais déjà déposées ──
  {
    const marche = construireMarche([{ key: "sq1", discordId: "a" }], 4, CATALOG);
    assert.strictEqual(marche.length, 5);
    const marchand = marche.filter((m) => m.discordId === null);
    assert.strictEqual(marchand.length, 4);
    assert.ok(marchand.every((m) => m.copies === 1 && m.key !== "sq1"));
    assert.strictEqual(new Set(marche.map((m) => m.key)).size, 5);
  }

  // ── Manche prête : tous les sièges occupés et tous les tours finis ─────
  {
    const state = { players: ["a", "b"], maxPlayers: 2 };
    assert.strictEqual(isMancheReady(state, { a: { fini: true } }), false);
    assert.strictEqual(isMancheReady(state, { a: { fini: true }, b: { fini: true } }), true);
    assert.strictEqual(isMancheReady({ players: ["a"], maxPlayers: 2 }, { a: { fini: true } }), false);
  }

  // ── Inscription : lobby fermé une fois complet ─────────────────────────
  {
    const r = applyJoin({ players: ["a"], maxPlayers: 2, rosterLocked: false }, "b");
    assert.ok(r.allowed && r.rosterLocked);
    assert.strictEqual(applyJoin({ players: ["a", "b"], maxPlayers: 2, rosterLocked: true }, "c").allowed, false);
    assert.ok(applyJoin({ players: ["a", "b"], maxPlayers: 2, rosterLocked: true }, "a").isSeated);
  }

  // ── Résolution : une carte du Marchand ne va qu'à un joueur, sans popularité ──
  {
    const state = {
      manche: 2,
      totalManches: 7,
      maxPlayers: 2,
      marche: [
        { key: "champ1", discordId: null, copies: 1 },
        { key: "c1", discordId: "b" },
      ],
    };
    const joueursAvant = {
      a: { username: "A", main: ["sq1"], depots: [{ key: "c2", jour: 1 }], popularite: 1 },
      b: { username: "B", main: ["sq2"], depots: [{ key: "c1", jour: 1 }, { key: "sq3", jour: 2 }], popularite: 0 },
    };
    const actions = { a: { voeux: ["champ1"] }, b: { voeux: ["champ1"] } };
    const r = computeMancheDuel({ state, joueursAvant, actions, config: CONFIG, catalog: CATALOG, rng: () => 0.5 });
    // A (plus populaire) obtient le champion, B récupère sa carte
    assert.ok(r.joueurs.a.main.includes("champ1"));
    assert.ok(!r.joueurs.b.main.includes("champ1") && r.joueurs.b.main.includes("c1"));
    assert.strictEqual(r.joueurs.a.popularite, 1);
    // Marché suivant : dépôt de B à la manche 2 + 4 cartes du Marchand
    assert.strictEqual(r.marche.length, 5);
    assert.ok(r.marche.some((m) => m.key === "sq3" && m.discordId === "b"));
    assert.strictEqual(r.final, null);
  }

  // ── Dernière manche : classement final, deck de 8 au plus ──────────────
  {
    const state = { manche: 7, totalManches: 7, maxPlayers: 1, marche: [] };
    const joueursAvant = {
      a: { username: "A", main: ["sq1", "sq2", "sq3", "sort1", "bat1", "champ1", "vol1", "leg1", "c1"], depots: [], popularite: 0, arrivee: 0 },
      bot: { username: "Bot", main: ["c2", "c3"], depots: [], popularite: 0, arrivee: 99 },
    };
    const r = computeMancheDuel({ state, joueursAvant, actions: {}, config: CONFIG, catalog: CATALOG });
    assert.strictEqual(r.final[0].discordId, "a");
    assert.strictEqual(r.final[0].deck.length, 8);
    assert.ok(!r.final[0].details.some((d) => d.id === "contrat"));
  }

  // ── Bot : garde ses synergies, vise ce qui améliore sa main ────────────
  {
    assert.notStrictEqual(carteLaMoinsUtile(["sq1", "sq2", "sq3", "c1"], CONFIG, CATALOG), "sq1");
    const voeux = voeuxDuBot(["sq1", "sq2"], ["c1", "sq3", "champ1"], CONFIG, CATALOG);
    assert.strictEqual(voeux.length, 3);
    assert.notStrictEqual(voeux[0], "c1");
  }

  // ── High score et inactivité ───────────────────────────────────────────
  assert.strictEqual(isNewHighScore(null, 10), true);
  assert.strictEqual(isNewHighScore({ points: 10 }, 10), false);
  assert.strictEqual(isNewHighScore(null, 0), false);
  assert.strictEqual(isStale({ termine: false, lastActivityAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), staleHours: 2 }), true);
  assert.strictEqual(isStale({ termine: false, lastActivityAt: new Date().toISOString(), staleHours: 2 }), false);

  console.log("✓ draftDuel service tests passed");
}

main();
