#!/usr/bin/env node
// generateCardNames.js
// Génère data/cardNames.json — la source de vérité anglais↔français des
// noms de cartes Clash Royale, partagée par tous les mini-jeux (Anagram,
// Zoom carte, et tout jeu futur ayant besoin du nom français d'une carte).
// Usage PONCTUEL, jamais dans un flux hebdomadaire.
//
// data/cardNames.json est un fichier ÉDITÉ À LA MAIN une fois généré : ce
// script ne le régénère jamais entièrement depuis zéro. Il ne fait que
// COMPLÉTER les cartes absentes du fichier existant (typiquement une
// nouvelle carte ajoutée au jeu) — toute entrée déjà présente est conservée
// telle quelle, y compris si sa valeur a été corrigée à la main depuis. Le
// wiki source (voir ci-dessous) contient des erreurs constatées (ex. "Cage
// gobeline" d'abord mal orthographiée) : une fois qu'un humain a vérifié et
// corrigé une entrée, elle ne doit plus jamais être écrasée automatiquement.
//
// Stratégie de résolution pour une carte absente du fichier existant :
//   1. Wiki Fandom FR (clashroyale.fandom.com/fr) — liens interlangues
//      (langlinks) vers la page anglaise correspondante, dans les deux sens
//      (FR→EN et EN→FR, un sens comble les trous de l'autre : les liens ne
//      sont pas systématiquement posés par les contributeurs dans les deux
//      directions). Comparaison en aveugle : le nom anglais résolu depuis
//      le wiki est normalisé (minuscule, sans ponctuation) puis comparé au
//      nom anglais AUTHENTIQUE renvoyé par l'API Clash Royale
//      (fetchCards()) — jamais l'inverse, le wiki peut se tromper sur la
//      casse/l'orthographe anglaise, l'API ne se trompe jamais sur son
//      propre nom.
//   2. data/anagrams/anagrams.json — pour les cartes trop récentes pour
//      avoir une page sur le wiki FR (constaté : le wiki a un train de
//      retard sur les sorties de cartes), on retombe sur les noms déjà
//      traduits à la main par l'équipe pour Anagram — À VÉRIFIER, ces noms
//      n'ont pas été recoupés avec une source externe.
//   3. Rien trouvé → `fr: null`. À compléter à la main (voir la liste
//      affichée en fin de script).
//
// Toutes les valeurs, quelle que soit leur origine, sont à considérer comme
// une PROPOSITION à relire — voir les cartes ajoutées/modifiées dans le
// résumé de fin d'exécution.
//
// Usage : node scripts/generateCardNames.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCards } from "../backend/services/clashApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");
const ANAGRAMS_JSON_PATH = path.resolve(__dirname, "..", "data", "anagrams", "anagrams.json");

const WIKI_FR = "https://clashroyale.fandom.com/fr";
const WIKI_EN = "https://clashroyale.fandom.com";
const REQUEST_DELAY_MS = 120; // courtoisie envers l'API Fandom, pas de rate-limit connue mais évite le marteau-piqueur

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wikiApi(base, params) {
  const url = `${base}/api.php?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wiki API ${res.status} sur ${url}`);
  return res.json();
}

async function getCategoryMembers(base, category, limit = 500) {
  const data = await wikiApi(base, { action: "query", list: "categorymembers", cmtitle: category, cmlimit: String(limit) });
  return data.query.categorymembers.map((m) => m.title);
}

// Une requête par titre (PAS de batching multi-titres) : constaté empiriquement
// que la pagination interne de l'API MediaWiki pour `prop=langlinks` combinée
// à plusieurs titres en une requête tronque silencieusement les résultats des
// pages autres que la dernière du lot dès qu'une continuation est déclenchée
// — bug de troncature découvert en pratique (ex. "Bourreau" → "Executioner"
// disparaissait en lot alors qu'il existe bel et bien en requête individuelle).
async function getLangLink(base, title, lang) {
  const data = await wikiApi(base, { action: "query", titles: title, prop: "langlinks", lllang: lang });
  const page = Object.values(data.query.pages)[0];
  return page.langlinks?.[0]?.["*"] ?? null;
}

