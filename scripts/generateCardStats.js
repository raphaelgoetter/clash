#!/usr/bin/env node
// generateCardStats.js
// Enrichit data/cardNames.json avec les stats de combat (elixir, hp, dps,
// range) nécessaires au jeu "La Juste Carte" — devine une carte à partir
// d'indices comparatifs PV/Portée/DPS/Élixir. Usage PONCTUEL, jamais dans
// un flux hebdomadaire (comme generateCardNames.js).
//
// Décision : cardNames.json reste le SEUL fichier source de vérité pour les
// cartes (au lieu d'un catalogue dérivé séparé) — ce script ne fait
// qu'AJOUTER les champs elixir/hp/dps/range aux entrées qui n'en ont pas
// encore, sans jamais toucher fr/rarity ni écraser des stats déjà
// présentes (mêmes garanties que generateCardNames.js pour `fr` : une
// entrée déjà remplie, y compris corrigée à la main, n'est plus jamais
// réécrite automatiquement).
//
// Seules les cartes ÉLIGIBLES au jeu reçoivent ces 4 champs ; les autres
// (sorts, bâtiments, évolutions, troupes de tour, champions/héros) restent
// sans stats — c'est justement CE critère (présence des 4 champs) qui sert
// de filtre du pool de jeu à l'exécution (backend/services/lajustecarte.js),
// aucun champ "type"/"eligible" séparé à maintenir.
//
// Sources :
//   - Noms FR + rareté : déjà dans data/cardNames.json (jamais retraduits).
//   - Coût d'élixir    : fetchCards() (API officielle Clash Royale) —
//     source retenue pour le jeu, la colonne "Cost" du wiki ne sert qu'en
//     garde-fou de cohérence (avertissement en cas d'écart, jamais stocké).
//   - PV / DPS / Portée : un SEUL appel à l'API MediaWiki de
//     clashroyale.fandom.com (action=parse&page=Cards&prop=wikitext),
//     section "Troops" du wikitext uniquement (repérée par le marqueur de
//     template {{StatisticsSubheader|Troops}} jusqu'au marqueur suivant).
//     Le texte au-dessus de cette table précise explicitement que ces
//     valeurs sont déjà au niveau **Tournament Standard** — aucun calcul de
//     niveau à faire ici.
//
// Filtrage du pool éligible (vérifié empiriquement sur le wikitext du
// 2026-08 — 99 lignes de troupes "de base", 64 retenues) :
//   1. Liens wiki PIPED ([[VraieCarte|NomAffiché]]) ignorés silencieusement :
//      ce sont des sous-unités générées (Bush Goblins, Golemite, Lava Pup,
//      Elixir Blob, Rascal Boy/Girl, etc.), pas des cartes du jeu — la carte
//      réelle a sa propre ligne en lien NON-piped (sauf "Rascals", qui n'a
//      AUCUNE ligne non-piped propre et disparaît donc naturellement).
//   2. rarity === "champion" (8 cartes : Archer Queen, Boss Bandit,
//      Goblinstein, Golden Knight, Little Prince, Mighty Miner, Monk,
//      Skeleton King) exclue — même si mécaniquement listée dans la table
//      Troops, l'énoncé du jeu exclut les héros/champions.
//   3. Valeur "composite" ou variable : si le champ brut PV, DPS ou Portée
//      contient un "/" (mode double, ex. Goblin Gang "202/133"), OU un "-"
//      (dégât progressif/plage min-max, ex. Inferno Dragon "87-1,055" —
//      DPS qui grimpe avec le temps de ciblage, aucune valeur unique fixe
//      représentative), OU si le DPS brut vaut "N/A" (carte sans dégât
//      soutenu, seulement dégât de charge/mort — ex. Battle Ram, les 4
//      Esprits, Skeleton Barrel, Suspicious Bush, Wall Breakers — "N/A"
//      contient d'ailleurs un "/", la même détection générique couvre ce
//      cas aussi sans liste figée à maintenir à la main) → carte exclue,
//      aucune valeur unique représentative fiable pour une comparaison
//      équitable.
//
// Usage : node scripts/generateCardStats.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCards } from "../backend/services/clashApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");

const WIKI_API = "https://clashroyale.fandom.com/api.php";
const RANGE_RANK_BY_MELEE_CATEGORY = { short: 1, medium: 2, long: 3 };

// Même algorithme que generateCardNames.js — comparaison en aveugle,
// insensible casse/ponctuation/espacement, entre le titre de la page wiki
// et le cardKey officiel de data/cardNames.json.
function normalize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function fetchTroopsWikitext() {
  const url = `${WIKI_API}?${new URLSearchParams({ action: "parse", page: "Cards", prop: "wikitext", format: "json" })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wiki API ${res.status} sur ${url}`);
  const data = await res.json();
  const wikitext = data?.parse?.wikitext?.["*"];
  if (!wikitext) throw new Error("Réponse wiki inattendue : wikitext introuvable.");

  const start = wikitext.indexOf("StatisticsSubheader|Troops");
  if (start === -1) throw new Error('Section "Troops" introuvable dans le wikitext de la page Cards.');
  const nextMarker = wikitext.indexOf("StatisticsSubheader|", start + 1);
  return wikitext.slice(start, nextMarker === -1 ? undefined : nextMarker);
}

// Une ligne de tableau wiki : |[[Lien]]||Coût||PV||Dégât||Période||DPS||Dégât spécial||Portée||Nombre
const ROW_PATTERN =
  /\|\[\[([^\]]+)\]\]\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^\n|]*)/g;

