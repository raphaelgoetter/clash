// ============================================================
// zoomImage.js — Synthèse d'image pour le jeu "Zoom carte" : rogne/zoome
// l'icône de la carte stockée localement (data/zoom/images/), sans aucune
// dépendance nouvelle. Réutilise la technique déjà présente dans ce repo
// pour buildWarDecksImage (api/discord/interactions.js) : un SVG avec des
// <image href="data:..."> rasterisé en PNG via @resvg/resvg-js.
//
// Contrairement à buildWarDecksImage (qui télécharge des icônes distantes à
// chaque appel), ici les octets sont lus directement sur disque — aucun
// réseau au moment de servir une manche, c'est tout l'intérêt du catalogue
// pré-téléchargé par scripts/generateZoomCatalog.js.
//
// Séparé de zoom.js (état/scoring) comme buildWarDecksImage est séparé de la
// logique de guerre — cette couche ne connaît que la synthèse d'image.
//
// ⚠️ Le commentaire ci-dessus ("aucun réseau au moment de servir une
// manche") n'est plus tout à fait exact : les images sont maintenant servies
// depuis Vercel Blob (private — voir blobAssets.js) et non plus depuis
// data/, car le nom de fichier lu dépend du catalogue (donnée dynamique),
// ce qui forçait le traceur de build Vercel (@vercel/nft) à embarquer le
// RÉPERTOIRE ENTIER dans le bundle de fonction à chaque déploiement — cause
// principale du dépassement de Functions Storage (voir mémoire projet,
// sept. 2026). Compromis assumé : requête réseau au premier appel par
// instance de fonction, atténuée par le cache mémoire ci-dessous. Les
// fichiers restent versionnés dans data/jeux-visuels/zoom/ (régénérables
// via scripts/generateZoomCatalog.js), mais data/ n'est plus lu au runtime.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { loadZoomCatalog, resolveZoomEntry, isGamePosted } from "./zoom.js";
import { readBlobAsset } from "./blobAssets.js";

const ZOOM_IMAGES_DIR = "jeux-visuels/zoom/images";

const BACKGROUND = "#0f172a";
const CELL_SIZE = 450;
const PADDING = 24;

// Point focal et facteurs de zoom par défaut — chaque entrée du catalogue
// peut les surcharger (entry.focal / entry.zoomStages) si le crop générique
// rend mal sur une carte précise (icônes fines/hautes notamment).
//
// Historique des réglages (deux corrections après retours en conditions
// réelles) : parti à 2.75 par prudence sur le flou (résolution source
// 285×420) → trop lisible même sans indice, monté à 4.5 → toujours trop
// facile car le point focal par défaut (centre légèrement haut) atterrit
// quasi systématiquement sur l'œil du personnage, l'élément le plus
// reconnaissable d'une composition de carte Clash Royale, peu importe le
// niveau de zoom appliqué autour. Monter le zoom à 6.0 s'éloigne enfin
// suffisamment de l'œil pour ne plus le montrer entièrement dans la cellule.
const DEFAULT_FOCAL = { x: 0.5, y: 0.45 };
const DEFAULT_STAGE0_SCALE = 6.0; // zoom extrême, image publique
const DEFAULT_STAGE1_SCALE = 3.1; // dézoom, indice

// Cache mémoire des icônes lues sur disque, encodées en base64 — équivalent
// local (sans réseau) de CARD_ICON_CACHE/fetchImageDataUrl dans
// interactions.js:2062-2074.
const LOCAL_ICON_CACHE = new Map();

async function readLocalImageDataUrl(filename) {
  if (LOCAL_ICON_CACHE.has(filename)) return LOCAL_ICON_CACHE.get(filename);
  const buffer = await readBlobAsset(`${ZOOM_IMAGES_DIR}/${filename}`);
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  LOCAL_ICON_CACHE.set(filename, dataUrl);
  return dataUrl;
}

function focalOf(entry) {
  return entry.focal ?? DEFAULT_FOCAL;
}
function stage0ScaleOf(entry) {
  return entry.zoomStages?.stage0 ?? DEFAULT_STAGE0_SCALE;
}
function stage1ScaleOf(entry) {
  return entry.zoomStages?.stage1 ?? DEFAULT_STAGE1_SCALE;
}

// Formule de crop : positionne une <image> surdimensionnée pour que le point
// focal (fx, fy) normalisé [0,1] de la source atterrisse au centre de la
// cellule cible, à un facteur de zoom Z par rapport au "cover" (Z=1 = la
// cellule est entièrement couverte sans zoom).
function buildCropSvg(dataUrl, iw, ih, focal, scale) {
  const width = CELL_SIZE + PADDING * 2;
  const height = width;
  const baseScale = Math.max(CELL_SIZE / iw, CELL_SIZE / ih);
  const totalScale = baseScale * scale;
  const dispW = iw * totalScale;
  const dispH = ih * totalScale;
  const x = PADDING + CELL_SIZE / 2 - focal.x * iw * totalScale;
  const y = PADDING + CELL_SIZE / 2 - focal.y * ih * totalScale;

  return {
    width,
    height,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <clipPath id="cell"><rect x="${PADDING}" y="${PADDING}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="16" ry="16"/></clipPath>
  <g clip-path="url(#cell)">
    <image x="${x}" y="${y}" width="${dispW}" height="${dispH}" href="${dataUrl}"/>
  </g>
</svg>`,
  };
}

async function rasterize(svg, width) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    background: BACKGROUND,
  });
  const pngData = resvg.render();
  return { buffer: Buffer.from(pngData.asPng()), mimeType: "image/png" };
}

async function loadEntry(gameId) {
  const catalog = await loadZoomCatalog();
  return resolveZoomEntry(catalog, gameId);
}

// Image publique de la manche : zoom extrême (stage 0), fixe pour toute la
// durée de la manche (partagée par tout le salon, ne peut pas dépendre du
// joueur qui regarde).
export async function getZoomCardImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = await loadEntry(gameId);
  if (!entry) return null;

  const dataUrl = await readLocalImageDataUrl(entry.image);
  const { svg, width } = buildCropSvg(dataUrl, entry.width, entry.height, focalOf(entry), stage0ScaleOf(entry));
  return rasterize(svg, width);
}

// Indice : dézoom (stage 1).
export async function getZoomHintImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = await loadEntry(gameId);
  if (!entry) return null;

  const dataUrl = await readLocalImageDataUrl(entry.image);
  const { svg, width } = buildCropSvg(dataUrl, entry.width, entry.height, focalOf(entry), stage1ScaleOf(entry));
  return rasterize(svg, width);
}

// Révélation complète (après résolution) : aucun crop nécessaire, on renvoie
// directement les octets du fichier source.
export async function getZoomRevealImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = await loadEntry(gameId);
  if (!entry) return null;

  const buffer = await readBlobAsset(`${ZOOM_IMAGES_DIR}/${entry.image}`);
  return { buffer, mimeType: "image/png" };
}