function normalize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function loadExisting() {
  try {
    const txt = await fs.readFile(CARD_NAMES_PATH, "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function main() {
  const existing = await loadExisting();
  const existingByCardKey = new Map(existing.map((e) => [e.cardKey, e]));

  console.log("Chargement du catalogue officiel (fetchCards)...");
  const realCards = await fetchCards();
  console.log(`  ${realCards.length} cartes.`);

  const missingCards = realCards.filter((c) => !existingByCardKey.has(c.name));
  if (missingCards.length === 0) {
    console.log("data/cardNames.json couvre déjà toutes les cartes du catalogue — rien à faire.");
    return;
  }
  console.log(`${missingCards.length} carte(s) absente(s) de data/cardNames.json à résoudre : ${missingCards.map((c) => c.name).join(", ")}`);

  const realByNorm = new Map(missingCards.map((c) => [normalize(c.name), c.name]));

  console.log("Liste des pages du wiki FR (Catégorie:Cartes + Catégorie:Champions)...");
  const META_PAGES = new Set(["Aperçu des cartes", "Calculateur de chance de carte", "Deck Builder", "Decks", "Générateur de decks"]);
  const [frCategoryTitles, frChampionTitles] = await Promise.all([
    getCategoryMembers(WIKI_FR, "Catégorie:Cartes"),
    getCategoryMembers(WIKI_FR, "Catégorie:Champions"),
  ]);
  const frTitles = [...new Set([...frCategoryTitles, ...frChampionTitles])].filter(
    (t) => !t.includes("/") && !t.startsWith("Catégorie:") && !META_PAGES.has(t),
  );
  console.log(`  ${frTitles.length} pages de cartes FR.`);

  console.log("Liste des pages du wiki EN (Category:Cards by Rarity, sous-catégories)...");
  const RARITY_CATEGORIES = ["Category:Champion Cards", "Category:Common Cards", "Category:Epic Cards", "Category:Legendary Cards", "Category:Rare Cards"];
  const enTitlesNested = await Promise.all(RARITY_CATEGORIES.map((c) => getCategoryMembers(WIKI_EN, c, 200)));
  const enTitles = [...new Set(enTitlesNested.flat())].filter((t) => !t.includes("/"));
  console.log(`  ${enTitles.length} pages de cartes EN.`);

  console.log("Résolution FR → EN (langlinks, une requête par page)...");
  const frToEn = {};
  for (const title of frTitles) {
    frToEn[title] = await getLangLink(WIKI_FR, title, "en");
    await sleep(REQUEST_DELAY_MS);
  }

  console.log("Résolution EN → FR (langlinks, une requête par page)...");
  const enToFr = {};
  for (const title of enTitles) {
    enToFr[title] = await getLangLink(WIKI_EN, title, "fr");
    await sleep(REQUEST_DELAY_MS);
  }

  // Fusion : FR→EN d'abord, puis EN→FR comble les trous restants — les deux
  // sens sont vérifiés indépendamment contre le nom officiel avant d'être
  // retenus (aucune confiance aveugle dans le nom anglais lu sur le wiki).
  // Uniquement pour les cartes manquantes du fichier existant.
  const resolved = new Map(); // cardKey officiel -> fr
  for (const [fr, en] of Object.entries(frToEn)) {
    if (!en) continue;
    const real = realByNorm.get(normalize(en));
    if (real && !resolved.has(real)) resolved.set(real, fr);
  }
  for (const [en, fr] of Object.entries(enToFr)) {
    if (!fr) continue;
    const real = realByNorm.get(normalize(en));
    if (real && !resolved.has(real)) resolved.set(real, fr);
  }

  // "Monk" → "Moine" : la page FR existe (clashroyale.fandom.com/fr/wiki/Moine,
  // vérifiée à la main — son infobox contient "Nom de l'image=MonkCard",
  // "Rareté=Champion") mais ne porte aucun lien interlangue et n'est
  // rattachée à aucune des catégories parcourues ci-dessus — trou de
  // catégorisation/liaison côté wiki, pas une absence de contenu.
  if (realByNorm.has(normalize("Monk")) && !resolved.has("Monk")) resolved.set("Monk", "Moine");

  const anagrams = JSON.parse(await fs.readFile(ANAGRAMS_JSON_PATH, "utf-8"));
  const anagramsByCardKey = new Map(anagrams.map((a) => [a.cardKey, a.answer]));

  const added = [];
  for (const c of missingCards) {
    const fr = resolved.get(c.name) ?? anagramsByCardKey.get(c.name) ?? null;
    const entry = { cardKey: c.name, rarity: c.rarity, fr };
    existingByCardKey.set(c.name, entry);
    added.push(entry);
  }

  const merged = [...existingByCardKey.values()].sort((a, b) => a.cardKey.localeCompare(b.cardKey));
  await fs.writeFile(CARD_NAMES_PATH, `${JSON.stringify(merged, null, 2)}\n`);

  console.log("");
  console.log(`Écrit : ${CARD_NAMES_PATH} (${merged.length} cartes au total, ${added.length} ajoutée(s))`);
  const stillMissing = added.filter((e) => e.fr == null).map((e) => e.cardKey);
  if (stillMissing.length > 0) {
    console.log(`  Aucun nom français trouvé pour : ${stillMissing.join(", ")} — à compléter à la main.`);
  }
  console.log("  Toute valeur ajoutée ici est une proposition à relire, pas une certitude.");
}

main().catch((err) => {
  console.error("Échec de la génération de cardNames.json :", err.message);
  process.exit(1);
});
