// ============================================================
// bangImage.js — Images de Bang! :
//   - la main d'un joueur : les cartes seules, en grand, regroupées avec un
//     badge « ×N » pour les exemplaires d'une même carte ;
//   - le plateau d'avancement (message officiel) : jour, pioche, Rois ;
//   - l'illustration statique (présentation).
// Même technique que marioclashImage.js : SVG avec un `<image href="data:...">`
// de fond, rastérisé en PNG via @resvg/resvg-js. Dessin des cartes
// (illustration officielle) partagé via cardImage.js, sans goutte d'élixir
// (l'Élixir de Bang! est une ressource du jeu, pas le coût de la carte).
//
// ⚠️ Tapis en JPEG, jamais en WebP : resvg ne décode pas le WebP embarqué et
// échoue SILENCIEUSEMENT (fond absent) — voir marioclashImage.js.
// `bang-table.webp` (asset original) reste dans data/ pour archive.
//
// Assets servis depuis Vercel Blob (voir blobAssets.js), data/ n'est pas lu
// au runtime : relancer `npm run assets:upload-blob -- bang` après modification.
// ============================================================

import { readBlobAsset } from "./blobAssets.js";
import { cardSvg, loadDataUrls, rasterize, RATIO_CARTE } from "./cardImage.js";
import { CARTES } from "./bangRules.js";

const MAT_IMAGE_PATH = "bang/images/bang-table.jpg";
const ILLUSTRATION_IMAGE_PATH = "bang/images/bang-launch.webp";

// Dimensions natives de bang-table.jpg et zone intérieure du tapis (bleu,
// hors cadre doré) — à recalibrer si l'asset change.
const MAT_WIDTH = 1200;
const MAT_HEIGHT = 658;
const ZONE = { x: 120, y: 85, w: 960, h: 470 };
const RATIO = RATIO_CARTE;
const FONT_FAMILY = "Inter";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let matDataUrl = null;

async function loadMatDataUrl() {
  if (!matDataUrl) {
    const buffer = await readBlobAsset(MAT_IMAGE_PATH);
    matDataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }
  return matDataUrl;
}

function badgeSvg(x, y, texte, r = 17) {
  return `
  <circle cx="${x}" cy="${y}" r="${r}" fill="#f0c040" stroke="#4a2c00" stroke-width="3"/>
  <text x="${x}" y="${y + r * 0.35}" font-family="${FONT_FAMILY}" font-size="${r}" text-anchor="middle" fill="#2b1a00">${escapeXml(texte)}</text>`;
}

// Regroupe les exemplaires (ordre de CARTES, stable d'une vue à l'autre).
function grouper(ids) {
  return Object.keys(CARTES)
    .map((id) => ({ id, count: ids.filter((x) => x === id).length }))
    .filter((e) => e.count > 0);
}

// Main d'un joueur : les cartes seules, en grand, sur fond transparent
// (un exemplaire par carte, badge ×N), au plus MAIN_COLS par ligne.
const MAIN_CARTE = 200;
const MAIN_GAP = 18;
const MAIN_COLS = 5;
const MAIN_PADDING = 10;

