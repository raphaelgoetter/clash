// ============================================================
// dominantColor.js — Extraction des couleurs dominantes d'une
// image de carte (PNG RGBA), pour le mini-jeu "devine la couleur
// dominante".
//
// Principe : k-means (k=4) sur les pixels convertis en espace Lab, plus
// perceptuellement fiable qu'une distance RVB brute — voir piège 2 ci-dessous
// —, après exclusion des contours noirs/blancs (artefact de style BD des
// cartes) qui polluent le classement. Voir aussi le garde-fou "monochrome" :
// certaines cartes (squelettes, fantômes, armures grises) n'ont, même après
// nettoyage, que des nuances de luminosité d'une seule teinte — ce n'est
// plus "difficile" mais "indiscernable", donc à exclure du pool jouable
// plutôt qu'à corriger par l'algorithme.
//
// Piège découvert en QA visuelle (1) : les images iconUrls.medium ne
// sont PAS de l'illustration détourée sur fond transparent — elles
// incluent le blason/cadre décoratif (recoloré par rareté, identique
// à quelques pixels près pour toutes les cartes d'une même rareté).
// Ce cadre forme un anneau opaque assez grand pour devenir "la
// couleur dominante" à la place du personnage (ex. le cadre bleu-gris
// des cartes champion ressortait comme dominant sur Reine des
// Archères, alors qu'il n'apparaît nulle part dans le visage/les
// cheveux). buildFrameMask() détecte ce cadre par comparaison inter-
// cartes : un pixel dont la couleur ne varie quasiment pas d'une
// carte à l'autre (même rareté) ne peut pas appartenir à l'illustration
// (qui, elle, change à chaque carte) — c'est forcément le cadre partagé.
//
// Piège découvert en QA visuelle (2) : une première version regroupait les
// pixels par distance RVB brute avec fusion gloutonne des buckets proches.
// En RVB, des couleurs sombres de teintes pourtant très différentes (ombre
// de cheveux roses, bois d'une flèche, ombre de peau) sont numériquement
// proches — l'algorithme les fusionnait en un seul cluster dont la couleur
// "moyenne" (ex. #572929) n'apparaissait dans AUCUNE zone réelle de l'image.
// Le k-means en espace Lab résout ça : Lab sépare la luminosité (L) de la
// teinte (a/b) de façon perceptuellement fidèle, donc deux couleurs sombres
// de teintes différentes restent éloignées même à faible luminosité — ce
// qu'une distance RVB brute ne garantit pas.
// ============================================================

import { PNG } from "pngjs";

const ALPHA_THRESHOLD = 128;
const LUMINANCE_MIN = 35; // ignore les contours quasi noirs
const LUMINANCE_MAX = 245; // ignore les reflets quasi blancs
const K = 4; // nombre de couleurs dominantes à extraire
const KMEANS_ITERATIONS = 15;
const KMEANS_MAX_SAMPLES = 15000; // sous-échantillonnage pour le clustering (les parts finales, elles, sont recalculées sur tous les pixels)

export const MAX_TOP1_SHARE = 0.6; // au-delà, la manche est jugée trop facile
export const MIN_HUE_DEGREES = 25; // écart de teinte (0-360°) en dessous duquel deux couleurs sont "la même"
export const MIN_SATURATION = 0.15; // en dessous, une couleur est jugée grise/neutre (teinte non fiable)
const FRAME_MIN_ALPHA = 200; // le cadre est un anneau plein ; en dessous, c'est un pixel d'anti-aliasing du bord
const FRAME_MAX_CHANNEL_RANGE = 6; // écart R/G/B toléré entre cartes pour qu'un pixel soit jugé "cadre partagé"

/**
 * Détecte le cadre décoratif partagé entre plusieurs cartes de même
 * rareté : un pixel dont la couleur est quasi identique sur TOUTES les
 * images fournies (à FRAME_MAX_CHANNEL_RANGE près) ne peut pas appartenir
 * à l'illustration, qui diffère nécessairement d'une carte à l'autre.
 * @param {Buffer[]} pngBuffers - buffers PNG d'au moins quelques cartes de la même rareté
 * @returns {Uint8Array} masque de taille width*height (1 = pixel de cadre à exclure)
 */
