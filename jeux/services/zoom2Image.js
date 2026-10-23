// ============================================================
// zoom2Image.js — Synthèse d'image du jeu "Zoom logo" : rogne/zoome le logo
// de la manche (même formule de recadrage que zoomImage.js, SVG rasterisé
// via @resvg/resvg-js). Images lues depuis Vercel Blob (voir blobAssets.js
// et scripts/uploadImageAssetsToBlob.js), jamais depuis data/ au runtime.
//
// Différences avec Zoom carte :
// - fond BLANC : beaucoup de logos sont noirs sur fond transparent, ils
//   disparaîtraient sur le fond sombre de Zoom carte ;
// - zooms par défaut plus faibles (×6 sur un logo ne montre qu'un aplat de
//   couleur), réglés logo par logo dans le catalogue (focal/zoomStages) ;
// - la révélation est elle aussi composée sur fond blanc (logo entier,
//   centré), pour la même raison.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { loadZoom2Catalog, resolveZoom2Entry, isGamePosted } from "./zoom2.js";
import { readBlobAsset } from "@clash/commun/blobAssets.js";

const ZOOM2_IMAGES_DIR = "jeux-visuels/zoom2/images";

const BACKGROUND = "#ffffff";
const CELL_SIZE = 450;
const PADDING = 24;

const DEFAULT_FOCAL = { x: 0.5, y: 0.45 };
const DEFAULT_STAGE0_SCALE = 3.5; // image publique
const DEFAULT_STAGE1_SCALE = 1.8; // indice

const ICON_CACHE = new Map();

async function readImageDataUrl(filename) {
  if (ICON_CACHE.has(filename)) return ICON_CACHE.get(filename);
  const buffer = await readBlobAsset(`${ZOOM2_IMAGES_DIR}/${filename}`);
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  ICON_CACHE.set(filename, dataUrl);
  return dataUrl;
}

// Point focal (fx, fy) normalisé [0,1] de la source au centre de la cellule,
// à un facteur de zoom `scale` par rapport au "cover" (1 = cellule couverte).
function buildCropSvg(dataUrl, iw, ih, focal, scale) {
  const size = CELL_SIZE + PADDING * 2;
  const totalScale = Math.max(CELL_SIZE / iw, CELL_SIZE / ih) * scale;
  const x = PADDING + CELL_SIZE / 2 - focal.x * iw * totalScale;
  const y = PADDING + CELL_SIZE / 2 - focal.y * ih * totalScale;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <clipPath id="cell"><rect x="${PADDING}" y="${PADDING}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="16" ry="16"/></clipPath>
  <g clip-path="url(#cell)">
    <image x="${x}" y="${y}" width="${iw * totalScale}" height="${ih * totalScale}" href="${dataUrl}"/>
  </g>
</svg>`;
}

// Logo entier centré ("contain") sur fond blanc.
function buildRevealSvg(dataUrl, iw, ih) {
  const size = CELL_SIZE + PADDING * 2;
  const k = Math.min(CELL_SIZE / iw, CELL_SIZE / ih);
  const w = iw * k;
  const h = ih * k;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <image x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" href="${dataUrl}"/>
</svg>`;
}

function rasterize(svg) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: CELL_SIZE + PADDING * 2 },
    background: BACKGROUND,
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

// null si la manche n'a jamais été postée (anti-spoiler) ou n'existe pas.
async function loadPostedEntry(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  return resolveZoom2Entry(await loadZoom2Catalog(), gameId);
}

async function cropImage(gameId, scaleOf) {
  const entry = await loadPostedEntry(gameId);
  if (!entry) return null;
  const dataUrl = await readImageDataUrl(entry.image);
  return rasterize(buildCropSvg(dataUrl, entry.width, entry.height, entry.focal ?? DEFAULT_FOCAL, scaleOf(entry)));
}

// Image publique de la manche (fixe, partagée par tout le salon).
export function getZoom2CardImage(gameId) {
  return cropImage(gameId, (e) => e.zoomStages?.stage0 ?? DEFAULT_STAGE0_SCALE);
}

// Indice : dézoom.
export function getZoom2HintImage(gameId) {
  return cropImage(gameId, (e) => e.zoomStages?.stage1 ?? DEFAULT_STAGE1_SCALE);
}

// Révélation (DM après résolution) : logo entier.
export async function getZoom2RevealImage(gameId) {
  const entry = await loadPostedEntry(gameId);
  if (!entry) return null;
  const dataUrl = await readImageDataUrl(entry.image);
  return rasterize(buildRevealSvg(dataUrl, entry.width, entry.height));
}

// Rendu d'une entrée depuis un buffer local, sans Redis ni Blob : outils de
// vérification visuelle du catalogue uniquement.
export function renderZoom2Stages(entry, buffer) {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const focal = entry.focal ?? DEFAULT_FOCAL;
  return {
    stage0: rasterize(buildCropSvg(dataUrl, entry.width, entry.height, focal, entry.zoomStages?.stage0 ?? DEFAULT_STAGE0_SCALE)),
    stage1: rasterize(buildCropSvg(dataUrl, entry.width, entry.height, focal, entry.zoomStages?.stage1 ?? DEFAULT_STAGE1_SCALE)),
    reveal: rasterize(buildRevealSvg(dataUrl, entry.width, entry.height)),
  };
}