async function buildMainSvg(ids) {
  const entrees = grouper(ids).map((e) => ({ ...e, card: { key: CARTES[e.id].cardKey } }));
  const cols = Math.max(1, Math.min(MAIN_COLS, entrees.length));
  const rows = Math.max(1, Math.ceil(entrees.length / cols));
  const h = Math.round(MAIN_CARTE * RATIO);
  const width = MAIN_PADDING * 2 + cols * MAIN_CARTE + (cols - 1) * MAIN_GAP;
  const height = MAIN_PADDING * 2 + rows * h + (rows - 1) * MAIN_GAP;
  const dataUrls = await loadDataUrls(entrees.map((e) => e.card));
  const parts = entrees.map((e, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, entrees.length - row * cols);
    const x0 = (width - (inRow * MAIN_CARTE + (inRow - 1) * MAIN_GAP)) / 2;
    const x = x0 + (i % cols) * (MAIN_CARTE + MAIN_GAP);
    const y = MAIN_PADDING + row * (h + MAIN_GAP);
    const badge = e.count > 1 ? badgeSvg(x + MAIN_CARTE - 14, y + h - 14, `×${e.count}`, 22) : "";
    return cardSvg(e.card, dataUrls.get(e.card.key), x, y, { w: MAIN_CARTE, drop: 0 }) + badge;
  });
  return {
    width,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${parts.join("\n")}
</svg>`,
  };
}

// Main d'un joueur : identifiants de cartes Bang! passés dans l'URL (les
// inconnus sont ignorés), rendu sans état. null si la main est vide.
export async function getMainImage(ids) {
  const valides = ids.filter((id) => CARTES[id]).slice(0, 60);
  if (!valides.length) return null;
  const { svg, width } = await buildMainSvg(valides);
  return { buffer: await rasterize(svg, width), mimeType: "image/png" };
}

// ── Plateau d'avancement ─────────────────────────────────────────────
// Sur le tapis : le jour en bandeau, la pioche à gauche (pile dont la
// hauteur suit le nombre de cartes, Gobelins explosifs restants), les
// joueurs à droite (avatar sur anneau doré et nombre de cartes en main pour
// les survivants, avatar gris barré pour les éliminés).

const GOLD = "#f0c040";

// Avatars des joueurs : 12 créatures « Clay » de DiceBear (CC0, domaine
// public : https://www.dicebear.com/styles/clay/), data/bang/avatars/.
export const NB_AVATARS = 12;
const avatarCache = new Map();

async function avatarDataUrl(index) {
  const i = ((index % NB_AVATARS) + NB_AVATARS) % NB_AVATARS;
  if (!avatarCache.has(i)) {
    const buffer = await readBlobAsset(`bang/avatars/clay-${String(i + 1).padStart(2, "0")}.png`);
    avatarCache.set(i, `data:image/png;base64,${buffer.toString("base64")}`);
  }
  return avatarCache.get(i);
}

let clipSeq = 0;

// Médaillon rond : avatar sur anneau doré ; joueur éliminé : avatar en
// gris, anneau gris et croix rouge.
function avatarSvg(cx, cy, size, dataUrl, vivant) {
  const r = size / 2;
  const id = `av${clipSeq++}`;
  const croix = vivant
    ? ""
    : `<path d="M${cx - r * 0.62} ${cy - r * 0.62} L${cx + r * 0.62} ${cy + r * 0.62} M${cx + r * 0.62} ${cy - r * 0.62} L${cx - r * 0.62} ${cy + r * 0.62}" stroke="#d63c3c" stroke-width="${Math.max(4, size * 0.09)}" stroke-linecap="round"/>`;
  return `
  <clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
  <g opacity="${vivant ? 1 : 0.7}">
    <image x="${cx - r * 1.2}" y="${cy - r * 1.15}" width="${size * 1.2}" height="${size * 1.2}" href="${dataUrl}" clip-path="url(#${id})"${vivant ? "" : ' filter="url(#gris)"'}/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${vivant ? GOLD : "#6b7080"}" stroke-width="${Math.max(3, size * 0.06)}"/>
  </g>
  ${croix}`;
}

// Couronne (emblème du dos des cartes de la pioche).
function couronneSvg(cx, cy, size, vivant) {
  const s = size / 100;
  const fill = vivant ? "url(#or)" : "#6b7080";
  const stroke = vivant ? "#7a4a00" : "#3a3d48";
  const croix = vivant
    ? ""
    : `<path d="M8 8 L92 72 M92 8 L8 72" stroke="#d63c3c" stroke-width="11" stroke-linecap="round"/>`;
  return `
  <g transform="translate(${cx - size / 2} ${cy - size * 0.4}) scale(${s})" opacity="${vivant ? 1 : 0.75}">
    <path d="M6 70 L10 18 L32 42 L50 6 L68 42 L90 18 L94 70 Z" fill="${fill}" stroke="${stroke}" stroke-width="5" stroke-linejoin="round"/>
    <rect x="6" y="64" width="88" height="14" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="5"/>
    <circle cx="50" cy="40" r="7" fill="${vivant ? "#d63c3c" : "#4a4d58"}"/>
    ${croix}
  </g>`;
}

function texte(x, y, contenu, { size = 18, fill = "#ffffff", anchor = "middle", opacity = 1 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" fill="${fill}" opacity="${opacity}" stroke="#0b1a3a" stroke-width="${Math.max(2, size / 7)}" paint-order="stroke">${escapeXml(contenu)}</text>`;
}

