#!/usr/bin/env node
// generateZoomCatalog.js
// Génère (ou met à jour) data/zoom/zoom.json et télécharge les icônes de
// cartes dans data/zoom/images/ — usage PONCTUEL, hors flux hebdomadaire de
// publication (contrairement à postZoom.js). But : éviter toute requête
// réseau au moment de servir une manche (voir backend/services/zoomImage.js,
// qui lit uniquement des fichiers locaux).
//
// Source des cartes : les cardKey présents dans data/anagrams/anagrams.json
// (même pool que le jeu Anagram, décision explicite — pas encore étendu aux
// 122 cartes du jeu). Les noms français, eux, viennent de
// data/cardNames.json (source de vérité partagée entre tous les mini-jeux,
// voir scripts/generateCardNames.js) — PAS d'anagrams.json directement, pour
// ne pas dupliquer une donnée qui peut être corrigée à un seul endroit.
//
// Source des icônes :
//   - base    : fetchCards() (catalogue générique Clash Royale, universel).
//   - évolution/héros : fetchPlayer(REFERENCE_PLAYER_TAG) — ces variantes ne
//     sont exposées par l'API QUE sur les cartes qu'un joueur a personnellement
//     évoluées (evolutionLevel > 0 / >= 2), ce n'est PAS une métadonnée
//     statique par carte. Le tag ci-dessous a été vérifié manuellement.
//
// Idempotent : ne re-télécharge une icône que si son URL source a changé ou
// si le fichier local est absent — mais le nom français (answer/accept) est
// TOUJOURS resynchronisé depuis cardNames.json, même sans retéléchargement
// (coût nul, pas de requête réseau). Les champs focal/zoomStages ajoutés à
// la main après une passe de QA visuelle sont préservés tels quels.
//
// Purge : toute entrée dont le cardKey n'est plus dans le pool source
// (ex. une carte retirée d'anagrams.json) est supprimée du catalogue ainsi
// que son fichier image — sûr tant que Zoom carte n'est pas encore en
// production (aucune manche déjà postée ne référence ces id).
//
// Usage :
//   node scripts/generateZoomCatalog.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCards, fetchPlayer } from "../backend/services/clashApi.js";
import { countEvolved, countHeroes } from "../backend/services/collectionConstants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANAGRAMS_JSON_PATH = path.resolve(__dirname, "..", "data", "anagrams", "anagrams.json");
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");
const ZOOM_DIR = path.resolve(__dirname, "..", "data", "zoom");
const ZOOM_JSON_PATH = path.join(ZOOM_DIR, "zoom.json");
const ZOOM_IMAGES_DIR = path.join(ZOOM_DIR, "images");

const REFERENCE_PLAYER_TAG = "#YRGJGR8R";

