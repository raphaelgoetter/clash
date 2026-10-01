// Simulation locale d'équilibrage du jeu Élixir (bots contre bots)
import fs from "fs";
import {
  filterCardPool, poolKeysFrom, buildDeck, resolveCard, resolveOffers, applyResults, botOffer,
  computeFinalScores, STARTING_ELIXIR, OBJECTIVES, MAJORITIES,
} from "../backend/services/elixirRules.js";

const all = JSON.parse(fs.readFileSync(new URL("../data/cardNames.json", import.meta.url)));
const pool = filterCardPool(all, poolKeysFrom(JSON.parse(fs.readFileSync(new URL("../data/elixir/pool.json", import.meta.url)))));
const catalog = new Map(pool.map((c) => [c.cardKey, c]));
const N = Number(process.argv[2]) || 3000;
const START = Number(process.argv[3] ?? STARTING_ELIXIR);
const REGEN = Number(process.argv[4] ?? 4);
const CAP = Number(process.argv[5] ?? 10);

function run(maxPlayers, totalManches) {
  const nPlayers = maxPlayers === 1 ? 2 : maxPlayers;
  const freq = {}; let cards = 0, total = 0, left = 0, ties = 0, passes = 0, offers = 0;
  for (let g = 0; g < N; g++) {
    const deck = buildDeck(pool, { totalManches, maxPlayers }, Math.random);
    const start = START;
    let players = {};
    for (let i = 0; i < nPlayers; i++) players["p" + i] = { username: "p" + i, stock: start, collection: [] };
    for (let m = 0; m < totalManches; m++) {
      const mc = deck[m].map((k) => resolveCard(k, catalog));
      const o = {};
      for (const id of Object.keys(players)) {
        const opps = Object.keys(players).filter((x) => x !== id).map((x) => players[x].collection);
        o[id] = botOffer(mc, players[id], opps, { manchesLeft: totalManches - m, totalManches, catalog, regen: REGEN, aggressiveness: 0.7 + Math.random() * 0.6 });
        offers++; if (o[id].card == null) passes++;
      }
      const res = resolveOffers(mc, o, players);
      ties += res.filter((r) => r.tie).length;
      players = applyResults(players, res, { regen: REGEN, cap: CAP });
    }
    for (const s of computeFinalScores(players, catalog, totalManches)) {
      cards += s.cardPoints; total += s.total; left += s.stock;
      for (const a of s.achieved) freq[a.id] = (freq[a.id] || 0) + 1;
    }
  }
  const np = N * nPlayers;
  console.log(`\n== ${maxPlayers === 1 ? "solo (bot vs bot)" : maxPlayers + " joueurs"}, ${totalManches} manches ==`);
  console.log(`pts cartes/joueur ${(cards / np).toFixed(2)} | score moyen ${(total / np).toFixed(2)} | élixir restant ${(left / np).toFixed(2)} | égalités/partie ${(ties / N).toFixed(2)} | passes ${(100 * passes / offers).toFixed(1)}%`);
  for (const o of [...OBJECTIVES, ...MAJORITIES]) console.log(`  ${o.id.padEnd(16)} ${o.points}pts  ${(100 * (freq[o.id] || 0) / np).toFixed(1)}%`);
}

for (const [mp, tm] of [[1, 5], [2, 5], [3, 5], [2, 10], [3, 10]]) run(mp, tm);
