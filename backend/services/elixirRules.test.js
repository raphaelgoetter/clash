import assert from "assert";
import fs from "fs";
import {
  filterCardPool,
  poolKeysFrom,
  buildDeck,
  resolveCard,
  resolveOffers,
  applyResults,
  isValidOffer,
  scoreCollection,
  botOffer,
  computeFinalScores,
  SPECIALS,
  STARTING_ELIXIR,
  isSpecialKey,
} from "./elixirRules.js";

const all = JSON.parse(fs.readFileSync(new URL("../../data/cardNames.json", import.meta.url)));
const poolJson = JSON.parse(fs.readFileSync(new URL("../../data/elixir/pool.json", import.meta.url)));
const pool = filterCardPool(all, poolKeysFrom(poolJson));
const catalog = new Map(pool.map((c) => [c.cardKey, c]));
const card = (key) => resolveCard(key, catalog);

// rng déterministe (LCG) pour des tirages reproductibles
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function main() {
  // ── Pool : exclusions et données complètes ──
  {
    assert.ok(!pool.some((c) => c.cardKey === "Mirror" || c.cardKey === "Spirit Empress"));
    assert.ok(pool.every((c) => c.elixir != null && c.type && c.rarity));
    // Pool choisi : toutes les cartes de pool.json existent et sont jouables
    assert.strictEqual(pool.length, poolKeysFrom(poolJson).length);
    assert.ok(!pool.some((c) => c.cardKey === "Golem"));
  }

  // ── buildDeck : participants + 1 cartes par manche (bot compris en solo), aucun doublon, spéciales ──
  for (let seed = 1; seed <= 50; seed++) {
    for (const [maxPlayers, totalManches] of [
      [1, 5],
      [3, 10],
    ]) {
      const deck = buildDeck(pool, { totalManches, maxPlayers }, seeded(seed));
      assert.strictEqual(deck.length, totalManches);
      const normal = deck.flat().filter((k) => !isSpecialKey(k));
      assert.strictEqual(normal.length, ((maxPlayers === 1 ? 2 : maxPlayers) + 1) * totalManches);
      assert.strictEqual(new Set(normal).size, normal.length);
      const specials = deck.flatMap((keys, i) => keys.filter(isSpecialKey).map((k) => ({ k, manche: i + 1 })));
      assert.strictEqual(specials.length, totalManches === 10 ? 2 : 1);
      for (const s of specials) {
        assert.ok(s.manche >= 4);
        assert.strictEqual(s.k, SPECIALS.joker.key);
      }
    }
  }

  // ── resolveOffers : meilleure offre, égalité, passe ──
  {
    const cards = [card("Bats"), card("Fireball")];
    const res = resolveOffers(cards, { a: { card: 0, bid: 5 }, b: { card: 0, bid: 4 }, c: { card: null, bid: 0 } });
    assert.strictEqual(res[0].winner, "a");
    assert.strictEqual(res[0].price, 5);
    assert.strictEqual(res[1].winner, null);
    assert.strictEqual(res[1].tie, false);

    const tie = resolveOffers(cards, { a: { card: 1, bid: 4 }, b: { card: 1, bid: 4 } });
    assert.strictEqual(tie[1].winner, null);
    assert.strictEqual(tie[1].tie, true);
  }

  // ── applyResults : seul le gagnant paie, Joker en collection, recharge plafonnée ──
  {
    const players = {
      a: { stock: 10, collection: [] },
      b: { stock: 10, collection: [] },
    };
    const results = [
      { key: "Knight", winner: "a", price: 4 },
      { key: SPECIALS.joker.key, winner: "b", price: 3 },
      { key: "Zap", winner: null, price: 0, tie: true },
    ];
    const next = applyResults(players, results, { regen: 0, cap: 99 });
    assert.strictEqual(next.a.stock, 6);
    assert.deepStrictEqual(next.a.collection, ["Knight"]);
    assert.strictEqual(next.b.stock, 7);
    assert.deepStrictEqual(next.b.collection, [SPECIALS.joker.key]);
    // Recharge plafonnée : 10 - 4 + 4 = 10 ; 10 - 3 + 4 = 11 → 10
    const capped = applyResults(players, results);
    assert.strictEqual(capped.a.stock, 10);
    assert.strictEqual(capped.b.stock, 10);
    // Les objets d'entrée ne sont pas mutés
    assert.strictEqual(players.a.stock, 10);
  }

  // ── isValidOffer ──
  {
    const cards = [card("Lava Hound")];
    assert.ok(isValidOffer(cards, { card: null, bid: 0 }, 0));
    assert.ok(isValidOffer(cards, { card: 0, bid: 7 }, 7));
    assert.ok(!isValidOffer(cards, { card: 0, bid: 6 }, 10));
    assert.ok(!isValidOffer(cards, { card: 0, bid: 8 }, 7));
    assert.ok(!isValidOffer(cards, { card: 3, bid: 9 }, 20));
  }

  // ── scoreCollection : objectifs ──
  {
    const ids = (s) => s.achieved.map((a) => a.id).sort();
    // Seuil de 3 cartes du thème, quel que soit le format
    assert.ok(!ids(scoreCollection([card("Zap"), card("Fireball")], [], { totalManches: 5 })).includes("sorts"));
    assert.ok(ids(scoreCollection([card("Zap"), card("Fireball"), card("Arrows")], [], { totalManches: 5 })).includes("sorts"));
    const gob = scoreCollection([card("Goblins"), card("Spear Goblins"), card("Dart Goblin")], [], { totalManches: 10 });
    assert.ok(ids(gob).includes("gobelins"));
    assert.ok(ids(gob).includes("cycle"));
    assert.strictEqual(gob.achieved.find((a) => a.id === "gobelins").label, "3 gobelins");
    // « Au moins » : une carte hors thème ne fait pas perdre l'objectif
    const mixte = scoreCollection([card("Goblins"), card("Spear Goblins"), card("Dart Goblin"), card("Zap")], [], { totalManches: 5 });
    assert.ok(ids(mixte).includes("gobelins"));
    // Gargouilles et champions : 3 aussi
    assert.ok(!ids(scoreCollection([card("Minions"), card("Mega Minion"), card("Zap")])).includes("gargouilles"));
    assert.ok(ids(scoreCollection([card("Minions"), card("Mega Minion"), card("Minion Horde")])).includes("gargouilles"));
    // Deck lourd : +3
    const lourd = scoreCollection([card("Lava Hound"), card("Lightning"), card("X-Bow")]);
    assert.strictEqual(lourd.achieved.find((a) => a.id === "lourd")?.points, 3);
    // Trio
    assert.ok(ids(scoreCollection([card("Goblins"), card("Zap"), card("Cannon")])).includes("trio"));
    // Total = coût des cartes + objectifs
    const gobCost = card("Goblins").elixir + card("Spear Goblins").elixir + card("Dart Goblin").elixir;
    assert.strictEqual(gob.cardPoints, gobCost);
    assert.strictEqual(gob.cardCount, 3);
    assert.strictEqual(gob.total, gobCost + gob.achieved.reduce((s, a) => s + a.points, 0));
  }

  // ── scoreCollection : le Joker prend la forme la plus avantageuse ──
  {
    const avec = scoreCollection([card("Goblins"), card("Spear Goblins"), { joker: true }], [], { totalManches: 10 });
    assert.ok(avec.achieved.some((a) => a.id === "gobelins"));
    // Le Joker ne compte pas dans la moyenne d'élixir (2 vraies cartes < 3)
    assert.ok(!avec.achieved.some((a) => a.id === "cycle"));
  }

  // ── scoreCollection : majorités strictes ──
  {
    const mine = [card("Golden Knight"), card("Bats")];
    const opp = [card("Archer Queen")];
    const res = scoreCollection(mine, [opp]);
    assert.ok(res.achieved.some((a) => a.id === "maj_cartes"));
    assert.ok(!res.achieved.some((a) => a.id === "maj_champions"));
  }

  // ── computeFinalScores : départage à l'élixir restant ──
  {
    const ranking = computeFinalScores(
      {
        a: { username: "A", stock: 2, collection: ["Bats"] },
        b: { username: "B", stock: 5, collection: ["Bats"] },
      },
      catalog,
      5,
    );
    assert.strictEqual(ranking[0].total, ranking[1].total);
    assert.strictEqual(ranking[0].id, "b");
  }

  // ── botOffer : jamais au-delà du stock, mise ≥ coût ──
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seeded(seed);
    const deck = buildDeck(pool, { totalManches: 5, maxPlayers: 1 }, rng);
    const cards = deck[0].map(card);
    const stock = Math.floor(rng() * (STARTING_ELIXIR + 1));
    const offer = botOffer(cards, { stock, collection: [] }, [[]], { manchesLeft: 5, totalManches: 5, catalog }, rng);
    if (offer.card != null) {
      assert.ok(offer.bid <= stock);
      assert.ok(offer.bid >= cards[offer.card].minBid);
    }
  }

  console.log("✓ elixirRules tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