function slugifyCardKey(cardKey) {
  return String(cardKey)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// PNG : signature fixe (8 octets) puis chunk IHDR dont les 4 premiers octets
// de data sont la largeur et les 4 suivants la hauteur (spec PNG, offsets
// fixes) — évite d'ajouter une dépendance juste pour lire des dimensions.
function readPngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function downloadBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en téléchargeant ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadExistingCatalog() {
  try {
    const txt = await fs.readFile(ZOOM_JSON_PATH, "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function main() {
  const anagrams = JSON.parse(await fs.readFile(ANAGRAMS_JSON_PATH, "utf-8"));
  const cardNames = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf-8"));
  const frByCardKey = new Map(cardNames.map((c) => [c.cardKey, c.fr]));

  // Le pool de cartes = les cardKey uniques d'anagrams.json ; le NOM, lui,
  // vient toujours de cardNames.json (source de vérité), jamais du champ
  // answer/accept d'anagrams.json directement.
  const seedCardKeys = [...new Set(anagrams.map((a) => a.cardKey))];
  console.log(`Cartes sources (cardKey uniques d'anagrams.json) : ${seedCardKeys.length}`);

  const [catalog, referencePlayer] = await Promise.all([
    fetchCards(),
    fetchPlayer(REFERENCE_PLAYER_TAG),
  ]);

  const catalogByName = new Map(catalog.map((c) => [c.name, c]));
  const playerCardsByName = new Map((referencePlayer.cards || []).map((c) => [c.name, c]));

  const existingCatalog = await loadExistingCatalog();
  const existingById = new Map(existingCatalog.map((e) => [e.id, e]));

  await fs.mkdir(ZOOM_IMAGES_DIR, { recursive: true });

  const nextCatalog = [];
  const keptIds = new Set();
  let written = 0;
  let unchanged = 0;
  let skipped = 0;

  async function upsertEntry({ cardKey, variant, sourceUrl }) {
    const fr = frByCardKey.get(cardKey);
    if (!fr) {
      console.warn(`  ⚠️  "${cardKey}" absent de data/cardNames.json (pas de nom français) — variante ignorée.`);
      skipped += 1;
      return;
    }
    const id = `${slugifyCardKey(cardKey)}-${variant}`;
    const filename = `${id}.png`;
    const existing = existingById.get(id);
    keptIds.add(id);

    // Le nom (answer/accept) est TOUJOURS resynchronisé depuis cardNames.json,
    // même quand l'image ne change pas — coût nul, pas de requête réseau.
    const accept = [fr];

    if (existing && existing.sourceUrl === sourceUrl) {
      nextCatalog.push({ ...existing, answer: fr, accept });
      unchanged += 1;
      return;
    }

    let buffer;
    try {
      buffer = await downloadBytes(sourceUrl);
    } catch (err) {
      console.error(`  ⚠️  ${id} : échec du téléchargement (${err.message}) — entrée ignorée.`);
      skipped += 1;
      return;
    }

    await fs.writeFile(path.join(ZOOM_IMAGES_DIR, filename), buffer);
    const { width, height } = readPngDimensions(buffer);

    nextCatalog.push({
      ...(existing?.focal ? { focal: existing.focal } : {}),
      ...(existing?.zoomStages ? { zoomStages: existing.zoomStages } : {}),
      id,
      cardKey,
      variant,
      answer: fr,
      accept,
      image: filename,
      width,
      height,
      sourceUrl,
      fetchedAt: new Date().toISOString(),
    });
    written += 1;
  }

  for (const cardKey of seedCardKeys) {
    const base = catalogByName.get(cardKey);
    if (!base?.iconUrls?.medium) {
      console.warn(`  ⚠️  "${cardKey}" absent du catalogue générique — carte ignorée entièrement.`);
      skipped += 1;
      continue;
    }
    await upsertEntry({ cardKey, variant: "base", sourceUrl: base.iconUrls.medium });

    const playerCard = playerCardsByName.get(cardKey);
    if (!playerCard) continue;

    if (countEvolved([playerCard]) > 0 && playerCard.iconUrls?.evolutionMedium) {
      await upsertEntry({ cardKey, variant: "evolution", sourceUrl: playerCard.iconUrls.evolutionMedium });
    }

    if (countHeroes([playerCard]) > 0 && playerCard.iconUrls?.heroMedium) {
      await upsertEntry({ cardKey, variant: "hero", sourceUrl: playerCard.iconUrls.heroMedium });
    }
  }

  // Purge : toute entrée existante dont le cardKey n'est plus dans le pool
  // source (ex. carte retirée d'anagrams.json) est supprimée, fichier image
  // compris — sûr tant qu'aucune manche Zoom n'a encore été postée.
  const pruned = existingCatalog.filter((e) => !keptIds.has(e.id));
  for (const entry of pruned) {
    await fs.rm(path.join(ZOOM_IMAGES_DIR, entry.image), { force: true });
    console.log(`  🗑️  ${entry.id} retiré (cardKey "${entry.cardKey}" plus dans le pool source).`);
  }

  nextCatalog.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(ZOOM_JSON_PATH, `${JSON.stringify(nextCatalog, null, 2)}\n`);

  const byVariant = nextCatalog.reduce((acc, e) => {
    acc[e.variant] = (acc[e.variant] || 0) + 1;
    return acc;
  }, {});

  console.log("");
  console.log(`Catalogue écrit : ${ZOOM_JSON_PATH}`);
  console.log(
    `  base=${byVariant.base || 0} évolution=${byVariant.evolution || 0} héros=${byVariant.hero || 0} (total ${nextCatalog.length})`,
  );
  console.log(`  ${written} téléchargées, ${unchanged} inchangées (nom resynchronisé), ${pruned.length} retirées, ${skipped} ignorées.`);
}

main().catch((err) => {
  console.error("Échec de la génération du catalogue Zoom :", err.message);
  process.exit(1);
});
