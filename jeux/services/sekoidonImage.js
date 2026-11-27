// ============================================================
// sekoidonImage.js — Photo d'une manche "Sékoidon" : le JPEG de l'objet,
// servi tel quel. Lu depuis Vercel Blob (voir blobAssets.js et
// scripts/uploadImageAssetsToBlob.js), jamais depuis data/ au runtime.
// Anti-spoiler : rien n'est servi pour une manche jamais postée.
// ============================================================

import { loadTriviaCatalog, resolveTriviaEntry, isGamePosted } from "./sekoidon.js";
import { readBlobAsset } from "@clash/commun/blobAssets.js";

const SEKOIDON_IMAGES_DIR = "jeux-visuels/sekoidon/images";

export async function getSekoidonImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = resolveTriviaEntry(await loadTriviaCatalog(), gameId);
  if (!entry) return null;
  const buffer = await readBlobAsset(`${SEKOIDON_IMAGES_DIR}/${entry.image}`);
  return { buffer, mimeType: "image/jpeg" };
}