function tronquer(nom, max) {
  return nom.length > max ? `${nom.slice(0, Math.max(1, max - 1))}…` : nom;
}

// Pseudo sur une ou deux lignes de `max` caractères : coupe à un espace,
// « _ » ou « - » (sinon au milieu du mot), seconde ligne tronquée si besoin.
function lignesPseudo(nom, max) {
  if (nom.length <= max) return [nom];
  const separateur = Math.max(...[" ", "_", "-"].map((c) => nom.lastIndexOf(c, max - 1)));
  const coupe = separateur > max / 3 ? separateur + (nom[separateur] === " " ? 0 : 1) : max;
  return [nom.slice(0, coupe).trim(), tronquer(nom.slice(coupe).trim(), max)];
}

// Pile de dos de cartes, centrée en (cx, bas).
function pileSvg(cx, bas, nbCartes) {
  const w = 76;
  const h = Math.round(w * 1.3);
  const couches = nbCartes ? Math.min(10, Math.max(1, Math.ceil(nbCartes / 5))) : 0;
  const parts = [];
  for (let i = 0; i < couches; i++) {
    const x = cx - w / 2 + i * 2;
    const y = bas - h - i * 4;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="#8e1f1f" stroke="${GOLD}" stroke-width="3"/>`);
    parts.push(`<rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="${h - 16}" rx="6" fill="none" stroke="${GOLD}" stroke-width="2" opacity="0.6"/>`);
  }
  if (!couches) {
    parts.push(`<rect x="${cx - w / 2}" y="${bas - h}" width="${w}" height="${h}" rx="12" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="10 8" opacity="0.5"/>`);
  } else {
    const top = bas - h - (couches - 1) * 4;
    parts.push(couronneSvg(cx + (couches - 1) * 2, top + h / 2, 34, true));
  }
  return { svg: parts.join("\n") };
}

// `etat` : { jour, duree, pioche, bombes, esprits, rois: [{ nom, cartes, vivant }] }
async function buildTableSvg(etat) {
  const mat = await loadMatDataUrl();
  const parts = [];
  const vivants = etat.rois.filter((r) => r.vivant).length;

  // Bandeau
  parts.push(texte(MAT_WIDTH / 2, ZONE.y + 52, `JOUR ${etat.jour}/${etat.duree}`, { size: 38, fill: GOLD }));
  parts.push(texte(MAT_WIDTH / 2, ZONE.y + 84, `${vivants} joueur${vivants > 1 ? "s" : ""} en vie sur ${etat.rois.length}`, { size: 20 }));

  // Pioche
  const piocheX = ZONE.x + 95;
  const pile = pileSvg(piocheX, ZONE.y + 300, etat.pioche);
  parts.push(pile.svg);
  parts.push(texte(piocheX, ZONE.y + 330, `${etat.pioche} carte${etat.pioche > 1 ? "s" : ""}`, { size: 20 }));
  // Gobelins explosifs puis Esprits de guérison restant dans la pioche
  const compteurs = [
    { carte: { key: CARTES.bombe.cardKey }, n: etat.bombes, fill: "#ff8a6a" },
    { carte: { key: CARTES.esprit.cardKey }, n: etat.esprits, fill: "#7be08a" },
  ];
  const urls = await loadDataUrls(compteurs.map((c) => c.carte));
  const bw = 38;
  compteurs.forEach(({ carte, n, fill }, i) => {
    const y = ZONE.y + 344 + i * (bw * RATIO + 8);
    parts.push(cardSvg(carte, urls.get(carte.key), piocheX - bw - 4, y, { w: bw, drop: 0 }));
    parts.push(texte(piocheX + 2, y + (bw * RATIO) / 2 + 8, `× ${n}`, { size: 22, fill, anchor: "start" }));
  });

  // Rois
  const zone = { x: ZONE.x + 200, y: ZONE.y + 110, w: ZONE.w - 210, h: ZONE.h - 125 };
  const n = etat.rois.length;
  if (!n) {
    parts.push(texte(zone.x + zone.w / 2, zone.y + zone.h / 2, "En attente des premiers joueurs…", { size: 26, opacity: 0.85 }));
  } else {
    const cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(n * 1.6))));
    const rows = Math.ceil(n / cols);
    const cw = zone.w / cols;
    const ch = Math.min(120, zone.h / rows);
    const taille = Math.min(68, ch * 0.5);
    const avatars = await Promise.all(Array.from({ length: NB_AVATARS }, (_, i) => avatarDataUrl(i)));
    const police = Math.max(12, Math.min(18, ch * 0.16));
    const y0 = zone.y + (zone.h - rows * ch) / 2;
    etat.rois.forEach((r, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const cx = zone.x + (zone.w - inRow * cw) / 2 + (i % cols) * cw + cw / 2;
      const cy = y0 + row * ch + taille * 0.5;
      parts.push(avatarSvg(cx, cy, taille, avatars[r.avatar % NB_AVATARS], r.vivant));
      if (r.vivant && r.cartes) parts.push(badgeSvg(cx + taille * 0.42, cy + taille * 0.36, String(r.cartes), Math.max(11, taille * 0.24)));
      lignesPseudo(r.nom, Math.floor((cw - 8) / (police * 0.6))).forEach((ligne, k) => {
        parts.push(texte(cx, cy + taille * 0.5 + police + 6 + k * (police + 2), ligne, { size: police, opacity: r.vivant ? 1 : 0.6 }));
      });
    });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${MAT_WIDTH}" height="${MAT_HEIGHT}" viewBox="0 0 ${MAT_WIDTH} ${MAT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="gris"><feColorMatrix type="saturate" values="0"/></filter>
    <linearGradient id="or" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe27a"/>
      <stop offset="1" stop-color="#e09a1a"/>
    </linearGradient>
  </defs>
  <image x="0" y="0" width="${MAT_WIDTH}" height="${MAT_HEIGHT}" href="${mat}"/>
  ${parts.join("\n")}
</svg>`;
}

// Plateau passé dans l'URL (base64url d'un JSON compact, voir
// encodeTable), rendu sans état. null si le paramètre est illisible.
export function decodeTable(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    const nombre = (x) => Math.max(0, Math.min(999, Number(x) || 0));
    return {
      jour: nombre(d.j),
      duree: nombre(d.d),
      pioche: nombre(d.p),
      bombes: nombre(d.b),
      esprits: nombre(d.e),
      rois: (Array.isArray(d.r) ? d.r : []).slice(0, 40).map(([nom, cartes, vivant, avatar]) => ({ nom: String(nom).slice(0, 40), cartes: nombre(cartes), vivant: !!vivant, avatar: nombre(avatar) })),
    };
  } catch {
    return null;
  }
}

export function encodeTable({ jour, duree, pioche, bombes, esprits, rois }) {
  const d = { j: jour, d: duree, p: pioche, b: bombes, e: esprits, r: rois.map((r) => [r.nom, r.cartes, r.vivant ? 1 : 0, r.avatar ?? 0]) };
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

export async function getTableImage(etat) {
  return { buffer: await rasterize(await buildTableSvg(etat), MAT_WIDTH), mimeType: "image/png" };
}

let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
