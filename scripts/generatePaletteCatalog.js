#!/usr/bin/env node
// generatePaletteCatalog.js
// Génère (ou met à jour) data/palette/palette.json et télécharge les
// images de cartes dans data/palette/images/ pour le mini-jeu "Palette"
// (à terme en rotation une saison sur deux avec Zoom carte) — usage
// PONCTUEL, sur le modèle de scripts/generateZoomCatalog.js.
//
// Pour chaque carte, calcule ses 4 couleurs dominantes (backend/services/
// dominantColor.js) et marque la carte "playable" ou non (trop facile /
// trop monochrome — voir ce module pour le détail des critères). Le cadre
// décoratif de rareté (partagé par toutes les cartes, voir buildFrameMask
// dans dominantColor.js) est détecté et exclu avant l'extraction. Génère
// aussi, dans data/palette/highlights/, une image "preuve" par carte (la
// carte avec un voile de la couleur dominante posé sur les pixels qui la
// composent) à afficher au joueur au moment du résultat, pour justifier
// visuellement la réponse plutôt que de ne donner qu'un pourcentage.
//
// data/palette/manualOverrides.json : décisions manuelles de Raphael après
// une passe de QA visuelle sur le pool "jouable" (des cartes automatiquement
// jouables mais dont le résultat semblait faux à l'œil, et inversement) —
// appliquées à CHAQUE régénération, en dernier, après le calcul automatique.
//
// Source des cartes : data/cardNames.json (les 123 cartes, source de
// vérité partagée entre tous les mini-jeux — contrairement à Zoom qui ne
// couvre que le sous-pool d'anagrams.json, ici on prend tout le catalogue).
//
// Source des icônes : fetchCards() (catalogue générique Clash Royale),
// variante "base" uniquement — pas d'évolution/héros pour ce jeu.
//
// Idempotent : l'image n'est retéléchargée que si son URL source a changé
// ou si le fichier local est absent, mais les couleurs dominantes sont
// TOUJOURS recalculées depuis le fichier local (coût nul, pas de requête
// réseau) — permet d'affiner l'algo dans dominantColor.js sans réseau.
//
// Usage :
//   node scripts/generatePaletteCatalog.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { fetchCards } from "../backend/services/clashApi.js";
import { extractDominantColors, buildFrameMask, buildHighlightOverlay } from "../backend/services/dominantColor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");
const PALETTE_DIR = path.resolve(__dirname, "..", "data", "jeux-visuels", "palette");
const PALETTE_JSON_PATH = path.join(PALETTE_DIR, "palette.json");
const PALETTE_IMAGES_DIR = path.join(PALETTE_DIR, "images");
const PALETTE_HIGHLIGHTS_DIR = path.join(PALETTE_DIR, "highlights");
const MANUAL_OVERRIDES_PATH = path.join(PALETTE_DIR, "manualOverrides.json");

