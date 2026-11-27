// ============================================================
// zoomImage.js — Synthèse d'image du jeu "Zoom truc" : rogne/zoome la photo
// d'objet de la manche (SVG rasterisé via @resvg/resvg-js, même formule de
// recadrage que zoom2Image.js). Photos JPEG lues depuis Vercel Blob (voir
// blobAssets.js et scripts/uploadImageAssetsToBlob.js), jamais depuis data/
// au runtime : un nom de fichier lu depuis le catalogue ferait embarquer tout
// le dossier dans le bundle de fonction par le traceur de build Vercel.
//
// Les trois rendus (zoom extrême, indice, révélation) sortent en PNG.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { loadZoomCatalog, resolveZoomEntry, isGamePosted } from "./zoom.js";
import { readBlobAsset } from "@clash/commun/blobAssets.js";

const ZOOM_IMAGES_DIR = "jeux-visuels/zoom/images";

const BACKGROUND = "#0f172a";
const CELL_SIZE = 450;
const PADDING = 24;

// Point focal et facteurs de zoom par défaut, surchargeables objet par objet
// dans le catalogue (focal / zoomStages) : chaque photo est réglée et
// vérifiée visuellement avant son ajout.
const DEFAULT_FOCAL = { x: 0.5, y: 0.5 };
const DEFAULT_STAGE0_SCALE = 6.0; // zoom extrême, image publique
const DEFAULT_STAGE1_SCALE = 2.5; // indice

const IMAGE_CACHE = new Map();

function toDataUrl(buffer) {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function readImageDataUrl(filename) {
  if (IMAGE_CACHE.has(filename)) return IMAGE_CACHE.get(filename);
  const dataUrl = toDataUrl(await readBlobAsset(`${ZOOM_IMAGES_DIR}/${filename}`));
  IMAGE_CACHE.set(filename, dataUrl);
  return dataUrl;
}

// Point focal (fx, fy) normalisé [0,1] de la source au centre de la cellule,
// à un facteur de zoom `scale` par rapport au "cover" (1 = cellule couverte).
// Le cadrage est ramené dans la photo : un point focal proche d'un bord
// avec un zoom faible ne laisse jamais de bande vide dans la cellule.
function buildCropSvg(dataUrl, iw, ih, focal, scale) {
  const size = CELL_SIZE + PADDING * 2;
  const totalScale = Math.max(CELL_SIZE / iw, CELL_SIZE / ih) * scale;
  const clamp = (v, dim) => Math.min(PADDING, Math.max(PADDING + CELL_SIZE - dim, v));
  const x = clamp(PADDING + CELL_SIZE / 2 - focal.x * iw * totalScale, iw * totalScale);
  const y = clamp(PADDING + CELL_SIZE / 2 - focal.y * ih * totalScale, ih * totalScale);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <clipPath id="cell"><rect x="${PADDING}" y="${PADDING}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="16" ry="16"/></clipPath>
  <g clip-path="url(#cell)">
    <image x="${x}" y="${y}" width="${iw * totalScale}" height="${ih * totalScale}" href="${dataUrl}"/>
  </g>
</svg>`;
}

// Photo entière ("contain"), centrée, sur la largeur de la cellule.
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

const stage0ScaleOf = (e) => e.zoomStages?.stage0 ?? DEFAULT_STAGE0_SCALE;
const stage1ScaleOf = (e) => e.zoomStages?.stage1 ?? DEFAULT_STAGE1_SCALE;

// null si la manche n'a jamais été postée (anti-spoiler) ou n'existe pas.
async function loadPostedEntry(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  return resolveZoomEntry(await loadZoomCatalog(), gameId);
}

async function cropImage(gameId, scaleOf) {
  const entry = await loadPostedEntry(gameId);
  if (!entry) return null;
  const dataUrl = await readImageDataUrl(entry.image);
  return rasterize(buildCropSvg(dataUrl, entry.width, entry.height, entry.focal ?? DEFAULT_FOCAL, scaleOf(entry)));
}

// Image publique de la manche : zoom extrême, fixe pour toute la manche
// (partagée par tout le salon, ne peut pas dépendre du joueur).
export function getZoomCardImage(gameId) {
  return cropImage(gameId, stage0ScaleOf);
}

// Indice : dézoom.
export function getZoomHintImage(gameId) {
  return cropImage(gameId, stage1ScaleOf);
}

// Révélation (DM après résolution) : photo entière.
export async function getZoomRevealImage(gameId) {
  const entry = await loadPostedEntry(gameId);
  if (!entry) return null;
  const dataUrl = await readImageDataUrl(entry.image);
  return rasterize(buildRevealSvg(dataUrl, entry.width, entry.height));
}

// Rendu d'une entrée depuis un buffer local, sans Redis ni Blob : tests et
// vérification visuelle du catalogue uniquement.
export function renderZoomStages(entry, buffer) {
  const dataUrl = toDataUrl(buffer);
  const focal = entry.focal ?? DEFAULT_FOCAL;
  return {
    stage0: rasterize(buildCropSvg(dataUrl, entry.width, entry.height, focal, stage0ScaleOf(entry))),
    stage1: rasterize(buildCropSvg(dataUrl, entry.width, entry.height, focal, stage1ScaleOf(entry))),
    reveal: rasterize(buildRevealSvg(dataUrl, entry.width, entry.height)),
  };
}
