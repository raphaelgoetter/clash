// ============================================================
// dominantColor.js — Extraction des couleurs dominantes d'une
// image de carte (PNG RGBA), pour le mini-jeu "devine la couleur
// dominante".
//
// Principe : k-means fin (8 groupes) sur les pixels convertis en espace Lab,
// plus perceptuellement fiable qu'une distance RVB brute — voir piège 2
// ci-dessous —, après exclusion des contours noirs/blancs (artefact de style
// BD des cartes) qui polluent le classement. Les 8 groupes sont ensuite
// fusionnés par teinte (voir piège 3) pour ne garder que 4 couleurs finales.
// Voir aussi le garde-fou "monochrome" : certaines cartes (squelettes,
// fantômes, armures grises) n'ont, même après nettoyage, que des nuances de
// luminosité d'une seule teinte — ce n'est plus "difficile" mais
// "indiscernable", donc à exclure du pool jouable plutôt qu'à corriger par
// l'algorithme.
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
//
// Piège découvert en QA visuelle (3) : même avec le k-means Lab, imposer
// directement k=4 est trop serré — un même matériau qui varie beaucoup en
// éclairage (ex. le bois d'une cabane, moitié en pleine lumière moitié à
// l'ombre) se scinde en 2 des 4 clusters, laissant les 2 places restantes à
// des matières neutres/grises sans rapport entre elles (toit ardoise, arbre
// flou en fond, épée grise) qui se regroupent par accident parce qu'elles
// sont toutes peu saturées — donnant un "gris" dominant qui ne représente
// aucune vraie zone cohérente de l'image (ex. Cabane de barbare, Barbares).
// Fix : k-means fin à 8 clusters, PUIS fusion par teinte (pas par distance
// RVB comme le piège 2) des clusters dont la teinte est proche (même
// matériau à des éclairages différents) — les clusters gris/neutres, eux,
// ne fusionnent entre eux que si leur luminosité est proche, jamais avec un
// cluster saturé, même de luminosité similaire.
// ============================================================

import { PNG } from "pngjs";

const ALPHA_THRESHOLD = 128;
const LUMINANCE_MIN = 35; // ignore les contours quasi noirs
const LUMINANCE_MAX = 245; // ignore les reflets quasi blancs
const FINE_K = 8; // clusters fins avant fusion par teinte (voir piège 3)
const FINAL_COLORS = 4; // nombre de couleurs dominantes rendues au final
const KMEANS_ITERATIONS = 15;
const KMEANS_MAX_SAMPLES = 15000; // sous-échantillonnage pour le clustering (les parts finales, elles, sont recalculées sur tous les pixels)
const HUE_MERGE_DEGREES = 22; // écart de teinte en dessous duquel deux clusters fins sont jugés "même matériau"
const GREY_LIGHTNESS_MERGE = 0.14; // pour les clusters peu saturés, écart de luminosité (0-1) toléré pour fusionner

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
 * @returns {{
 *   colors: {hex: string, share: number}[],
 *   isTooEasy: boolean,
 *   isMonochrome: boolean,
 *   pixelColorIndex: Int8Array,
 * } | null}
 *   null si l'image n'a pas assez de pixels opaques exploitables. pixelColorIndex
 *   (taille width*height, une entrée par pixel du PNG source) donne l'index dans
 *   `colors` (0-3) du pixel, ou -1 s'il a été exclu (cadre/alpha/contour) ou
 *   n'entre dans aucune des 4 couleurs retenues — sert à construire l'image
 *   "preuve" qui surligne la zone gagnante pour le joueur (voir buildHighlightOverlay).
 */
