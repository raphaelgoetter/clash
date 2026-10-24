// ============================================================
// platpaysImage.js — Photo du plat d'une manche "Plat Pays", lue depuis
// Vercel Blob (voir blobAssets.js et scripts/uploadImageAssetsToBlob.js),
// jamais depuis data/ au runtime. Les fichiers portent le gameId (p001.webp)
// et non le nom du plat, et ne sont servis que par /api/platpays/image :
// aucune URL ne trahit la réponse.
// ============================================================

import { resolvePlat, isGamePosted } from "./platpays.js";
import { readBlobAsset } from "@clash/commun/blobAssets.js";

const PLATPAYS_IMAGES_DIR = "jeux-visuels/platpays/images";

const MIME_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

// null si la manche n'a jamais été postée (anti-spoiler) ou n'existe pas.
export async function getPlatImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = await resolvePlat(gameId);
  if (!entry) return null;
  const buffer = await readBlobAsset(`${PLATPAYS_IMAGES_DIR}/${entry.image}`);
  const ext = entry.image.split(".").pop().toLowerCase();
  return { buffer, mimeType: MIME_TYPES[ext] ?? "image/webp" };
}
