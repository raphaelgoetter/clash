// ============================================================
// intrusImage.js — Image d'une manche "Intrus de l'inventaire" : les 4
// objets en grille 2×2, dans l'ordre A/B/C/D de la manche
// (`intrus:order:<gameId>`), chacun avec sa pastille de lettre. Rendu SVG →
// PNG via @resvg/resvg-js, police embarquée (sinon texte invisible sur
// Vercel). Icônes lues depuis Vercel Blob (voir blobAssets.js et
// scripts/uploadImageAssetsToBlob.js), jamais depuis data/ au runtime :
// PNG carrés de 256 px normalisés par jeux/outils/intrus/verifierCatalogue.js.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { loadTriviaCatalog, resolveTriviaEntry, isGamePosted, readRoundOrder, LETTERS } from "./intrus.js";
import { readBlobAsset, readBlobFontPath } from "@clash/commun/blobAssets.js";

const INTRUS_IMAGES_DIR = "jeux-visuels/intrus/images";
const FONT_PATH = "fonts/Inter-Bold.ttf";
const FONT_FAMILY = "Inter";

const BACKGROUND = "#0f172a";
const CARD_FILL = "#475569";
const BADGE_FILL = "#FFD700";
const BADGE_TEXT = "#0f172a";
const CELL_SIZE = 300;
const ICON_SIZE = 220;
const GAP = 20;
const PADDING = 24;
const BADGE_RADIUS = 26;

// Accentuation (netteté) par objet, 0..3 : masque flou (image + k × (image −
// flou de rayon 2 px)), alpha d'origine conservé. Appliqué au rendu, même
// filtre SVG dans la démo de relecture et en production. Un noyau 3×3 ne
// suffit pas : le flou d'une petite icône agrandie s'étale sur plusieurs px.
export const ACCENTUATION_FORCES = [0, 0.7, 1.4, 2.4];

export function accentuationFilter(level) {
  const k = ACCENTUATION_FORCES[level];
  return `<filter id="acc${level}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="flou"/><feComposite in="SourceGraphic" in2="flou" operator="arithmetic" k1="0" k2="${1 + k}" k3="${-k}" k4="0" result="net"/><feComposite in="net" in2="SourceAlpha" operator="in"/></filter>`;
}

const ICON_CACHE = new Map();

async function readIconDataUrl(filename) {
  if (ICON_CACHE.has(filename)) return ICON_CACHE.get(filename);
  const buffer = await readBlobAsset(`${INTRUS_IMAGES_DIR}/${filename}`);
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  ICON_CACHE.set(filename, dataUrl);
  return dataUrl;
}

// Fonction pure : SVG de la grille. `cells` = [{ letter, dataUrl,
// accentuation? }] dans l'ordre d'affichage (A, B, C, D).
export function buildGridSvg(cells) {
  const size = PADDING * 2 + CELL_SIZE * 2 + GAP;
  const levels = [...new Set(cells.map((c) => c.accentuation ?? 0).filter((l) => l > 0))];
  const defs = levels.length ? `\n  <defs>${levels.map(accentuationFilter).join("")}</defs>` : "";
  const parts = cells.map(({ letter, dataUrl, accentuation = 0 }, i) => {
    const x = PADDING + (i % 2) * (CELL_SIZE + GAP);
    const y = PADDING + Math.floor(i / 2) * (CELL_SIZE + GAP);
    const iconOffset = (CELL_SIZE - ICON_SIZE) / 2;
    const bx = x + BADGE_RADIUS + 12;
    const by = y + BADGE_RADIUS + 12;
    return `
  <rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="20" ry="20" fill="${CARD_FILL}"/>
  <image x="${x + iconOffset}" y="${y + iconOffset + 10}" width="${ICON_SIZE}" height="${ICON_SIZE}"${accentuation > 0 ? ` filter="url(#acc${accentuation})"` : ""} href="${dataUrl}"/>
  <circle cx="${bx}" cy="${by}" r="${BADGE_RADIUS}" fill="${BADGE_FILL}"/>
  <text x="${bx}" y="${by + 11}" font-family="${FONT_FAMILY}" font-size="32" text-anchor="middle" fill="${BADGE_TEXT}">${letter}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>${defs}${parts.join("")}
</svg>`;
}

export async function rasterizeGrid(svg, fontPath) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    background: BACKGROUND,
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

// null si la manche n'a jamais été postée (anti-spoiler) ou n'existe pas.
export async function getIntrusImage(gameId) {
  if (!(await isGamePosted(gameId))) return null;
  const entry = resolveTriviaEntry(await loadTriviaCatalog(), gameId);
  const order = await readRoundOrder(gameId);
  if (!entry || !order) return null;
  const cells = await Promise.all(
    order.map(async (optionIdx, i) => ({
      letter: LETTERS[i],
      dataUrl: await readIconDataUrl(entry.images[optionIdx]),
      accentuation: entry.accentuations?.[optionIdx] ?? 0,
    })),
  );
  return rasterizeGrid(buildGridSvg(cells), await readBlobFontPath(FONT_PATH));
}
