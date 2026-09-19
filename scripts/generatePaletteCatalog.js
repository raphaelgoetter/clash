#!/usr/bin/env node
// generatePaletteCatalog.js
// Génère (ou met à jour) data/palette/palette.json et télécharge les
// images de cartes dans data/palette/images/ pour le mini-jeu "Palette"
// (à terme en rotation une saison sur deux avec Zoom carte) — usage
// PONCTUEL, sur le modèle de scripts/generateZoomCatalog.js.
//
// Pour chaque carte, calcule ses 4 couleurs dominantes (backend/services/
// dominantColor.js) et marque la carte "playable" ou non (trop facile /
// trop monochrome — voir ce module pour le détail des critères).
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
import { extractDominantColors } from "../backend/services/dominantColor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");
const PALETTE_DIR = path.resolve(__dirname, "..", "data", "palette");
const PALETTE_JSON_PATH = path.join(PALETTE_DIR, "palette.json");
const PALETTE_IMAGES_DIR = path.join(PALETTE_DIR, "images");

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

async function main() {
  const cardNames = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf-8"));
  const catalog = await fetchCards();
  const catalogByName = new Map(catalog.map((c) => [c.name, c]));

  const existingCatalog = await loadExistingCatalog();
  const existingById = new Map(existingCatalog.map((e) => [e.id, e]));

  await fs.mkdir(PALETTE_IMAGES_DIR, { recursive: true });

  const nextCatalog = [];
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

    const extraction = extractDominantColors(buffer);
    if (!extraction) {
      console.warn(`  ⚠️  ${id} : pas assez de pixels exploitables — carte ignorée.`);
      skipped += 1;
      continue;
    }

    const { width, height } = PNG.sync.read(buffer);
    const { colors, isTooEasy, isMonochrome } = extraction;

    nextCatalog.push({
      id,
      cardKey,
      rarity,
      fr,
      image: filename,
      width,
      height,
      sourceUrl,
      fetchedAt: existing?.sourceUrl === sourceUrl ? existing.fetchedAt : new Date().toISOString(),
      colors,
      correctHex: colors[0].hex,
      playable: !isTooEasy && !isMonochrome,
      excludedReason: isTooEasy ? "top1>60%" : isMonochrome ? "monochrome" : null,
    });
  }

  // Purge : toute entrée existante dont le cardKey n'est plus dans
  // cardNames.json est supprimée du catalogue ainsi que son fichier image.
  const pruned = existingCatalog.filter((e) => !keptIds.has(e.id));
  for (const entry of pruned) {
    await fs.rm(path.join(PALETTE_IMAGES_DIR, entry.image), { force: true });
    console.log(`  🗑️  ${entry.id} retiré (cardKey "${entry.cardKey}" plus dans cardNames.json).`);
  }

  await fs.writeFile(PALETTE_JSON_PATH, `${JSON.stringify(nextCatalog, null, 2)}\n`);

  const playableCount = nextCatalog.filter((e) => e.playable).length;
  const tooEasyCount = nextCatalog.filter((e) => e.excludedReason === "top1>60%").length;
  const monochromeCount = nextCatalog.filter((e) => e.excludedReason === "monochrome").length;

  console.log("");
  console.log(`Catalogue écrit : ${PALETTE_JSON_PATH}`);
  console.log(`  ${nextCatalog.length} cartes au total, dont ${playableCount} jouables.`);
  console.log(`  Exclues : ${tooEasyCount} trop faciles, ${monochromeCount} trop monochromes.`);
  console.log(`  ${downloaded} téléchargées, ${unchanged} réutilisées, ${pruned.length} retirées, ${skipped} ignorées.`);
}

main().catch((err) => {
  console.error("Échec de la génération du catalogue Palette :", err.message);
  process.exit(1);
});
