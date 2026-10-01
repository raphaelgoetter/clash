#!/usr/bin/env node
// tagCards.js
// Enrichit data/cardNames.json avec les champs nécessaires au jeu Duel
// "Élixir" (/elixir) : `type`, `family`, et complète `elixir` pour les
// cartes qui n'en ont pas encore (sorts, bâtiments, troupes à stats
// composites — generateCardStats.js ne remplit que les troupes éligibles à
// La Juste Carte). Usage PONCTUEL, jamais dans un flux hebdomadaire.
//
// Mêmes garanties que generateCardNames.js / generateCardStats.js : un champ
// déjà présent (y compris corrigé à la main) n'est JAMAIS réécrit, sauf avec
// --force. Toutes les valeurs déduites sont une PROPOSITION à relire — voir
// le résumé et la liste "À VÉRIFIER" en fin d'exécution.
//
// Déductions :
//   - type   : "troop" | "flying" | "spell" | "building".
//              L'identifiant officiel de la carte (fetchCards) encode sa
//              catégorie : 26xxxxxx = troupe, 27xxxxxx = bâtiment,
//              28xxxxxx = sort. Les troupes volantes sont ensuite
//              distinguées via la liste FLYING ci-dessous (aucune donnée
//              API ne le dit).
//   - family : "goblin" | "skeleton" | "human" | "minion" | null.
//              D'abord le nom anglais (goblin / skeleton / minion), puis les
//              listes explicites ci-dessous pour ce que le nom ne dit pas.
//   - elixir : elixirCost de fetchCards (API officielle).
//
// Usage :
//   node scripts/tagCards.js            # complète les champs absents
//   node scripts/tagCards.js --dry-run  # affiche sans écrire
//   node scripts/tagCards.js --force    # recalcule type/family (jamais elixir déjà présent)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCards } from "../backend/services/clashApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.join(__dirname, "../data/cardNames.json");

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// Troupes volantes (l'API ne distingue pas air/sol)
const FLYING = new Set([
  "Baby Dragon",
  "Balloon",
  "Bats",
  "Electro Dragon",
  "Flying Machine",
  "Inferno Dragon",
  "Lava Hound",
  "Mega Minion",
  "Minion Horde",
  "Minions",
  "Phoenix",
  "Skeleton Barrel",
  "Skeleton Dragons",
]);

// Familles que le nom anglais ne révèle pas
const FAMILY_OVERRIDES = {
  // Squelettes déguisés
  Bomber: "skeleton",
  "Wall Breakers": "skeleton",
  Guards: "skeleton",
  Graveyard: "skeleton",
  Tombstone: "skeleton",
  // Humains
  "Archer Queen": "human",
  Archers: "human",
  Bandit: "human",
  "Barbarian Barrel": "human",
  "Barbarian Hut": "human",
  Barbarians: "human",
  "Battle Healer": "human",
  "Battle Ram": "human",
  Berserker: "human",
  "Boss Bandit": "human",
  "Dark Prince": "human",
  "Electro Wizard": "human",
  "Elite Barbarians": "human",
  Executioner: "human",
  Firecracker: "human",
  Fisherman: "human",
  "Golden Knight": "human",
  "Hog Rider": "human",
  Hunter: "human",
  "Ice Wizard": "human",
  Knight: "human",
  "Little Prince": "human",
  Lumberjack: "human",
  "Magic Archer": "human",
  "Mega Knight": "human",
  "Mighty Miner": "human",
  Miner: "human",
  Monk: "human",
  "Mother Witch": "human",
  Musketeer: "human",
  "Night Witch": "human",
  Prince: "human",
  Princess: "human",
  "Ram Rider": "human",
  Rascals: "human",
  Ronin: "human",
  "Royal Delivery": "human",
  "Royal Recruits": "human",
  "Three Musketeers": "human",
  Valkyrie: "human",
  Witch: "human",
  Wizard: "human",
};

