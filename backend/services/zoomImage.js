// ============================================================
// zoomImage.js — Synthèse d'image pour le jeu "Zoom carte" : compose/rogne/
// zoome les icônes de cartes stockées localement (data/zoom/images/), sans
// aucune dépendance nouvelle. Réutilise la technique déjà présente dans ce
// repo pour buildWarDecksImage (api/discord/interactions.js) : un SVG avec
// des <image href="data:..."> rasterisé en PNG via @resvg/resvg-js.
//
// Contrairement à buildWarDecksImage (qui télécharge des icônes distantes à
// chaque appel), ici les octets sont lus directement sur disque — aucun
// réseau au moment de servir une manche, c'est tout l'intérêt du catalogue
// pré-téléchargé par scripts/generateZoomCatalog.js.
//
// Séparé de zoom.js (état/scoring) comme buildWarDecksImage est séparé de la
// logique de guerre — cette couche ne connaît que la synthèse d'image.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { loadZoomCatalog, resolveZoomPair, isGamePosted } from "./zoom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZOOM_IMAGES_DIR = path.resolve(__dirname, "..", "..", "data", "zoom", "images");

const BACKGROUND = "#0f172a";

// Composite (manche publique, 2 cartes côte à côte).
const COMPOSITE_CELL_SIZE = 400;
const COMPOSITE_GAP = 16;
const COMPOSITE_PADDING = 20;

// Slot unique (indice éphémère / révélation).
const SLOT_CELL_SIZE = 360;
const SLOT_PADDING = 20;

// Point focal et facteurs de zoom par défaut — chaque entrée du catalogue
// peut les surcharger (entry.focal / entry.zoomStages) si le crop générique
// rend mal sur une carte précise (icônes fines/hautes notamment).
const DEFAULT_FOCAL = { x: 0.5, y: 0.45 };
const DEFAULT_STAGE0_SCALE = 2.75; // zoom extrême, image publique
const DEFAULT_STAGE1_SCALE = 1.35; // dézoom, indice

// Cache mémoire des icônes lues sur disque, encodées en base64 — équivalent
// local (sans réseau) de CARD_ICON_CACHE/fetchImageDataUrl dans
// interactions.js:2062-2074.
const LOCAL_ICON_CACHE = new Map();

async function readLocalImageDataUrl(filename) {
  if (LOCAL_ICON_CACHE.has(filename)) return LOCAL_ICON_CACHE.get(filename);
  const buffer = await fs.readFile(path.join(ZOOM_IMAGES_DIR, filename));
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
// cellule est entièrement couverte sans zoom). Voir le plan pour le détail.
function buildCropCell({ dataUrl, iw, ih, cellOriginX, cellOriginY, cellSize, focal, scale, clipId }) {
  const baseScale = Math.max(cellSize / iw, cellSize / ih);
  const totalScale = baseScale * scale;
  const dispW = iw * totalScale;
  const dispH = ih * totalScale;
  const x = cellOriginX + cellSize / 2 - focal.x * iw * totalScale;
  const y = cellOriginY + cellSize / 2 - focal.y * ih * totalScale;

  return `
    <clipPath id="${clipId}"><rect x="${cellOriginX}" y="${cellOriginY}" width="${cellSize}" height="${cellSize}" rx="16" ry="16"/></clipPath>
    <g clip-path="url(#${clipId})">
      <rect x="${cellOriginX}" y="${cellOriginY}" width="${cellSize}" height="${cellSize}" fill="${BACKGROUND}"/>
      <image x="${x}" y="${y}" width="${dispW}" height="${dispH}" href="${dataUrl}"/>
    </g>`;
}

async function rasterize(svg, width, height) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    background: BACKGROUND,
  });
  const pngData = resvg.render();
  return { buffer: Buffer.from(pngData.asPng()), mimeType: "image/png" };
}

async function loadPair(gameId) {
  const catalog = await loadZoomCatalog();
  const { entryA, entryB } = resolveZoomPair(catalog, gameId);
  return { entryA, entryB };
}

// Image publique de la manche : les 2 cartes en zoom extrême (stage 0), fixe
// pour toute la durée de la manche (ne peut pas dépendre du joueur qui
// regarde — un embed Discord est partagé par tout le salon).
export async function getZoomCompositeImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const { entryA, entryB } = await loadPair(gameId);
  if (!entryA || !entryB) return null;

  const [dataUrlA, dataUrlB] = await Promise.all([
    readLocalImageDataUrl(entryA.image),
    readLocalImageDataUrl(entryB.image),
  ]);

  const width = COMPOSITE_PADDING * 2 + COMPOSITE_CELL_SIZE * 2 + COMPOSITE_GAP;
  const height = COMPOSITE_PADDING * 2 + COMPOSITE_CELL_SIZE;
  const originY = COMPOSITE_PADDING;
  const originAX = COMPOSITE_PADDING;
  const originBX = COMPOSITE_PADDING + COMPOSITE_CELL_SIZE + COMPOSITE_GAP;

  const cellA = buildCropCell({
    dataUrl: dataUrlA,
    iw: entryA.width,
    ih: entryA.height,
    cellOriginX: originAX,
    cellOriginY: originY,
    cellSize: COMPOSITE_CELL_SIZE,
    focal: focalOf(entryA),
    scale: stage0ScaleOf(entryA),
    clipId: "cellA",
  });
  const cellB = buildCropCell({
    dataUrl: dataUrlB,
    iw: entryB.width,
    ih: entryB.height,
    cellOriginX: originBX,
    cellOriginY: originY,
    cellSize: COMPOSITE_CELL_SIZE,
    focal: focalOf(entryB),
    scale: stage0ScaleOf(entryB),
    clipId: "cellB",
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  ${cellA}
  ${cellB}
</svg>`;

  return rasterize(svg, width, height);
}

// Image d'un seul slot : soit un dézoom (indice, stage 1), soit la carte
// entière (révélation, après résolution). La révélation n'a besoin d'aucun
// crop/composition : on renvoie directement les octets du fichier source.
export async function getZoomSlotImage(gameId, slot, { reveal = false } = {}) {
  if (!(await isGamePosted(gameId))) return null;
  const { entryA, entryB } = await loadPair(gameId);
  const entry = slot === "A" ? entryA : slot === "B" ? entryB : null;
  if (!entry) return null;

  if (reveal) {
    const buffer = await fs.readFile(path.join(ZOOM_IMAGES_DIR, entry.image));
    return { buffer, mimeType: "image/png" };
  }

  const dataUrl = await readLocalImageDataUrl(entry.image);
  const width = SLOT_CELL_SIZE + SLOT_PADDING * 2;
  const height = width;

  const cell = buildCropCell({
    dataUrl,
    iw: entry.width,
    ih: entry.height,
    cellOriginX: SLOT_PADDING,
    cellOriginY: SLOT_PADDING,
    cellSize: SLOT_CELL_SIZE,
    focal: focalOf(entry),
    scale: stage1ScaleOf(entry),
    clipId: "cellSlot",
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  ${cell}
</svg>`;

  return rasterize(svg, width, height);
}