export function buildFrameMask(pngBuffers) {
  const pngs = pngBuffers.map((buf) => PNG.sync.read(buf));
  const { width, height } = pngs[0];
  const size = width * height;
  const mask = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    const offset = i * 4;
    let minA = 255, minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (const png of pngs) {
      const a = png.data[offset + 3];
      if (a < minA) minA = a;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    if (
      minA >= FRAME_MIN_ALPHA &&
      maxR - minR <= FRAME_MAX_CHANNEL_RANGE &&
      maxG - minG <= FRAME_MAX_CHANNEL_RANGE &&
      maxB - minB <= FRAME_MAX_CHANNEL_RANGE
    ) {
      mask[i] = 1;
    }
  }

  return mask;
}

function toHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

// sRGB (D65) -> CIE Lab, formules standard.
function rgbToLab(r, g, b) {
  const toLinear = (c) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);

  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);

  const x = fInv(fx) * 0.95047;
  const y = fInv(fy);
  const z = fInv(fz) * 1.08883;

  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const gl = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  const toSrgb = (c) => {
    c = c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c;
    return Math.min(255, Math.max(0, Math.round(c * 255)));
  };
  return [toSrgb(rl), toSrgb(gl), toSrgb(bl)];
}

function labDistance(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/**
 * k-means déterministe (init par échantillonnage du point le plus éloigné
 * des centroïdes déjà choisis — "farthest-first" — pas d'aléatoire, pour que
 * la génération du catalogue reste reproductible d'un run à l'autre).
 * @param {number[][]} points - points Lab à regrouper
 * @param {number} k
 * @returns {number[][]} k centroïdes Lab
 */
function kmeansLab(points, k) {
  const centroids = [points[0]];
  const minDist = points.map((p) => labDistance(p, points[0]));

  for (let c = 1; c < k; c++) {
    let farthestIdx = 0, farthestDist = -1;
    for (let i = 0; i < points.length; i++) {
      if (minDist[i] > farthestDist) {
        farthestDist = minDist[i];
        farthestIdx = i;
      }
    }
    centroids.push(points[farthestIdx]);
    for (let i = 0; i < points.length; i++) {
      minDist[i] = Math.min(minDist[i], labDistance(points[i], points[farthestIdx]));
    }
  }

  const assignment = new Array(points.length).fill(0);
  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    for (let i = 0; i < points.length; i++) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = labDistance(points[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assignment[i] = best;
    }

    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assignment[i]];
      s[0] += points[i][0]; s[1] += points[i][1]; s[2] += points[i][2]; s[3] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }

  return centroids;
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
 * @param {Buffer} pngBuffer
 * @param {{ frameMask?: Uint8Array }} [options] - frameMask issu de buildFrameMask(), pour ignorer le cadre partagé de la rareté
 * @returns {{ colors: {hex: string, share: number}[], isTooEasy: boolean, isMonochrome: boolean } | null}
 *   null si l'image n'a pas assez de pixels opaques exploitables.
 */
export function extractDominantColors(pngBuffer, { frameMask } = {}) {
  const { data, width, height } = PNG.sync.read(pngBuffer);

  // Pixels valides (cadre/alpha/contours exclus), convertis en Lab.
  const labByIndex = [];
  for (let i = 0; i < width * height; i++) {
    if (frameMask?.[i]) continue;

    const offset = i * 4;
    if (data[offset + 3] < ALPHA_THRESHOLD) continue;

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance < LUMINANCE_MIN || luminance > LUMINANCE_MAX) continue;

    labByIndex.push(rgbToLab(r, g, b));
  }

  const totalPixels = labByIndex.length;
  if (totalPixels === 0) return null;

  // Sous-échantillonnage déterministe (foulée fixe) pour l'ajustement du
  // k-means — les parts finales sont, elles, recalculées sur tous les pixels.
  const stride = Math.max(1, Math.floor(totalPixels / KMEANS_MAX_SAMPLES));
  const sample = [];
  for (let i = 0; i < labByIndex.length; i += stride) sample.push(labByIndex[i]);

  const centroids = kmeansLab(sample, Math.min(K, sample.length));

  const counts = new Array(centroids.length).fill(0);
  for (const lab of labByIndex) {
    let best = 0, bestDist = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = labDistance(lab, centroids[c]);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    counts[best] += 1;
  }

  const colors = centroids
    .map((lab, c) => ({ hex: toHex(...labToRgb(...lab)), share: counts[c] / totalPixels }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
  if (colors.length < K) return null;

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
