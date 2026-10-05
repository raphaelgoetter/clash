// ============================================================
// draftroyaleImage.js — Images du Draft Royale :
//   - le marché : cartes posées en grille sur le tapis de jeu
//     (data/draftroyale/images/draft-game.jpg), regroupées avec un badge
//     « ×N » pour les exemplaires d'une même carte ;
//   - la main d'un joueur : grille de cartes réutilisée du jeu Élixir ;
//   - l'illustration statique (présentation / fin de partie).
// Même technique que marioclashImage.js : SVG avec un `<image href="data:...">`
// de fond, rastérisé en PNG via @resvg/resvg-js. Dessin des cartes (illustration
// officielle + goutte d'élixir) partagé via cardImage.js.
//
// ⚠️ Tapis en JPEG, jamais en WebP : resvg ne décode pas le WebP embarqué et
// échoue SILENCIEUSEMENT (fond absent) — voir marioclashImage.js.
// `draft-game.webp` (asset original) reste dans data/ pour archive.
//
// Assets servis depuis Vercel Blob (voir blobAssets.js), data/ n'est pas lu
// au runtime : relancer `npm run assets:upload-blob` après modification.
// ============================================================

import { readBlobAsset } from "./blobAssets.js";
import { cardSvg, loadDataUrls, rasterize, getCollectionImage, RATIO_CARTE } from "./cardImage.js";
import { resolveCard } from "./cards.js";
import { readPartie, loadCatalog } from "./draftroyale.js";

const MAT_IMAGE_PATH = "draftroyale/images/draft-game.jpg";
const ILLUSTRATION_IMAGE_PATH = "draftroyale/images/draft-launch.webp";
const FONT_FAMILY = "Inter";

// Dimensions natives de draft-game.jpg et zone intérieure du tapis (bleu,
// hors cadre doré) — à recalibrer si l'asset change.
const MAT_WIDTH = 1200;
const MAT_HEIGHT = 658;
const ZONE = { x: 120, y: 85, w: 960, h: 470 };
const RATIO = RATIO_CARTE;
const GAP = 18;
const MAX_CARD_WIDTH = 150;

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
export function layoutGrid(count) {
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

// `entrees` : [{ key, count }] dans l'ordre d'affichage. `mat` : data URL
// du tapis (lue depuis Blob par défaut, injectable pour un rendu local).
export async function buildMarcheSvg(entrees, catalog, mat = null) {
  mat ??= await loadMatDataUrl();
  const cards = entrees.map((e) => ({ ...e, card: resolveCard(e.key, catalog) })).filter((e) => e.card);
  const parts = [];
  if (!cards.length) {
    parts.push(
      `<text x="${MAT_WIDTH / 2}" y="${MAT_HEIGHT / 2 + 12}" font-family="${FONT_FAMILY}" font-size="34" text-anchor="middle" fill="#ffffff" opacity="0.85">Aucune carte au marché</text>`,
    );
  } else {
    const { rows, cols, w } = layoutGrid(cards.length);
    const size = { w, gap: GAP, drop: Math.round(w * 0.3) };
    const h = w * RATIO;
    const dataUrls = await loadDataUrls(cards.map((e) => e.card));
    const gridH = rows * h + (rows - 1) * GAP;
    const y0 = ZONE.y + (ZONE.h - gridH) / 2;
    cards.forEach((e, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, cards.length - row * cols);
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

// Regroupe les exemplaires par carte (ordre alphabétique des clés, pour
// une image stable d'un jour à l'autre).
export function groupMarche(keys) {
  const counts = new Map();
  for (const k of [...keys].sort()) counts.set(k, (counts.get(k) || 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

// Marché courant du Draft Royale.
export async function getMarcheImage() {
  const [partie, catalog] = await Promise.all([readPartie(), loadCatalog()]);
  const svg = await buildMarcheSvg(groupMarche(partie.marche), catalog);
  return { buffer: await rasterize(svg, MAT_WIDTH), mimeType: "image/png" };
}

// Marché passé dans l'URL (duel, main éphémère), rendu sans état.
export async function getMarcheImageFromKeys(keys) {
  const catalog = await loadCatalog();
  const svg = await buildMarcheSvg(groupMarche(keys), catalog);
  return { buffer: await rasterize(svg, MAT_WIDTH), mimeType: "image/png" };
}

// Main d'un joueur (ou deck final) : clés passées dans l'URL, rendu sans état.
export async function getMainImage(keys) {
  return getCollectionImage(keys, await loadCatalog());
}

let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