// Cas discutables : valeur proposée mais à confirmer à la main
const TO_REVIEW = {
  "Minion Giant": "volante ? (family minion déduite du nom)",
  "Spirit Empress": "volante ou au sol selon le coût joué",
  Giant: "humain ?",
  "Royal Giant": "humain ?",
  "Rune Giant": "humaine ?",
  "Electro Giant": "humain ?",
  Bowler: "humain ?",
  "Mega Knight": "humain (armure) ?",
  Executioner: "humain ?",
  "Royal Delivery": "sort, family human (Recrue) ?",
  "Barbarian Barrel": "sort, family human ?",
  "Barbarian Hut": "bâtiment, family human ?",
  "Battle Ram": "family human (2 barbares) ?",
  Witch: "humaine, mais invoque des squelettes",
  "Goblin Giant": "goblin (nom), mais c'est un géant",
};

function typeFromId(id) {
  const prefix = String(id).slice(0, 2);
  if (prefix === "26") return "troop";
  if (prefix === "27") return "building";
  if (prefix === "28") return "spell";
  return null;
}

function deduceFamily(cardKey) {
  if (cardKey in FAMILY_OVERRIDES) return FAMILY_OVERRIDES[cardKey];
  const name = cardKey.toLowerCase();
  if (name.includes("goblin")) return "goblin";
  if (name.includes("skeleton")) return "skeleton";
  if (name.includes("minion")) return "minion";
  return null;
}

async function main() {
  const cardNames = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf-8"));

  console.log("Chargement du catalogue officiel (fetchCards)...");
  const officialCards = await fetchCards();
  const officialByName = new Map(officialCards.map((c) => [c.name, c]));

  const unknownType = [];
  const notInApi = [];
  const changes = [];

  for (const entry of cardNames) {
    const official = officialByName.get(entry.cardKey);
    if (!official) notInApi.push(entry.cardKey);

    const updated = [];

    if (FORCE || !("type" in entry)) {
      let type = official ? typeFromId(official.id) : null;
      if (type === "troop" && FLYING.has(entry.cardKey)) type = "flying";
      if (!type) unknownType.push(entry.cardKey);
      entry.type = type;
      updated.push(`type=${type}`);
    }

    if (FORCE || !("family" in entry)) {
      entry.family = deduceFamily(entry.cardKey);
      updated.push(`family=${entry.family}`);
    }

    if (entry.elixir == null && official?.elixirCost != null) {
      entry.elixir = official.elixirCost;
      updated.push(`elixir=${entry.elixir}`);
    }

    if (updated.length) changes.push(`  ${entry.cardKey.padEnd(20)} ${updated.join("  ")}`);
  }

  console.log("");
  console.log(`${changes.length} carte(s) modifiée(s) :`);
  for (const line of changes) console.log(line);

  const byType = {};
  const byFamily = {};
  for (const e of cardNames) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byFamily[e.family] = (byFamily[e.family] ?? 0) + 1;
  }
  console.log("");
  console.log("Répartition par type   :", byType);
  console.log("Répartition par famille :", byFamily);

  const missingElixir = cardNames.filter((e) => e.elixir == null).map((e) => e.cardKey);
  if (missingElixir.length) console.log(`\n⚠️  Élixir toujours absent : ${missingElixir.join(", ")}`);
  if (notInApi.length) console.log(`\n⚠️  Absentes de l'API (type non déduit) : ${notInApi.join(", ")}`);
  if (unknownType.length) console.log(`\n⚠️  Type inconnu : ${unknownType.join(", ")}`);

  console.log("\nÀ VÉRIFIER à la main :");
  for (const [cardKey, note] of Object.entries(TO_REVIEW)) {
    const e = cardNames.find((c) => c.cardKey === cardKey);
    if (e) console.log(`  ${cardKey.padEnd(20)} type=${e.type}  family=${e.family}  — ${note}`);
  }

  if (DRY_RUN) {
    console.log("\n(dry-run : aucun fichier écrit)");
    return;
  }
  await fs.writeFile(CARD_NAMES_PATH, `${JSON.stringify(cardNames, null, 2)}\n`);
  console.log(`\nÉcrit : ${CARD_NAMES_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
