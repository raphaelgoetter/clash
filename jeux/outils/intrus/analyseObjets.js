// ============================================================
// analyseObjets.js — Mesures automatiques sur les icônes normalisées
// (PNG 256 px) du jeu "Intrus de l'inventaire" : netteté et style visuel.
// Sert au tri des objets (supprimer les plus flous, assembler des planches
// de style homogène) dans demoValidation.js et verifierCatalogue.js.
//
// - Netteté : écart-type du laplacien de la luminance sur les pixels
//   visibles. Une petite source agrandie avec lissage est floue (score bas) ;
//   le pixel art agrandi sans lissage est très net.
// - Style automatique (indicatif, corrigeable à la main via `style` dans
//   objets.json) : `pixel` (aplats en blocs, peu de couleurs), `carree`
//   (icône opaque qui remplit son carré : WoW, LoL, Dota), `aplat` (cartoon,
//   peu de couleurs saturées), `peint` (dégradés, rendu 3D ou peint).
// Les styles thématiques (steampunk, fantasy…) ne se mesurent pas : ce sont
// des étiquettes manuelles (`etiquettes` dans objets.json).
// ============================================================

import { PNG } from "pngjs";

export const STYLES = {
  pixel: "Pixel art",
  carree: "Icône carrée",
  aplat: "Aplat / cartoon",
  peint: "Peint / 3D",
};

const ALPHA_MIN = 8;

export function computeNetteteScore({ width, height, data }) {
  if (width < 3 || height < 3) return 0;
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (data[idx * 4 + 3] <= ALPHA_MIN) continue;
      const lap = Math.abs(
        lum[idx - width] + lum[idx + width] + lum[idx - 1] + lum[idx + 1] - 4 * lum[idx],
      );
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Number(Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2));
}

// Mesures de style sur les pixels visibles :
// - couverture : part du carré occupée par des pixels visibles ;
// - egaux : part des paires de voisins horizontaux strictement identiques
//   (très haute en pixel art agrandi, basse sur un dégradé) ;
// - couleurs : nombre de couleurs distinctes après quantification 4 bits ;
// - saturation : saturation moyenne (0..1).
export function computeStyleFeatures({ width, height, data }) {
  let visibles = 0;
  let paires = 0;
  let egaux = 0;
  let satTotal = 0;
  const couleurs = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] <= ALPHA_MIN) continue;
      visibles++;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      couleurs.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      const max = Math.max(r, g, b);
      satTotal += max ? (max - Math.min(r, g, b)) / max : 0;
      if (x + 1 < width && data[i + 7] > ALPHA_MIN) {
        paires++;
        if (r === data[i + 4] && g === data[i + 5] && b === data[i + 6]) egaux++;
      }
    }
  }
  return {
    couverture: Number((visibles / (width * height)).toFixed(3)),
    egaux: paires ? Number((egaux / paires).toFixed(3)) : 0,
    couleurs: couleurs.size,
    saturation: visibles ? Number((satTotal / visibles).toFixed(3)) : 0,
  };
}

export function detectStyle({ couverture, egaux, couleurs, saturation }) {
  if (egaux >= 0.88 && couleurs <= 160) return "pixel";
  if (couverture >= 0.9) return "carree";
  if (couleurs <= 220 && saturation >= 0.35) return "aplat";
  return "peint";
}

// Signature visuelle compacte, indépendante de la teinte : silhouette
// (alpha moyen) et luminance centrée-réduite sur une grille 16×16. La teinte
// est ignorée exprès : 3 recolorations d'un même flacon doivent compter
// comme 3 objets identiques.
const GRILLE = 16;
export function computeSignature({ width, height, data }) {
  const silhouette = new Array(GRILLE * GRILLE).fill(0);
  const lum = new Array(GRILLE * GRILLE).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      const c = Math.floor((y * GRILLE) / height) * GRILLE + Math.floor((x * GRILLE) / width);
      silhouette[c] += a;
      lum[c] += (a * (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722)) / 255;
    }
  }
  const parCase = (width * height) / (GRILLE * GRILLE);
  const l = lum.map((v) => v / parCase);
  const moy = l.reduce((a, b) => a + b, 0) / l.length;
  const et = Math.sqrt(l.reduce((a, b) => a + (b - moy) ** 2, 0) / l.length) || 1;
  return {
    silhouette: silhouette.map((v) => Number((v / parCase).toFixed(3))),
    structure: l.map((v) => Number(((v - moy) / et).toFixed(3))),
  };
}

const ecartMoyen = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
export const distSilhouette = (a, b) => ecartMoyen(a.silhouette, b.silhouette);
export const distMixte = (a, b) => (distSilhouette(a, b) + ecartMoyen(a.structure, b.structure) / 2) / 2;

function comparerTrio(distance, intrus, trio) {
  const dansTrio = [[0, 1], [0, 2], [1, 2]].reduce((s, [i, j]) => s + distance(trio[i], trio[j]), 0) / 3;
  const versIntrus = trio.reduce((s, t) => s + distance(intrus, t), 0) / 3;
  return { dansTrio, versIntrus, rapport: versIntrus / Math.max(dansTrio, 0.001), ecart: versIntrus - dansTrio };
}

// Planche à éviter (calibré sur le catalogue d'octobre 2026). `signatures[0]`
// = intrus. Raisons possibles :
// - `trio-clone` : les 3 objets du jeu ont quasiment la même silhouette
//   (variantes recolorées d'un même objet) ;
// - `silhouette` : forme de l'intrus nettement différente d'un trio homogène ;
// - `structure` : idem sur silhouette + luminance.
export const SEUILS_INTRUS_VISIBLE = {
  trioClone: 0.03,
  silhouette: { rapport: 3, ecart: 0.1 },
  structure: { rapport: 2, ecart: 0.08 },
};
export function intrusVisible(signatures) {
  const [intrus, ...trio] = signatures;
  const sil = comparerTrio(distSilhouette, intrus, trio);
  const mix = comparerTrio(distMixte, intrus, trio);
  const S = SEUILS_INTRUS_VISIBLE;
  const raisons = [];
  // Icônes carrées opaques (WoW, LoL, Dota) : silhouettes toutes pleines,
  // seule la structure les distingue.
  const carrees = signatures.every((sig) => sig.silhouette.every((v) => v >= 0.9));
  if (!carrees && sil.dansTrio < S.trioClone) raisons.push("trio-clone");
  if (!carrees && sil.rapport >= S.silhouette.rapport && sil.ecart >= S.silhouette.ecart) raisons.push("silhouette");
  if (mix.rapport >= S.structure.rapport && mix.ecart >= S.structure.ecart) raisons.push("structure");
  return {
    raisons,
    rapportSilhouette: Number(sil.rapport.toFixed(2)),
    rapportStructure: Number(mix.rapport.toFixed(2)),
  };
}

export function analyserIcone(buffer) {
  const png = PNG.sync.read(buffer);
  const features = computeStyleFeatures(png);
  return {
    nettete: computeNetteteScore(png),
    styleAuto: detectStyle(features),
    ...features,
    signature: computeSignature(png),
  };
}
