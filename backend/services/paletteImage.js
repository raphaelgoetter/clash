// ============================================================
// paletteImage.js — Synthèse d'image pour le jeu "Palette [TEST]" : la
// carte de la manche + une rangée de 4 pastilles de couleur étiquetées
// A/B/C/D (question) ou avec leur pourcentage + liseré sur la bonne réponse
// (résultat). Même technique que zoomImage.js/pelemeleImage.js : un SVG
// généré à la volée, rastérisé en PNG via @resvg/resvg-js — aucune
// dépendance nouvelle.
//
// ⚠️ Police embarquée OBLIGATOIRE (data/fonts/Inter-Bold.ttf) — comme
// pelemeleImage.js : resvg-js n'a AUCUNE police système sur le runtime
// serverless Vercel, le texte des lettres/pourcentages resterait invisible
// sans lever d'erreur si on comptait sur une police système.
//
// Deux répertoires source distincts, à ne JAMAIS confondre : data/palette/
// images/ (carte brute, pour la question) et data/palette/highlights/
// (carte avec le voile déjà posé sur la couleur dominante, pour le
// résultat) — le même nom de fichier existe dans les deux, donner l'un à la
// place de l'autre spoilerait la réponse directement dans la question.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { loadPaletteCatalog, resolvePaletteEntry, isGamePosted, readRoundOrder, LETTERS } from "./palette.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.resolve(__dirname, "..", "..", "data", "jeux-visuels", "palette", "images");
const HIGHLIGHTS_DIR = path.resolve(__dirname, "..", "..", "data", "jeux-visuels", "palette", "highlights");
const FONT_PATH = path.resolve(__dirname, "..", "..", "data", "fonts", "Inter-Bold.ttf");
const FONT_FAMILY = "Inter";

const BACKGROUND = "#0f172a";
const CARD_DISPLAY_WIDTH = 300;
const SWATCH_SIZE = 96;
const SWATCH_GAP = 16;
const PADDING = 24;
const GOLD = "#FFD700";

// Deux caches séparés (base64), un par répertoire — voir readLocalImageDataUrl.
const imageCache = new Map();
const highlightCache = new Map();

async function readDataUrl(dir, cache, filename) {
  if (cache.has(filename)) return cache.get(filename);
  const buffer = await fs.readFile(path.join(dir, filename));
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  cache.set(filename, dataUrl);
  return dataUrl;
}

// Même formule que targetLuminance dans dominantColor.js — cohérence avec
// l'algo qui a produit ces couleurs.
function contrastTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 128 ? "#FFFFFF" : "#1B1E27";
}

function buildSwatchesSvg(swatches, x0, y) {
  const showPercent = swatches.some((s) => s.share != null);
  return swatches
    .map((s, i) => {
      const x = x0 + i * (SWATCH_SIZE + SWATCH_GAP);
      const textColor = contrastTextColor(s.hex);
      const stroke = s.isCorrect
        ? `stroke="${GOLD}" stroke-width="5"`
        : `stroke="#00000030" stroke-width="1"`;
      const letterY = y + SWATCH_SIZE / 2 + 10;
      const percentText = showPercent
        ? `<text x="${x + SWATCH_SIZE / 2}" y="${y + SWATCH_SIZE + 26}" font-family="${FONT_FAMILY}" font-size="22" text-anchor="middle" fill="#E8E9ED">${Math.round((s.share ?? 0) * 100)}%</text>`
        : "";
      return `
        <rect x="${x}" y="${y}" width="${SWATCH_SIZE}" height="${SWATCH_SIZE}" rx="12" ry="12" fill="${s.hex}" ${stroke}/>
        <text x="${x + SWATCH_SIZE / 2}" y="${letterY}" font-family="${FONT_FAMILY}" font-size="40" text-anchor="middle" fill="${textColor}">${s.letter}</text>
        ${percentText}`;
    })
    .join("\n");
}

function buildPaletteSvg({ dataUrl, cardWidth, cardHeight, swatches }) {
  const showPercent = swatches.some((s) => s.share != null);
  const cardDisplayHeight = (cardHeight / cardWidth) * CARD_DISPLAY_WIDTH;
  const rowWidth = swatches.length * SWATCH_SIZE + (swatches.length - 1) * SWATCH_GAP;
  const width = Math.max(CARD_DISPLAY_WIDTH, rowWidth) + PADDING * 2;
  const cardX = (width - CARD_DISPLAY_WIDTH) / 2;
  const swatchesY = PADDING + cardDisplayHeight + PADDING;
  const swatchesX = (width - rowWidth) / 2;
  const height = swatchesY + SWATCH_SIZE + (showPercent ? 36 : 12) + PADDING;

  return {
    width,
    height,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <clipPath id="card"><rect x="${cardX}" y="${PADDING}" width="${CARD_DISPLAY_WIDTH}" height="${cardDisplayHeight}" rx="14" ry="14"/></clipPath>
  <g clip-path="url(#card)">
    <image x="${cardX}" y="${PADDING}" width="${CARD_DISPLAY_WIDTH}" height="${cardDisplayHeight}" href="${dataUrl}"/>
  </g>
  ${buildSwatchesSvg(swatches, swatchesX, swatchesY)}
</svg>`,
  };
}

async function rasterize(svg, width) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    background: BACKGROUND,
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  const pngData = resvg.render();
  return { buffer: Buffer.from(pngData.asPng()), mimeType: "image/png" };
}

async function loadEntryAndOrder(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const catalog = await loadPaletteCatalog();
  const entry = resolvePaletteEntry(catalog, gameId);
  const order = await readRoundOrder(gameId);
  if (!entry || !order) return null;
  return { entry, order };
}

// Image publique de la manche : carte brute + 4 pastilles SANS pourcentage
// ni indication de la bonne réponse.
export async function getPaletteQuestionImage(gameId) {
  const loaded = await loadEntryAndOrder(gameId);
  if (!loaded) return null;
  const { entry, order } = loaded;

  const dataUrl = await readDataUrl(IMAGES_DIR, imageCache, entry.image);
  const swatches = order.map((colorIdx, i) => ({
    letter: LETTERS[i],
    hex: entry.colors[colorIdx].hex,
  }));
  const { svg, width } = buildPaletteSvg({ dataUrl, cardWidth: entry.width, cardHeight: entry.height, swatches });
  return rasterize(svg, width);
}

// Image de révélation : carte avec le voile déjà posé sur la couleur
// dominante (data/palette/highlights/) + les 4 pourcentages + liseré doré
// sur la bonne réponse.
export async function getPaletteResultImage(gameId) {
  const loaded = await loadEntryAndOrder(gameId);
  if (!loaded) return null;
  const { entry, order } = loaded;

  const dataUrl = await readDataUrl(HIGHLIGHTS_DIR, highlightCache, entry.highlightImage);
  const swatches = order.map((colorIdx, i) => ({
    letter: LETTERS[i],
    hex: entry.colors[colorIdx].hex,
    share: entry.colors[colorIdx].share,
    isCorrect: colorIdx === 0,
  }));
  const { svg, width } = buildPaletteSvg({ dataUrl, cardWidth: entry.width, cardHeight: entry.height, swatches });
  return rasterize(svg, width);
}
