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
//
// Illustration de présentation servie depuis Vercel Blob (voir
// blobAssets.js), data/ n'est pas lu au runtime : relancer
// `npm run assets:upload-blob -- quiestce` après modification.
// ============================================================

import fs from "fs/promises";
import zlib from "zlib";
import path from "path";
import { fileURLToPath } from "url";
import { cardSvg, loadDataUrls, rasterize, RATIO_CARTE } from "@clash/clash-royale/cardImage.js";
import { readBlobAsset } from "@clash/commun/blobAssets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARDS_JSON_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");

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

// Index des cartes (ordre de jeux/data/cardNames.json) : l'URL ne transporte que
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

const ILLUSTRATION_IMAGE_PATH = "quiestce/images/quiestce-launch.webp";
let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}

// ── Tableau de chasse (message officiel) ─────────────────────────────
// Pensé pour mobile (image réduite à ~360 px de large par Discord) : deux
// colonnes de vignettes horizontales, dans l'ordre du classement, avec peu
// d'informations en gros : rang, avatar Discord (créature « Clay » de
// Bang! à défaut), pseudo, points suivis de deux pictos (viseur : cibles
// démasquées ; masque : fois démasqué), flèche vers l'avatar de sa cible ;
// voile de brume sous Brouillard. Aucune carte secrète n'y figure.
// État passé dans l'URL, compressé (deflate + base64url, voir
// encodeChasse) pour rester sous la limite d'URL d'image de Discord.


const CH = { cols: 2, w: 540, h: 128, gap: 16, pad: 24 };
const GOLD = "#f0c040";
const NB_CLAY = 12;
const avatarCache = new Map();

async function dataUrlDepuis(url, lire) {
  if (!avatarCache.has(url)) {
    avatarCache.set(
      url,
      lire()
        .then((buffer) => `data:image/png;base64,${buffer.toString("base64")}`)
        .catch(() => {
          avatarCache.delete(url);
          return null;
        }),
    );
  }
  return avatarCache.get(url);
}

function clayDataUrl(i) {
  const n = String((((i % NB_CLAY) + NB_CLAY) % NB_CLAY) + 1).padStart(2, "0");
  return dataUrlDepuis(`clay-${n}`, () => readBlobAsset(`bang/avatars/clay-${n}.png`));
}

// Avatar Discord (id/hash validés : l'URL vient d'un paramètre public)
async function avatarDataUrl(av, i) {
  const m = /^(\d{5,22})\/((?:a_)?[0-9a-f]{32})$/.exec(String(av ?? ""));
  if (m) {
    const url = `https://cdn.discordapp.com/avatars/${m[1]}/${m[2]}.png?size=128`;
    const d = await dataUrlDepuis(url, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    if (d) return d;
  }
  return clayDataUrl(i);
}

// `joueurs` : [{ nom, points, avatar ("id/hash" ou null), cible (index ou
// -1), chasseurs, questions, demasque, brouillard, tombe, trouvees }]
export function encodeChasse(joueurs) {
  const d = joueurs.map((j) => [j.nom, j.points, j.avatar ?? 0, j.cible, j.chasseurs, j.questions, j.demasque, (j.brouillard ? 1 : 0) | (j.tombe ? 2 : 0), j.trouvees ?? 0]);
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(d), "utf8")).toString("base64url");
}

// null si le paramètre est illisible.
export function decodeChasse(param) {
  try {
    const d = JSON.parse(zlib.inflateRawSync(Buffer.from(String(param), "base64url"), { maxOutputLength: 20000 }).toString("utf8"));
    if (!Array.isArray(d) || !d.length) return null;
    const nombre = (x, min = 0) => Math.max(min, Math.min(999, Math.trunc(Number(x)) || 0));
    return d.slice(0, 24).map(([nom, points, avatar, cible, chasseurs, questions, demasque, f, trouvees]) => ({
      nom: String(nom ?? "?").slice(0, 40),
      points: nombre(points, -999),
      avatar: typeof avatar === "string" ? avatar : null,
      cible: Number.isInteger(cible) && cible >= 0 && cible < d.length ? cible : -1,
      chasseurs: nombre(chasseurs),
      questions: nombre(questions),
      demasque: nombre(demasque),
      trouvees: nombre(trouvees),
      brouillard: !!(f & 1),
      tombe: !!(f & 2),
    }));
  } catch {
    return null;
  }
}

