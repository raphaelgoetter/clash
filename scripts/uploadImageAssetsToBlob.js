#!/usr/bin/env node
// uploadImageAssetsToBlob.js — Migration ponctuelle des assets binaires
// (images de rendu resvg, police embarquée) de data/ vers Vercel Blob.
//
// Pourquoi : une Vercel Function n'a aucun accès au dépôt Git au runtime,
// seulement aux fichiers tracés dans son bundle au build (@vercel/nft). Les
// lectures dynamiques (fs.readFile avec un nom de fichier venu d'un
// catalogue JSON, comme dans paletteImage.js/zoomImage.js) forcent le
// traceur à embarquer le RÉPERTOIRE ENTIER, pas juste le fichier réellement
// utilisé — data/jeux-visuels/ (Palette + Zoom) pèse à lui seul 38 Mo,
// réembarqués à CHAQUE déploiement retenu (30j vivant + 30j de récupération
// après suppression). Cause principale du dépassement de Functions Storage
// (voir mémoire projet, sept. 2026). Ces fichiers restent versionnés dans
// Git (source de vérité, regénérables via generatePaletteCatalog.js /
// generateZoomCatalog.js) — Blob n'est qu'une copie servie au runtime.
//
// Access "private" (comme championPredictions.js) : pas juste une
// convention, une NÉCESSITÉ pour Palette/Zoom — ces images sont
// anti-spoiler (la carte de la manche en cours ne doit pas être devinable
// via une URL publique avant sa résolution).
//
// Idempotent : addRandomSuffix=false + allowOverwrite=true, donc relançable
// sans créer de doublons — à refaire après chaque régénération de catalogue
// (nouvelle carte Palette/Zoom, changement de police, etc.).
//
// Usage : npm run assets:upload-blob
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { put } from "@vercel/blob";

dotenv.config({ path: "./.env" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const CONTENT_TYPES = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Chaque entrée : un fichier précis, ou un dossier entier (tous ses
// fichiers directs, non récursif — suffisant ici).
const TARGETS = [
  { file: "fonts/Inter-Bold.ttf" },
  { file: "goblinhunters/images/board.jpg" },
  { file: "goblinhunters/images/end.webp" },
  { file: "goblinhunters/images/start.webp" },
  { file: "marioclash/images/mario-clash-board.jpg" },
  { file: "marioclash/images/mario-clash.webp" },
  { dir: "jeux-visuels/palette/images" },
  { dir: "jeux-visuels/palette/highlights" },
  { dir: "jeux-visuels/zoom/images" },
];

async function collectFiles() {
  const relPaths = [];
  for (const target of TARGETS) {
    if (target.file) {
      relPaths.push(target.file);
      continue;
    }
    const abs = path.join(DATA_DIR, target.dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) relPaths.push(path.join(target.dir, entry.name));
    }
  }
  return relPaths;
}

async function uploadOne(relPath, token) {
  const absPath = path.join(DATA_DIR, relPath);
  const buffer = await fs.readFile(absPath);
  const ext = path.extname(relPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  const blob = await put(relPath, buffer, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000, // 1 an — ces assets ne changent qu'en re-runnant ce script
    token,
  });
  return blob;
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error("BLOB_READ_WRITE_TOKEN manquant dans .env — abandon.");
    process.exit(1);
  }

  const relPaths = await collectFiles();
  console.log(`${relPaths.length} fichiers à uploader vers Blob (private)...`);

  let ok = 0;
  let failed = 0;
  let totalBytes = 0;
  for (const relPath of relPaths) {
    try {
      const blob = await uploadOne(relPath, token);
      totalBytes += (await fs.stat(path.join(DATA_DIR, relPath))).size;
      ok++;
      if (ok % 25 === 0 || ok === relPaths.length) {
        console.log(`  ${ok}/${relPaths.length}...`);
      }
    } catch (err) {
      failed++;
      console.error(`  ÉCHEC ${relPath}: ${err.message}`);
    }
  }

  console.log(`\nTerminé : ${ok} uploadés, ${failed} échecs, ${(totalBytes / 1024 / 1024).toFixed(1)} Mo.`);
  if (failed > 0) process.exit(1);
}

main();