function parseLeadingNumber(raw) {
  const match = /^([\d,]+(?:\.\d+)?)/.exec(String(raw).trim());
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

function parseRange(raw) {
  const trimmed = String(raw).trim();
  const meleeMatch = /Melee:\s*(Short|Medium|Long)/i.exec(trimmed);
  if (meleeMatch) {
    const category = meleeMatch[1].toLowerCase();
    return { kind: "melee", category, value: null, rank: RANGE_RANK_BY_MELEE_CATEGORY[category] };
  }
  const value = parseLeadingNumber(trimmed);
  if (value == null) return null;
  return { kind: "ranged", category: null, value, rank: 3 + value };
}

function parseTroopRows(wikitext) {
  const rows = [];
  for (const m of wikitext.matchAll(ROW_PATTERN)) {
    const [, link, cost, hp, , , dps, , range] = m;
    rows.push({ link: link.trim(), rawCost: cost.trim(), rawHp: hp.trim(), rawDps: dps.trim(), rawRange: range.trim() });
  }
  return rows;
}

function hasStats(entry) {
  return entry.elixir != null && entry.hp != null && entry.dps != null && entry.range != null;
}

async function main() {
  console.log("Chargement de data/cardNames.json...");
  const cardNames = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf-8"));
  const byNormalizedCardKey = new Map(cardNames.map((c) => [normalize(c.cardKey), c]));

  console.log("Chargement du catalogue officiel (fetchCards, pour l'élixir)...");
  const officialCards = await fetchCards();
  const elixirByCardKey = new Map(officialCards.map((c) => [c.name, c.elixirCost]));

  console.log("Récupération du wikitext de clashroyale.fandom.com/wiki/Cards (section Troops)...");
  const wikitext = await fetchTroopsWikitext();
  const rows = parseTroopRows(wikitext);
  console.log(`  ${rows.length} ligne(s) de troupe trouvée(s).`);

  const added = [];
  const alreadyPresent = [];
  const excludedPiped = [];
  const excludedChampion = [];
  const excludedComposite = [];
  const excludedNotFound = [];
  const elixirMismatches = [];

  for (const row of rows) {
    if (row.link.includes("|")) {
      excludedPiped.push(row.link);
      continue;
    }

    const entry = byNormalizedCardKey.get(normalize(row.link));
    if (!entry) {
      excludedNotFound.push(row.link);
      continue;
    }

    if (entry.rarity === "champion") {
      excludedChampion.push(entry.cardKey);
      continue;
    }

    if (hasStats(entry)) {
      alreadyPresent.push(entry.cardKey);
      continue;
    }

    const isComposite = [row.rawHp, row.rawDps, row.rawRange].some((raw) => raw.includes("/") || raw.includes("-"));
    if (isComposite) {
      excludedComposite.push({ cardKey: entry.cardKey, hp: row.rawHp, dps: row.rawDps, range: row.rawRange });
      continue;
    }

    const hp = parseLeadingNumber(row.rawHp);
    const dps = parseLeadingNumber(row.rawDps);
    const range = parseRange(row.rawRange);
    if (hp == null || dps == null || !range) {
      console.warn(`  ⚠️  "${entry.cardKey}" : stats illisibles (hp="${row.rawHp}" dps="${row.rawDps}" range="${row.rawRange}") — carte ignorée.`);
      continue;
    }

    const elixir = elixirByCardKey.get(entry.cardKey);
    if (elixir == null) {
      console.warn(`  ⚠️  "${entry.cardKey}" absent du catalogue officiel (fetchCards) — carte ignorée.`);
      continue;
    }
    const wikiCost = parseLeadingNumber(row.rawCost);
    if (wikiCost != null && wikiCost !== elixir) {
      elixirMismatches.push({ cardKey: entry.cardKey, official: elixir, wiki: wikiCost });
    }

    entry.elixir = elixir;
    entry.hp = hp;
    entry.dps = dps;
    entry.range = range;
    added.push(entry.cardKey);
  }

  if (added.length === 0) {
    console.log("");
    console.log("Aucune carte à compléter — data/cardNames.json a déjà des stats pour toutes les cartes éligibles trouvées.");
  } else {
    await fs.writeFile(CARD_NAMES_PATH, `${JSON.stringify(cardNames, null, 2)}\n`);
    console.log("");
    console.log(`Écrit : ${CARD_NAMES_PATH} — stats ajoutées pour ${added.length} carte(s) : ${added.join(", ")}`);
  }

  console.log(`  Déjà présentes (non modifiées) : ${alreadyPresent.length}`);
  console.log(`  Ignorées — liens vers des sous-unités : ${excludedPiped.length} (${excludedPiped.join(", ") || "aucune"})`);
  console.log(`  Exclues — champions/héros : ${excludedChampion.length} (${excludedChampion.join(", ") || "aucune"})`);
  console.log(`  Exclues — stats composites, variables ou sans DPS soutenu : ${excludedComposite.length}`);
  for (const c of excludedComposite) {
    console.log(`    - ${c.cardKey} (hp="${c.hp}" dps="${c.dps}" range="${c.range}")`);
  }
  if (excludedNotFound.length > 0) {
    console.log(`  ⚠️  Introuvables dans data/cardNames.json : ${excludedNotFound.join(", ")} — vérifier si le fichier est à jour.`);
  }
  if (elixirMismatches.length > 0) {
    console.log(`  ⚠️  Écarts élixir (API officielle vs wiki, informatif) :`);
    for (const m of elixirMismatches) {
      console.log(`    - ${m.cardKey} : API=${m.official} wiki=${m.wiki}`);
    }
  }
  console.log("  Toute valeur ajoutée ici est une proposition à relire, pas une certitude.");
}

main().catch((err) => {
  console.error("Échec de l'enrichissement des stats de cardNames.json :", err.message);
  process.exit(1);
});
