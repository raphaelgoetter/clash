// Collecte de combats pour calibrer le %matchup (usage local uniquement).
// 1) battle logs des membres des clans de la famille
// 2) battle logs d'un échantillon de leurs adversaires (élargit l'échantillon
//    au-delà de la famille)
// Sortie : un fichier JSON de combats dédoublonnés (cartes allégées).
//
// Usage : node temp/matchup-calibration/collect.mjs <sortie.json> [nbAdversaires=800]
import "dotenv/config";
import fs from "node:fs";
import { fetchBattleLog, fetchClan } from "../../backend/services/clashApi.js";
import { FAMILY_CLAN_TAGS } from "../../backend/services/warHistory.js";

const outPath = process.argv[2];
const maxOpponents = Number(process.argv[3] ?? 800);
if (!outPath) throw new Error("Chemin de sortie requis");

const CONCURRENCY = 6;

function slimCard(c) {
  return {
    name: c.name,
    level: c.level,
    maxLevel: c.maxLevel,
    rarity: c.rarity,
    elixirCost: c.elixirCost,
    evolutionLevel: c.evolutionLevel,
  };
}

function slimEntry(e) {
  if (!e) return e;
  const { cards, supportCards, rounds, ...rest } = e;
  return {
    tag: rest.tag,
    crowns: rest.crowns,
    startingTrophies: rest.startingTrophies,
    kingTowerHitPoints: rest.kingTowerHitPoints,
    princessTowersHitPoints: rest.princessTowersHitPoints,
    elixirLeaked: rest.elixirLeaked,
    cards: (cards ?? []).map(slimCard),
    supportCards: (supportCards ?? []).map(slimCard),
    rounds: rounds?.map((r) => ({ ...r, cards: r.cards?.map(slimCard) })),
  };
}

// Clé indépendante du point de vue : un même combat vu par les deux joueurs
// n'est gardé qu'une fois.
function battleKey(b) {
  const tags = [b.team?.[0]?.tag, b.opponent?.[0]?.tag].sort().join("|");
  return `${b.battleTime}|${tags}`;
}

const battles = new Map();
const seenPlayers = new Set();

function ingest(log) {
  const opponents = [];
  for (const b of log ?? []) {
    const key = battleKey(b);
    if (!battles.has(key)) {
      battles.set(key, {
        type: b.type,
        gameMode: b.gameMode?.name,
        battleTime: b.battleTime,
        rounds: b.rounds,
        team: (b.team ?? []).map(slimEntry),
        opponent: (b.opponent ?? []).map(slimEntry),
      });
    }
    const oppTag = b.opponent?.[0]?.tag;
    if (oppTag) opponents.push(oppTag);
  }
  return opponents;
}

async function runPool(tags, label) {
  let done = 0;
  let failed = 0;
  const found = [];
  const queue = [...tags];
  async function worker() {
    while (queue.length > 0) {
      const tag = queue.shift();
      if (seenPlayers.has(tag)) continue;
      seenPlayers.add(tag);
      try {
        found.push(...ingest(await fetchBattleLog(tag)));
      } catch {
        failed++;
      }
      done++;
      if (done % 50 === 0) {
        console.log(`${label} : ${done}/${tags.length} joueurs, ${battles.size} combats`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${label} terminé : ${done} joueurs (${failed} échecs), ${battles.size} combats`);
  return found;
}

const members = [];
for (const clanTag of FAMILY_CLAN_TAGS) {
  const clan = await fetchClan(`#${clanTag}`);
  members.push(...(clan.memberList ?? []).map((m) => m.tag));
}
const opponents = await runPool(members, "Famille");

// Échantillon d'adversaires, mélangé pour ne pas sur-représenter un joueur
const uniqueOpp = [...new Set(opponents)].filter((t) => !seenPlayers.has(t));
for (let i = uniqueOpp.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [uniqueOpp[i], uniqueOpp[j]] = [uniqueOpp[j], uniqueOpp[i]];
}
await runPool(uniqueOpp.slice(0, maxOpponents), "Adversaires");

fs.writeFileSync(outPath, JSON.stringify([...battles.values()]));
console.log(`Écrit : ${outPath}`);
