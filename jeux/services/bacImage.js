// ============================================================
// bacImage.js — Illustration du Petit Bac (message public de fin de
// partie), servie telle quelle depuis Vercel Blob (même principe que
// l'illustration de Meow). Source versionnée :
// jeux/data/bac/images/bac-game.webp ; après modification :
// `npm run assets:upload-blob -- bac`.
// ============================================================

import { readBlobAsset } from "@clash/commun/blobAssets.js";

const ILLUSTRATION_IMAGE_PATH = "bac/images/bac-game.webp";

let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