function texteSvg(x, y, contenu, { size = 15, fill = "#f2f3f5", anchor = "middle", weight = 400 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escapeXml(contenu)}</text>`;
}

let clipSeq = 0;
function medaillon(cx, cy, r, dataUrl, { anneau = GOLD, gris = false } = {}) {
  const id = `qa${clipSeq++}`;
  return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#3a3d48"/>
  ${dataUrl ? `<image x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" href="${dataUrl}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"${gris ? ' filter="url(#gris)"' : ""}/>` : ""}
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${anneau}" stroke-width="${Math.max(2, r * 0.09)}"/>`;
}

// Viseur doré (cibles démasquées) et masque rouge (fois démasqué), centrés en (cx, cy)
function viseur(cx, cy, r, couleur) {
  return `<g stroke="${couleur}" stroke-width="3.5" fill="none" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="${r}"/><path d="M${cx} ${cy - r - 5} V${cy - r + 5} M${cx} ${cy + r - 5} V${cy + r + 5} M${cx - r - 5} ${cy} H${cx - r + 5} M${cx + r - 5} ${cy} H${cx + r + 5}"/></g><circle cx="${cx}" cy="${cy}" r="3" fill="${couleur}"/>`;
}

function masque(cx, cy, w, couleur) {
  const h = w * 0.55;
  const x = cx - w / 2;
  const y = cy - h / 2;
  return `<path d="M${x} ${y + h * 0.15} Q${cx} ${y - h * 0.25} ${x + w} ${y + h * 0.15} Q${x + w * 1.02} ${y + h * 0.95} ${x + w * 0.68} ${y + h} Q${cx} ${y + h * 0.7} ${x + w * 0.32} ${y + h} Q${x - w * 0.02} ${y + h * 0.95} ${x} ${y + h * 0.15} Z" fill="${couleur}"/><ellipse cx="${x + w * 0.3}" cy="${y + h * 0.48}" rx="${w * 0.11}" ry="${h * 0.16}" fill="#2b2d31"/><ellipse cx="${x + w * 0.7}" cy="${y + h * 0.48}" rx="${w * 0.11}" ry="${h * 0.16}" fill="#2b2d31"/>`;
}

function brume(x, y, w, h) {
  const vagues = [0.32, 0.68]
    .map((k) => `<path d="M${x + 14} ${y + h * k} q ${w / 12} -10 ${w / 6} 0 t ${w / 6} 0 t ${w / 6} 0 t ${w / 6} 0 t ${w / 6} 0 t ${w / 6 - 28} 0" stroke="#ffffff" stroke-width="4" fill="none" opacity="0.3"/>`)
    .join("");
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#9fb0c8" opacity="0.28"/>${vagues}`;
}

async function buildChasseSvg(joueurs) {
  const n = joueurs.length;
  const cols = Math.min(CH.cols, n);
  const rows = Math.ceil(n / cols);
  const width = CH.pad * 2 + cols * CH.w + (cols - 1) * CH.gap;
  const height = CH.pad * 2 + rows * CH.h + (rows - 1) * CH.gap;
  const avatars = await Promise.all(joueurs.map((j, i) => avatarDataUrl(j.avatar, i)));
  const parts = [];
  // Colonne par colonne : les premiers à gauche, lecture de haut en bas
  joueurs.forEach((j, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = CH.pad + col * (CH.w + CH.gap);
    const y = CH.pad + row * (CH.h + CH.gap);
    const cy = y + CH.h / 2;
    const podium = i < 3 && j.points > 0;
    parts.push(`<rect x="${x}" y="${y}" width="${CH.w}" height="${CH.h}" rx="18" fill="#2b2d31" stroke="${i === 0 && podium ? GOLD : "#3a3d48"}" stroke-width="${i === 0 && podium ? 4 : 2}"/>`);
    parts.push(texteSvg(x + 34, cy + 13, `${i + 1}`, { size: 36, fill: podium ? GOLD : "#9aa0ad", weight: 700 }));
    parts.push(medaillon(x + 116, cy, 46, avatars[i], { anneau: podium ? GOLD : "#8a8f9c" }));
    parts.push(texteSvg(x + 180, cy - 8, tronquer(j.nom, 11), { size: 34, anchor: "start", weight: 700 }));
    const pts = `${j.points} pt${Math.abs(j.points) > 1 ? "s" : ""}`;
    if (j.brouillard) parts.push(brume(x, y, CH.w, CH.h));
    parts.push(texteSvg(x + 180, cy + 36, pts, { size: 30, fill: GOLD, anchor: "start", weight: 700 }));
    // Pictos après les points (largeur estimée du texte des points)
    const px = x + 180 + pts.length * 14.5 + 22;
    parts.push(viseur(px, cy + 26, 10, GOLD), texteSvg(px + 19, cy + 36, `${j.trouvees}`, { size: 28, anchor: "start", weight: 700 }));
    parts.push(masque(px + 60, cy + 26, 30, "#ff6b6f"), texteSvg(px + 78, cy + 36, `${j.demasque}`, { size: 28, anchor: "start", weight: 700 }));
    // Brouillard : pastille sur le bas de l'avatar
    if (j.brouillard) parts.push(`<rect x="${x + 116 - 74}" y="${cy + 26}" width="148" height="34" rx="17" fill="#dfe6f2"/>${texteSvg(x + 116, cy + 51, "Brouillard", { size: 24, fill: "#1e1f22", weight: 700 })}`);
    // Cible
    const tx = x + CH.w - 50;
    parts.push(texteSvg(tx - 56, cy + 13, "→", { size: 40, fill: "#9aa0ad", weight: 700 }));
    if (j.cible >= 0) parts.push(medaillon(tx, cy, 38, avatars[j.cible], { anneau: "#ff8a8d" }));
    else parts.push(`<circle cx="${tx}" cy="${cy}" r="38" fill="none" stroke="#5c606b" stroke-width="3" stroke-dasharray="8 6"/>${texteSvg(tx, cy + 13, "?", { size: 36, fill: "#6b7080", weight: 700 })}`);
  });
  return {
    width,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs><filter id="gris"><feColorMatrix type="saturate" values="0"/></filter></defs>
  <rect x="0" y="0" width="${width}" height="${height}" rx="22" fill="#1e1f22"/>
  ${parts.join("\n  ")}
</svg>`,
  };
}

export async function getChasseImage(joueurs) {
  const { svg, width } = await buildChasseSvg(joueurs);
  return { buffer: await rasterize(svg, width), mimeType: "image/png" };
}