export function extractDominantColors(pngBuffer, { frameMask } = {}) {
  const { data, width, height } = PNG.sync.read(pngBuffer);

  // Pixels valides (cadre/alpha/contours exclus), convertis en Lab, en
  // gardant leur index d'origine pour pouvoir reconstruire une image ensuite.
  const labByIndex = [];
  const originalIndex = [];
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
    originalIndex.push(i);
  }

  const totalPixels = labByIndex.length;
  if (totalPixels === 0) return null;

  // Sous-échantillonnage déterministe (foulée fixe) pour l'ajustement du
  // k-means — les parts finales sont, elles, recalculées sur tous les pixels.
  const stride = Math.max(1, Math.floor(totalPixels / KMEANS_MAX_SAMPLES));
  const sample = [];
  for (let i = 0; i < labByIndex.length; i += stride) sample.push(labByIndex[i]);

  const fineK = Math.min(FINE_K, sample.length);
  const centroids = kmeansLab(sample, fineK);

  const counts = new Array(centroids.length).fill(0);
  const fineAssignment = new Array(labByIndex.length);
  for (let n = 0; n < labByIndex.length; n++) {
    let best = 0, bestDist = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = labDistance(labByIndex[n], centroids[c]);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    counts[best] += 1;
    fineAssignment[n] = best;
  }

  const fine = centroids
    .map((lab, c) => {
      const [r, g, b] = labToRgb(...lab);
      return { c, count: counts[c], lab, hsl: rgbToHsl(r, g, b) };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  // Fusion des clusters fins par matériau : même teinte (± HUE_MERGE_DEGREES)
  // pour les couleurs saturées, même luminosité (± GREY_LIGHTNESS_MERGE) pour
  // les couleurs neutres — jamais l'un avec l'autre. Ancrée sur le premier
  // membre (le plus gros) de chaque groupe, pas sur une moyenne qui dérive,
  // pour éviter le chaînage transitif du piège 2.
  const groups = [];
  for (const cluster of fine) {
    const target = groups.find((g) => {
      const anchorLowSat = g.anchor.hsl.s < MIN_SATURATION;
      const clusterLowSat = cluster.hsl.s < MIN_SATURATION;
      if (anchorLowSat !== clusterLowSat) return false;
      if (anchorLowSat) return Math.abs(g.anchor.hsl.l - cluster.hsl.l) < GREY_LIGHTNESS_MERGE;
      return hueDistance(g.anchor.hsl.h, cluster.hsl.h) < HUE_MERGE_DEGREES;
    });
    if (target) {
      target.members.push(cluster);
      target.count += cluster.count;
    } else {
      groups.push({ anchor: cluster, count: cluster.count, members: [cluster] });
    }
  }
  groups.sort((a, b) => b.count - a.count);

  // Certaines illustrations simples (sorts, effets) n'ont pas assez de
  // matériaux distincts pour survivre à la fusion (ex. Zap, Tesla, Poison) —
  // plutôt que d'écarter la carte, on retombe sur les clusters fins non
  // fusionnés, qui restent une extraction valide, juste moins "regroupée".
  const finalGroups = groups.length >= FINAL_COLORS
    ? groups.slice(0, FINAL_COLORS)
    : fine.slice(0, FINAL_COLORS).map((c) => ({ count: c.count, members: [c] }));
  if (finalGroups.length < FINAL_COLORS) return null;

  const colors = finalGroups.map((g) => {
    const totalCount = g.members.reduce((sum, m) => sum + m.count, 0);
    const lab = [0, 1, 2].map((i) => g.members.reduce((sum, m) => sum + m.lab[i] * m.count, 0) / totalCount);
    return { hex: toHex(...labToRgb(...lab)), share: g.count / totalPixels };
  });

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

  // Index (dans `colors`) de chaque pixel du PNG source, pour l'image "preuve".
  const fineToColorIndex = new Map();
  finalGroups.forEach((g, colorIndex) => {
    for (const m of g.members) fineToColorIndex.set(m.c, colorIndex);
  });
  const pixelColorIndex = new Int8Array(width * height).fill(-1);
  for (let n = 0; n < originalIndex.length; n++) {
    pixelColorIndex[originalIndex[n]] = fineToColorIndex.get(fineAssignment[n]) ?? -1;
  }

  return { colors, isTooEasy, isMonochrome, pixelColorIndex };
}

/**
 * Construit une image "preuve" : la carte d'origine avec un voile marqué de
 * la couleur `colorIndex` posé sur les pixels qui la composent, et le reste
 * de l'image assombri OU éclairci (selon la luminosité de la couleur
 * gagnante — l'assombrir quand elle est déjà sombre tue le contraste au
 * lieu de le renforcer) pour que ce voile ressorte nettement dans tous les
 * cas — pour que le joueur voie directement d'où vient le résultat plutôt
 * que de devoir croire un pourcentage sur parole.
 * @param {Buffer} pngBuffer - la même image que celle passée à extractDominantColors
 * @param {Int8Array} pixelColorIndex - retourné par extractDominantColors
 * @param {number} colorIndex - quelle couleur (0-3, 0 = la dominante) surligner
 * @param {string} hex - le hex de cette couleur (le voile posé sur les pixels)
 * @param {number} [overlayAlpha] - opacité du voile sur la zone surlignée (0-1)
 * @param {number} [dimAmount] - assombrissement/éclaircissement du reste de l'image (0-1)
 * @returns {Buffer} un nouveau PNG encodé
 */
export function buildHighlightOverlay(pngBuffer, pixelColorIndex, colorIndex, hex, overlayAlpha = 0.8, dimAmount = 0.6) {
  const png = PNG.sync.read(pngBuffer);
  const [tr, tg, tb] = hexToRgb(hex);

  // Couleur gagnante sombre -> éclaircir le reste de l'image (sinon voile
  // sombre sur fond assombri = contraste écrasé) ; couleur claire -> assombrir.
  const targetLuminance = 0.299 * tr + 0.587 * tg + 0.114 * tb;
  const lightenRest = targetLuminance < 128;

  for (let i = 0; i < png.width * png.height; i++) {
    const offset = i * 4;
    if (pixelColorIndex[i] === colorIndex) {
      png.data[offset] = Math.round(png.data[offset] * (1 - overlayAlpha) + tr * overlayAlpha);
      png.data[offset + 1] = Math.round(png.data[offset + 1] * (1 - overlayAlpha) + tg * overlayAlpha);
      png.data[offset + 2] = Math.round(png.data[offset + 2] * (1 - overlayAlpha) + tb * overlayAlpha);
    } else if (lightenRest) {
      png.data[offset] = Math.round(png.data[offset] + (255 - png.data[offset]) * dimAmount);
      png.data[offset + 1] = Math.round(png.data[offset + 1] + (255 - png.data[offset + 1]) * dimAmount);
      png.data[offset + 2] = Math.round(png.data[offset + 2] + (255 - png.data[offset + 2]) * dimAmount);
    } else {
      png.data[offset] = Math.round(png.data[offset] * (1 - dimAmount));
      png.data[offset + 1] = Math.round(png.data[offset + 1] * (1 - dimAmount));
      png.data[offset + 2] = Math.round(png.data[offset + 2] * (1 - dimAmount));
    }
  }

  return PNG.sync.write(png);
}
