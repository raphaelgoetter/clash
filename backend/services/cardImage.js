// ============================================================
// cardImage.js — Rendu des cartes Clash Royale (illustration officielle,
// goutte d'élixir facultative) pour les jeux de cartes (Bang!, voir
// bangImage.js). Même technique que pelemeleImage.js / zoomImage.js : SVG
// généré à la volée, rastérisé en PNG via @resvg/resvg-js.
//
// Illustrations : `iconUrls.medium` de l'API Clash Royale (fetchCards, même
// cache partagé "clashCardDefinitions" que lajustecarte.js), téléchargées
// puis intégrées en data URL (resvg ne charge aucune ressource distante).
//
// ⚠️ Police embarquée obligatoire (voir pelemeleImage.js) : aucune police
// système sur le runtime Vercel.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { fetchCards } from "./clashApi.js";
import { getOrSet } from "./cache.js";
import { readBlobFontPath } from "./blobAssets.js";

const FONT_PATH = "fonts/Inter-Bold.ttf";
const FONT_FAMILY = "Inter";
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;

// Illustrations officielles 285×420, dont seule la bande y 67→387 est
// opaque (marges transparentes en haut et en bas) : on recadre dessus
const ICON_W = 285;
const ICON_H = 420;
const CROP_Y = 67;
const CROP_H = 320;
const RATIO = CROP_H / ICON_W;
export const RATIO_CARTE = RATIO;

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Goutte d'élixir ─────────────────────────────────────────────────
// Dessinée dans un repère 100×116, mise à l'échelle par `size` (largeur).

let gradientSeq = 0;

function elixirDropSvg(x, y, size, label = null) {
  const id = `elx${gradientSeq++}`;
  const scale = size / 100;
  const text = label == null
    ? ""
    : `<text x="50" y="86" font-family="${FONT_FAMILY}" font-size="${String(label).length > 1 ? 42 : 52}" text-anchor="middle" fill="#ffffff" stroke="#4a0a63" stroke-width="5" paint-order="stroke">${escapeXml(label)}</text>`;
  return `
  <g transform="translate(${x} ${y}) scale(${scale})">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="#ff7bf2"/>
        <stop offset="0.55" stop-color="#d43ce0"/>
        <stop offset="1" stop-color="#7a14b8"/>
      </linearGradient>
    </defs>
    <path d="M50 2 C50 2 94 50 94 74 A44 42 0 1 1 6 74 C6 50 50 2 50 2 Z" fill="url(#${id})" stroke="#4a0a63" stroke-width="5"/>
    <ellipse cx="34" cy="60" rx="9" ry="16" fill="#ffffff" opacity="0.45" transform="rotate(25 34 60)"/>
    ${text}
  </g>`;
}

// ── Illustrations ───────────────────────────────────────────────────

const ICON_CACHE = new Map();

async function loadIconUrls() {
  const { value } = await getOrSet("clashCardDefinitions", () => fetchCards(), CARD_DEF_CACHE_TTL);
  return new Map((Array.isArray(value) ? value : []).map((c) => [c.name, c.iconUrls?.medium]));
}

async function fetchDataUrl(url) {
  if (!url) return null;
  if (ICON_CACHE.has(url)) return ICON_CACHE.get(url);
  const res = await fetch(url);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const dataUrl = `data:${res.headers.get("content-type") || "image/png"};base64,${buffer.toString("base64")}`;
  ICON_CACHE.set(url, dataUrl);
  return dataUrl;
}

// ── Cartes ──────────────────────────────────────────────────────────

export function cardSvg(card, dataUrl, x, y, size) {
  const h = Math.round(size.w * RATIO);
  const art = dataUrl
      ? `<svg x="${x}" y="${y}" width="${size.w}" height="${h}" viewBox="0 ${CROP_Y} ${ICON_W} ${CROP_H}"><image width="${ICON_W}" height="${ICON_H}" href="${dataUrl}"/></svg>`
      : `<rect x="${x}" y="${y}" width="${size.w}" height="${h}" rx="10" fill="#2b2d31"/>`;
  if (!size.drop) return art;
  return `${art}
  ${elixirDropSvg(x - size.drop * 0.25, y - size.drop * 0.2, size.drop, card.minBid)}`;
}

export async function loadDataUrls(cards) {
  const iconUrls = await loadIconUrls();
  return new Map(
    await Promise.all(cards.map(async (c) => [c.key, await fetchDataUrl(iconUrls.get(c.key))])),
  );
}

export async function rasterize(svg, width) {
  const fontPath = await readBlobFontPath(FONT_PATH);
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return Buffer.from(resvg.render().asPng());
}
