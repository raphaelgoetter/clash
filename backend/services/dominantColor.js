// ============================================================
// dominantColor.js — Extraction des couleurs dominantes d'une
// image de carte (PNG RGBA), pour le mini-jeu "devine la couleur
// dominante".
//
// Principe : histogramme de couleurs quantifiées, fusion gloutonne
// des clusters visuellement proches, puis exclusion des contours
// noirs/blancs (artefact de style BD des cartes) qui polluent le
// classement. Voir aussi le garde-fou "monochrome" : certaines
// cartes (squelettes, fantômes, armures grises) n'ont, même après
// nettoyage, que des nuances de luminosité d'une seule teinte —
// ce n'est plus "difficile" mais "indiscernable", donc à exclure
// du pool jouable plutôt qu'à corriger par l'algorithme.
// ============================================================

import { PNG } from "pngjs";

const BUCKET_SIZE = 24; // taille de la grille de quantization par canal (0-255)
const MERGE_DISTANCE = 40; // distance RGB en dessous de laquelle deux clusters fusionnent
const ALPHA_THRESHOLD = 128;
const LUMINANCE_MIN = 35; // ignore les contours quasi noirs
const LUMINANCE_MAX = 245; // ignore les reflets quasi blancs
const TOP_N = 4;

export const MAX_TOP1_SHARE = 0.6; // au-delà, la manche est jugée trop facile
export const MIN_HUE_DEGREES = 25; // écart de teinte (0-360°) en dessous duquel deux couleurs sont "la même"
export const MIN_SATURATION = 0.15; // en dessous, une couleur est jugée grise/neutre (teinte non fiable)

function toHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function rgbDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function hexToRgb(hex) {
  return [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Extrait les 4 couleurs dominantes d'un buffer PNG RGBA.
 * @returns {{ colors: {hex: string, share: number}[], isTooEasy: boolean, isMonochrome: boolean } | null}
 *   null si l'image n'a pas assez de pixels opaques exploitables.
 */
export function extractDominantColors(pngBuffer) {
  const { data, width, height } = PNG.sync.read(pngBuffer);
  const buckets = new Map();

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    if (data[offset + 3] < ALPHA_THRESHOLD) continue;

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance < LUMINANCE_MIN || luminance > LUMINANCE_MAX) continue;

    const key = [
      Math.floor(r / BUCKET_SIZE),
      Math.floor(g / BUCKET_SIZE),
      Math.floor(b / BUCKET_SIZE),
    ].join(",");

    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  const totalPixels = [...buckets.values()].reduce((sum, b) => sum + b.count, 0);
  if (totalPixels === 0) return null;

  const clusters = [...buckets.values()]
    .map((b) => ({ count: b.count, r: b.r / b.count, g: b.g / b.count, b: b.b / b.count }))
    .sort((a, b) => b.count - a.count);

  // Fusion gloutonne des clusters visuellement proches, en partant du plus gros.
  const merged = [];
  for (const cluster of clusters) {
    const target = merged.find((m) => rgbDistance(m, cluster) < MERGE_DISTANCE);
    if (target) {
      const totalCount = target.count + cluster.count;
      target.r = (target.r * target.count + cluster.r * cluster.count) / totalCount;
      target.g = (target.g * target.count + cluster.g * cluster.count) / totalCount;
      target.b = (target.b * target.count + cluster.b * cluster.count) / totalCount;
      target.count = totalCount;
    } else {
      merged.push({ ...cluster });
    }
  }

  merged.sort((a, b) => b.count - a.count);
  const top = merged.slice(0, TOP_N);
  if (top.length < TOP_N) return null;

  const colors = top.map((c) => ({
    hex: toHex(c.r, c.g, c.b),
    share: c.count / totalPixels,
  }));

  const isTooEasy = colors[0].share > MAX_TOP1_SHARE;

  const hsl = colors.map((c) => rgbToHsl(...hexToRgb(c.hex)));
  const saturated = hsl.filter((c) => c.s >= MIN_SATURATION);
  let maxHueSpread = 0;
  for (let i = 0; i < saturated.length; i++) {
    for (let j = i + 1; j < saturated.length; j++) {
      maxHueSpread = Math.max(maxHueSpread, hueDistance(saturated[i].h, saturated[j].h));
    }
  }
  const isMonochrome = saturated.length < 2 || maxHueSpread < MIN_HUE_DEGREES;

  return { colors, isTooEasy, isMonochrome };
}
