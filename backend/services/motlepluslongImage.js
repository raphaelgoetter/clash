// ============================================================
// motlepluslongImage.js — Synthèse de l'image "chevalet de Scrabble" pour Le
// Mot le Plus Long : les 12 lettres tirées, affichées en tuiles (fond
// crème, lettre centrée, valeur Scrabble FR en coin) plutôt qu'en texte brut
// dans l'embed. Même technique que zoomImage.js/goblinhuntersImage.js : SVG
// généré à la volée, rastérisé en PNG via @resvg/resvg-js — aucun asset
// externe nécessaire (pas de pack d'images de tuiles à fournir).
//
// Contrairement à Zoom/Frame (image figée par gameId, anti-spoiler), ce
// rendu reflète TOUJOURS le tirage de la manche EN COURS : les lettres sont
// publiques dès la publication, aucune notion de secret à protéger ici. Même
// principe que goblinhuntersImage.js pour le paramètre de cache-buster côté
// route (voir backend/server.js) : sert uniquement à invalider le cache
// Discord entre deux manches, pas une clé de lookup.
//
// ⚠️ Police embarquée OBLIGATOIRE (data/fonts/Inter-Variable.ttf, licence
// SIL OFL — voir data/fonts/OFL.txt) : constaté en production sur Vercel
// que resvg-js n'a AUCUNE police système disponible sur le runtime
// serverless (contrairement à une machine de dev locale, où "Inter,
// system-ui, sans-serif" retombe silencieusement sur une police système
// présente) — le texte ne s'affichait pas du tout (tuiles vides), sans
// erreur levée, seule une vérification VISUELLE du PNG produit l'a révélé
// (même piège que documenté dans goblinhuntersImage.js pour le format
// d'image). `loadSystemFonts: false` + `fontFiles` : jamais compter sur une
// police système ici. Police VARIABLE (un seul fichier, plusieurs graisses)
// mais resvg n'interpole PAS l'axe de graisse via font-weight en SVG —
// constaté empiriquement (aucune différence visuelle entre 400 et 900) —
// donc `font-weight` n'est plus utilisé ci-dessous, la graisse rendue est
// toujours celle de l'instance par défaut de la police.
// ============================================================

import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { readState } from "./motlepluslong.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.resolve(__dirname, "..", "..", "data", "fonts", "Inter-Variable.ttf");
const FONT_FAMILY = "Inter";

const TILE = 90;
const GAP = 12;
const COLS = 6;
const ROWS = 2;
const PADDING = 20;
const WIDTH = COLS * TILE + (COLS - 1) * GAP + PADDING * 2;
const HEIGHT = ROWS * TILE + (ROWS - 1) * GAP + PADDING * 2;

const TILE_FILL = "#f4e4bc";
const TILE_STROKE = "#a9803f";
const LETTER_COLOR = "#3b2a1a";
const POINT_COLOR = "#7a5c2e";

// Valeurs officielles du Scrabble français — purement décoratif (aucun
// impact sur le score du jeu, qui reste le nombre de lettres du mot trouvé),
// juste pour coller à l'esthétique "tuile de Scrabble" demandée.
const FR_SCRABBLE_POINTS = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 10, L: 1,
  M: 2, N: 1, O: 1, P: 3, Q: 8, R: 1, S: 1, T: 1, U: 1, V: 4, W: 10, X: 10,
  Y: 10, Z: 10,
};

function buildTileSvg(letter, x, y) {
  const cx = x + TILE / 2;
  const cy = y + TILE / 2;
  const points = FR_SCRABBLE_POINTS[letter] ?? "";
  return `
    <rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" rx="10" ry="10" fill="${TILE_FILL}" stroke="${TILE_STROKE}" stroke-width="2"/>
    <text x="${cx}" y="${cy + 15}" font-family="${FONT_FAMILY}" font-size="44" text-anchor="middle" fill="${LETTER_COLOR}">${letter}</text>
    <text x="${x + TILE - 10}" y="${y + TILE - 8}" font-family="${FONT_FAMILY}" font-size="13" text-anchor="end" fill="${POINT_COLOR}">${points}</text>`;
}

function buildRackSvg(letters) {
  const tiles = letters.map((letter, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PADDING + col * (TILE + GAP);
    const y = PADDING + row * (TILE + GAP);
    return buildTileSvg(letter, x, y);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
${tiles.join("\n")}
</svg>`;
}

async function rasterize(svg) {
  // Pas de `background` : fond transparent, les tuiles flottent sur le fond
  // sombre de l'embed Discord plutôt qu'un rectangle plein disgracieux.
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: WIDTH },
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  const pngData = resvg.render();
  return { buffer: Buffer.from(pngData.asPng()), mimeType: "image/png" };
}

export async function getMotLePlusLongRackImage() {
  const state = await readState();
  if (!state?.letters) return null;
  return rasterize(buildRackSvg(state.letters));
}
