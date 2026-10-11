// ============================================================
// quiestceImage.js — Images de Qui est-ce ? : la grille des cartes de la
// partie, publique (message officiel) ou personnelle (fiche d'enquête :
// cartes incompatibles grisées et barrées, cible éventuellement trouvée).
// Même technique que bangImage.js : SVG généré à la volée, rastérisé en PNG
// via @resvg/resvg-js ; dessin des cartes (illustration officielle) partagé
// via cardImage.js, sans goutte d'élixir.
//
// Rendu sans état : la grille et les cartes barrées sont passées dans l'URL
// (encodeGrille) ; l'URL change avec l'état, ce qui contourne le cache
// d'images de Discord.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { cardSvg, loadDataUrls, rasterize, RATIO_CARTE } from "./cardImage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARDS_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");

const COLS = 6;
const CARTE_W = 150;
const CARTE_H = Math.round(CARTE_W * RATIO_CARTE);
const LABEL_H = 26;
const GAP = 14;
const PADDING = 18;
const FONT_FAMILY = "Inter";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tronquer(nom, max) {
  return nom.length > max ? `${nom.slice(0, Math.max(1, max - 1))}…` : nom;
}

// Index des cartes (ordre de data/cardNames.json) : l'URL ne transporte que
// des numéros, bien plus courts que les noms.
let _cartes = null;
async function cartes() {
  if (!_cartes) _cartes = JSON.parse(await fs.readFile(CARDS_JSON_PATH, "utf8"));
  return _cartes;
}

export async function encodeGrille(grille, barrees = []) {
  const liste = await cartes();
  const index = new Map(liste.map((c, i) => [c.cardKey, i]));
  const b = new Set(barrees);
  const d = { c: grille.map((k) => index.get(k) ?? -1), b: grille.map((k) => (b.has(k) ? 1 : 0)).join("") };
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

// null si le paramètre est illisible.
export async function decodeGrille(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    const liste = await cartes();
    const entrees = (Array.isArray(d.c) ? d.c : []).slice(0, 60).map((i, n) => ({ carte: liste[Number(i)], barree: String(d.b ?? "")[n] === "1" }));
    if (!entrees.length || entrees.some((e) => !e.carte)) return null;
    return entrees;
  } catch {
    return null;
  }
}

async function buildGrilleSvg(entrees) {
  const rows = Math.ceil(entrees.length / COLS);
  const width = PADDING * 2 + COLS * CARTE_W + (COLS - 1) * GAP;
  const height = PADDING * 2 + rows * (CARTE_H + LABEL_H) + (rows - 1) * GAP;
  const dataUrls = await loadDataUrls(entrees.map((e) => ({ key: e.carte.cardKey })));
  const parts = entrees.map((e, i) => {
    const x = PADDING + (i % COLS) * (CARTE_W + GAP);
    const y = PADDING + Math.floor(i / COLS) * (CARTE_H + LABEL_H + GAP);
    const art = cardSvg({ key: e.carte.cardKey }, dataUrls.get(e.carte.cardKey), x, y, { w: CARTE_W, drop: 0 });
    const label = `<text x="${x + CARTE_W / 2}" y="${y + CARTE_H + 19}" font-family="${FONT_FAMILY}" font-size="13" text-anchor="middle" fill="${e.barree ? "#6b7080" : "#f2f3f5"}">${escapeXml(tronquer(e.carte.fr, 22))}</text>`;
    if (!e.barree) return art + label;
    const croix = `<path d="M${x + 22} ${y + 22} L${x + CARTE_W - 22} ${y + CARTE_H - 22} M${x + CARTE_W - 22} ${y + 22} L${x + 22} ${y + CARTE_H - 22}" stroke="#d63c3c" stroke-width="9" stroke-linecap="round"/>`;
    return `<g filter="url(#gris)" opacity="0.45">${art}</g>${croix}${label}`;
  });
  return {
    width,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs><filter id="gris"><feColorMatrix type="saturate" values="0"/></filter></defs>
  <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="#1e1f22"/>
  ${parts.join("\n")}
</svg>`,
  };
}

export async function getGrilleImage(entrees) {
  const { svg, width } = await buildGrilleSvg(entrees);
  return { buffer: await rasterize(svg, width), mimeType: "image/png" };
}