function slugifyCardKey(cardKey) {
  return String(cardKey)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function downloadBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en téléchargeant ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadExistingCatalog() {
  try {
    const txt = await fs.readFile(PALETTE_JSON_PATH, "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function loadManualOverrides() {
  try {
    const txt = await fs.readFile(MANUAL_OVERRIDES_PATH, "utf-8");
    const { forcePlayable = [], forceExcluded = [] } = JSON.parse(txt);
    return { forcePlayable: new Set(forcePlayable), forceExcluded: new Set(forceExcluded) };
  } catch {
    return { forcePlayable: new Set(), forceExcluded: new Set() };
  }
}

async function main() {
  const cardNames = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf-8"));
  const catalog = await fetchCards();
  const catalogByName = new Map(catalog.map((c) => [c.name, c]));

  const existingCatalog = await loadExistingCatalog();
  const existingById = new Map(existingCatalog.map((e) => [e.id, e]));
  const manualOverrides = await loadManualOverrides();

  await fs.mkdir(PALETTE_IMAGES_DIR, { recursive: true });
  await fs.mkdir(PALETTE_HIGHLIGHTS_DIR, { recursive: true });

  // Phase 1 : résoudre et télécharger (ou réutiliser) l'image de chaque carte,
  // sans encore calculer ses couleurs — il faut d'abord regrouper les buffers
  // par rareté pour construire le masque de cadre (voir phase 2).
  const resolved = [];
  const keptIds = new Set();
  let downloaded = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const { cardKey, rarity, fr } of cardNames) {
    const base = catalogByName.get(cardKey);
    if (!base?.iconUrls?.medium) {
      console.warn(`  ⚠️  "${cardKey}" absent du catalogue générique — carte ignorée.`);
      skipped += 1;
      continue;
    }

    const id = slugifyCardKey(cardKey);
    const filename = `${id}.png`;
    const filePath = path.join(PALETTE_IMAGES_DIR, filename);
    const sourceUrl = base.iconUrls.medium;
    const existing = existingById.get(id);
    keptIds.add(id);

    let buffer;
    if (existing?.sourceUrl === sourceUrl) {
      try {
        buffer = await fs.readFile(filePath);
        unchanged += 1;
      } catch {
        buffer = null; // fichier local manquant malgré une entrée existante : on retélécharge
      }
    }

    if (!buffer) {
      try {
        buffer = await downloadBytes(sourceUrl);
        await fs.writeFile(filePath, buffer);
        downloaded += 1;
      } catch (err) {
        console.error(`  ⚠️  ${id} : échec du téléchargement (${err.message}) — carte ignorée.`);
        skipped += 1;
        continue;
      }
    }

    resolved.push({
      id,
      cardKey,
      rarity,
      fr,
      filename,
      sourceUrl,
      buffer,
      fetchedAt: existing?.sourceUrl === sourceUrl ? existing.fetchedAt : new Date().toISOString(),
    });
  }

  // Phase 2 : un cadre partagé par rareté (voir dominantColor.js) — construit
  // par comparaison de toutes les cartes de cette rareté entre elles.
  const buffersByRarity = new Map();
  for (const card of resolved) {
    const list = buffersByRarity.get(card.rarity) ?? [];
    list.push(card.buffer);
    buffersByRarity.set(card.rarity, list);
  }
  const frameMaskByRarity = new Map();
  for (const [rarity, buffers] of buffersByRarity) {
    frameMaskByRarity.set(rarity, buildFrameMask(buffers));
  }

  // Phase 3 : extraction des couleurs dominantes, cadre exclu.
  const nextCatalog = [];
  for (const card of resolved) {
    const extraction = extractDominantColors(card.buffer, { frameMask: frameMaskByRarity.get(card.rarity) });
    if (!extraction) {
      console.warn(`  ⚠️  ${card.id} : pas assez de pixels exploitables — carte ignorée.`);
      skipped += 1;
      continue;
    }

    const { width, height } = PNG.sync.read(card.buffer);
    const { colors, isTooEasy, isMonochrome, pixelColorIndex } = extraction;

    // Image "preuve" : la carte avec un voile semi-transparent de la couleur
    // dominante posé sur les pixels qui la composent — affichée au joueur au
    // moment du résultat pour justifier visuellement la bonne réponse (voir
    // buildHighlightOverlay dans dominantColor.js).
    const highlightFilename = `${card.id}.png`;
    const highlightBuffer = buildHighlightOverlay(card.buffer, pixelColorIndex, 0, colors[0].hex);
    await fs.writeFile(path.join(PALETTE_HIGHLIGHTS_DIR, highlightFilename), highlightBuffer);

    // Décisions manuelles de Raphael (voir data/palette/manualOverrides.json)
    // : appliquées APRÈS le calcul automatique, qu'elles le confirment ou le
    // contredisent — une passe de QA visuelle sur l'image prime sur l'heuristique.
    let playable = !isTooEasy && !isMonochrome;
    let excludedReason = isTooEasy ? "top1>60%" : isMonochrome ? "monochrome" : null;
    if (manualOverrides.forcePlayable.has(card.id)) {
      playable = true;
      excludedReason = null;
    } else if (manualOverrides.forceExcluded.has(card.id)) {
      playable = false;
      excludedReason = "manual";
    }

    nextCatalog.push({
      id: card.id,
      cardKey: card.cardKey,
      rarity: card.rarity,
      fr: card.fr,
      image: card.filename,
      highlightImage: highlightFilename,
      width,
      height,
      sourceUrl: card.sourceUrl,
      fetchedAt: card.fetchedAt,
      colors,
      correctHex: colors[0].hex,
      playable,
      excludedReason,
    });
  }

  // Purge : toute entrée existante dont le cardKey n'est plus dans
  // cardNames.json est supprimée du catalogue ainsi que son fichier image.
  const pruned = existingCatalog.filter((e) => !keptIds.has(e.id));
  for (const entry of pruned) {
    await fs.rm(path.join(PALETTE_IMAGES_DIR, entry.image), { force: true });
    if (entry.highlightImage) await fs.rm(path.join(PALETTE_HIGHLIGHTS_DIR, entry.highlightImage), { force: true });
    console.log(`  🗑️  ${entry.id} retiré (cardKey "${entry.cardKey}" plus dans cardNames.json).`);
  }

  await fs.writeFile(PALETTE_JSON_PATH, `${JSON.stringify(nextCatalog, null, 2)}\n`);

  const playableCount = nextCatalog.filter((e) => e.playable).length;
  const tooEasyCount = nextCatalog.filter((e) => e.excludedReason === "top1>60%").length;
  const monochromeCount = nextCatalog.filter((e) => e.excludedReason === "monochrome").length;
  const manualCount = nextCatalog.filter((e) => e.excludedReason === "manual").length;

  console.log("");
  console.log(`Catalogue écrit : ${PALETTE_JSON_PATH}`);
  console.log(`  ${nextCatalog.length} cartes au total, dont ${playableCount} jouables.`);
  console.log(`  Exclues : ${tooEasyCount} trop faciles, ${monochromeCount} trop monochromes, ${manualCount} manuellement.`);
  console.log(`  ${downloaded} téléchargées, ${unchanged} réutilisées, ${pruned.length} retirées, ${skipped} ignorées.`);
  console.log(`  Overrides manuels : ${manualOverrides.forcePlayable.size} forcées jouables, ${manualOverrides.forceExcluded.size} forcées exclues.`);
}

main().catch((err) => {
  console.error("Échec de la génération du catalogue Palette :", err.message);
  process.exit(1);
});
