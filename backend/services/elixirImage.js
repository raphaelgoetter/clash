// ============================================================
// elixirImage.js — Image des cartes aux enchères du jeu Élixir : les
// cartes de la manche en grand (illustration officielle, goutte d'élixir
// avec le coût, nom), puis celles de la manche suivante en plus petit.
// Même technique que pelemeleImage.js / zoomImage.js : SVG généré à la
// volée, rastérisé en PNG via @resvg/resvg-js.
//
// Rendu SANS état : la route (backend/server.js, /api/elixir/image) reçoit
// directement les clés de cartes dans l'URL. L'image d'une même liste de
// cartes ne change jamais, elle peut donc être mise en cache longtemps, et
// chaque manche a naturellement une URL différente.
//
// Illustrations : `iconUrls.medium` de l'API Clash Royale (fetchCards, même
// cache partagé "clashCardDefinitions" que lajustecarte.js), téléchargées
// puis intégrées en data URL (resvg ne charge aucune ressource distante).
// Les cartes spéciales n'ont pas d'illustration : carte dessinée en SVG.
//
// ⚠️ Police embarquée obligatoire (voir pelemeleImage.js) : aucune police
// système sur le runtime Vercel.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { fetchCards } from "./clashApi.js";
import { getOrSet } from "./cache.js";
import { readBlobFontPath } from "./blobAssets.js";
import { resolveCard, specialFromKey, SPECIALS } from "./elixirRules.js";

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
const BIG = { w: 170, gap: 22, drop: 50, font: 18, nameGap: 30 };
const SMALL = { w: 92, gap: 14, drop: 30, font: 12, nameGap: 20 };
const PADDING = 24;
const SECTION_GAP = 26;
const LABEL_SIZE = 16;

const BACKGROUND = "#1e1f22";
const TEXT_COLOR = "#f2f3f5";
const LABEL_COLOR = "#b5bac1";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Goutte d'élixir ─────────────────────────────────────────────────
// Dessinée dans un repère 100×116, mise à l'échelle par `size` (largeur).
// Partagée avec scripts/uploadElixirEmojis.js (emoji :elixir:).

let gradientSeq = 0;

export function elixirDropSvg(x, y, size, label = null) {
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

const SPECIAL_SYMBOLS = {
  [SPECIALS.joker.key]: "?",
  [SPECIALS.rage.key]: "x2",
  [SPECIALS.collecteur.key]: "+5",
};

function fitFont(text, width, max) {
  // Largeur moyenne d'un caractère Inter Bold ≈ 0,6 em
  return Math.min(max, Math.floor(width / (text.length * 0.6)));
}

function specialCardSvg(card, x, y, w, h) {
  const fontSize = Math.round(w * (SPECIAL_SYMBOLS[card.key].length > 1 ? 0.36 : 0.5));
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.08}" fill="#3b1a5c" stroke="#f0c040" stroke-width="${Math.max(2, w * 0.03)}"/>
  <rect x="${x + w * 0.07}" y="${y + w * 0.07}" width="${w * 0.86}" height="${h - w * 0.14}" rx="${w * 0.06}" fill="#5b2a8c"/>
  <text x="${x + w / 2}" y="${y + h * 0.56}" font-family="${FONT_FAMILY}" font-size="${fontSize}" text-anchor="middle" fill="#f0c040">${escapeXml(SPECIAL_SYMBOLS[card.key])}</text>`;
}

function cardSvg(card, dataUrl, x, y, size) {
  const h = Math.round(size.w * RATIO);
  const art = card.special
    ? specialCardSvg(card, x, y, size.w, h)
    : dataUrl
      ? `<svg x="${x}" y="${y}" width="${size.w}" height="${h}" viewBox="0 ${CROP_Y} ${ICON_W} ${CROP_H}"><image width="${ICON_W}" height="${ICON_H}" href="${dataUrl}"/></svg>`
      : `<rect x="${x}" y="${y}" width="${size.w}" height="${h}" rx="10" fill="#2b2d31"/>`;
  const name = card.special ? specialFromKey(card.key).fr : card.fr;
  const fontSize = fitFont(name, size.w + size.gap - 4, size.font);
  return `${art}
  ${elixirDropSvg(x - size.drop * 0.25, y - size.drop * 0.2, size.drop, card.minBid)}
  <text x="${x + size.w / 2}" y="${y + h + size.nameGap - 6}" font-family="${FONT_FAMILY}" font-size="${fontSize}" text-anchor="middle" fill="${TEXT_COLOR}">${escapeXml(name)}</text>`;
}

function rowWidth(count, size) {
  return count * size.w + (count - 1) * size.gap;
}

function rowHeight(size) {
  return Math.round(size.w * RATIO) + size.nameGap;
}

async function buildSvg(current, next) {
  const iconUrls = await loadIconUrls();
  const all = [...current, ...next];
  const dataUrls = new Map(
    await Promise.all(all.filter((c) => !c.special).map(async (c) => [c.key, await fetchDataUrl(iconUrls.get(c.key))])),
  );

  // Marge haute/gauche supplémentaire pour la goutte qui déborde du coin
  const top = PADDING + BIG.drop * 0.2;
  const left = PADDING + BIG.drop * 0.25;
  const width = Math.max(rowWidth(current.length, BIG), next.length ? rowWidth(next.length, SMALL) : 0) + left + PADDING;
  let y = top;
  const parts = current.map((c, i) => cardSvg(c, dataUrls.get(c.key), left + i * (BIG.w + BIG.gap), y, BIG));
  y += rowHeight(BIG);

  if (next.length) {
    y += SECTION_GAP;
    parts.push(
      `<text x="${PADDING}" y="${y}" font-family="${FONT_FAMILY}" font-size="${LABEL_SIZE}" fill="${LABEL_COLOR}">MANCHE SUIVANTE</text>`,
    );
    y += 14 + SMALL.drop * 0.2;
    const smallLeft = PADDING + SMALL.drop * 0.25;
    parts.push(...next.map((c, i) => cardSvg(c, dataUrls.get(c.key), smallLeft + i * (SMALL.w + SMALL.gap), y, SMALL)));
    y += rowHeight(SMALL);
  }
  const height = Math.round(y + PADDING - 8);

  return {
    width: Math.round(width),
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${Math.round(width)}" height="${height}" viewBox="0 0 ${Math.round(width)} ${height}" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" rx="16" fill="${BACKGROUND}"/>
${parts.join("\n")}
</svg>`,
  };
}

export async function rasterize(svg, width) {
  const fontPath = await readBlobFontPath(FONT_PATH);
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return Buffer.from(resvg.render().asPng());
}

// currentKeys / nextKeys : clés de cartes (normales ou spéciales). Les clés
// inconnues du catalogue sont ignorées (URL forgée). null si rien à
// afficher.
export async function getElixirCardsImage(currentKeys, nextKeys, catalog) {
  const resolve = (keys) => keys.map((k) => resolveCard(k, catalog)).filter(Boolean).slice(0, 6);
  const current = resolve(currentKeys);
  if (!current.length) return null;
  const { svg, width } = await buildSvg(current, resolve(nextKeys));
  return { buffer: await rasterize(svg, width), mimeType: "image/png" };
}
