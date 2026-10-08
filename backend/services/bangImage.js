// ============================================================
// bangImage.js — Images de Bang! :
//   - la main d'un joueur : cartes posées en grille sur le tapis de jeu
//     (data/bang/images/bang-table.jpg), regroupées avec un badge « ×N »
//     pour les exemplaires d'une même carte ;
//   - l'illustration statique (message officiel).
// Même technique que marioclashImage.js : SVG avec un `<image href="data:...">`
// de fond, rastérisé en PNG via @resvg/resvg-js. Dessin des cartes
// (illustration officielle) partagé via cardImage.js, sans goutte d'élixir
// (l'Élixir de Bang! est une ressource du jeu, pas le coût de la carte).
//
// ⚠️ Tapis en JPEG, jamais en WebP : resvg ne décode pas le WebP embarqué et
// échoue SILENCIEUSEMENT (fond absent) — voir marioclashImage.js.
// `bang-table.webp` (asset original) reste dans data/ pour archive.
//
// Assets servis depuis Vercel Blob (voir blobAssets.js), data/ n'est pas lu
// au runtime : relancer `npm run assets:upload-blob -- bang` après modification.
// ============================================================

import { readBlobAsset } from "./blobAssets.js";
import { cardSvg, loadDataUrls, rasterize, RATIO_CARTE } from "./cardImage.js";
import { CARTES } from "./bangRules.js";

const MAT_IMAGE_PATH = "bang/images/bang-table.jpg";
const ILLUSTRATION_IMAGE_PATH = "bang/images/bang-launch.webp";

// Dimensions natives de bang-table.jpg et zone intérieure du tapis (bleu,
// hors cadre doré) — à recalibrer si l'asset change.
const MAT_WIDTH = 1200;
const MAT_HEIGHT = 658;
const ZONE = { x: 120, y: 85, w: 960, h: 470 };
const RATIO = RATIO_CARTE;
const GAP = 18;
const MAX_CARD_WIDTH = 150;
const FONT_FAMILY = "Inter";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let matDataUrl = null;

async function loadMatDataUrl() {
  if (!matDataUrl) {
    const buffer = await readBlobAsset(MAT_IMAGE_PATH);
    matDataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }
  return matDataUrl;
}

// Grille qui maximise la largeur des cartes dans la zone du tapis.
function layoutGrid(count) {
  let best = null;
  for (let rows = 1; rows <= Math.max(1, count); rows++) {
    const cols = Math.ceil(count / rows);
    const w = Math.min(MAX_CARD_WIDTH, (ZONE.w - (cols - 1) * GAP) / cols, (ZONE.h - (rows - 1) * GAP) / rows / RATIO);
    if (!best || w > best.w) best = { rows, cols, w };
  }
  return best;
}

function badgeSvg(x, y, texte) {
  return `
  <circle cx="${x}" cy="${y}" r="17" fill="#f0c040" stroke="#4a2c00" stroke-width="3"/>
  <text x="${x}" y="${y + 6}" font-family="${FONT_FAMILY}" font-size="17" text-anchor="middle" fill="#2b1a00">${escapeXml(texte)}</text>`;
}

// Regroupe les exemplaires (ordre de CARTES, stable d'une vue à l'autre).
function grouper(ids) {
  return Object.keys(CARTES)
    .map((id) => ({ id, count: ids.filter((x) => x === id).length }))
    .filter((e) => e.count > 0);
}

async function buildMainSvg(ids) {
  const mat = await loadMatDataUrl();
  const entrees = grouper(ids).map((e) => ({ ...e, card: { key: CARTES[e.id].cardKey } }));
  const parts = [];
  if (!entrees.length) {
    parts.push(
      `<text x="${MAT_WIDTH / 2}" y="${MAT_HEIGHT / 2 + 12}" font-family="${FONT_FAMILY}" font-size="34" text-anchor="middle" fill="#ffffff" opacity="0.85">Aucune carte en main</text>`,
    );
  } else {
    const { rows, cols, w } = layoutGrid(entrees.length);
    const size = { w, gap: GAP, drop: 0 };
    const h = w * RATIO;
    const dataUrls = await loadDataUrls(entrees.map((e) => e.card));
    const gridH = rows * h + (rows - 1) * GAP;
    const y0 = ZONE.y + (ZONE.h - gridH) / 2;
    entrees.forEach((e, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, entrees.length - row * cols);
      const rowW = inRow * w + (inRow - 1) * GAP;
      const x = ZONE.x + (ZONE.w - rowW) / 2 + (i % cols) * (w + GAP);
      const y = y0 + row * (h + GAP);
      parts.push(cardSvg(e.card, dataUrls.get(e.card.key), x, y, size));
      if (e.count > 1) parts.push(badgeSvg(x + w - 6, y + h - 6, `×${e.count}`));
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${MAT_WIDTH}" height="${MAT_HEIGHT}" viewBox="0 0 ${MAT_WIDTH} ${MAT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <image x="0" y="0" width="${MAT_WIDTH}" height="${MAT_HEIGHT}" href="${mat}"/>
  ${parts.join("\n")}
</svg>`;
}

// Main d'un joueur : identifiants de cartes Bang! passés dans l'URL (les
// inconnus sont ignorés), rendu sans état.
export async function getMainImage(ids) {
  const valides = ids.filter((id) => CARTES[id]).slice(0, 60);
  return { buffer: await rasterize(await buildMainSvg(valides), MAT_WIDTH), mimeType: "image/png" };
}

let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
