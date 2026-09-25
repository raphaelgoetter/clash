// ============================================================
// goblinhuntersImage.js — Synthèse de l'image du plateau pour Goblin
// Hunters : compose le décor statique (data/goblinhunters/images/board.jpg)
// avec les pastilles des joueurs vivants positionnées par lieu, et une
// bande de pastilles grisées pour les joueurs éliminés (camp révélé,
// jamais le rôle précis). Même technique que zoomImage.js : SVG avec un
// `<image href="data:...">` de fond, rastérisé en PNG via @resvg/resvg-js.
//
// ⚠️ JPEG, ni WebP ni AVIF : les deux ont été testés et échouent tous les
// deux SILENCIEUSEMENT (aucune exception levée, l'image de fond reste
// simplement absente du rendu — seule une vérification VISUELLE du PNG
// produit l'a révélé, jamais fier de la seule absence d'exception).
// resvg/usvg ne sait décoder que PNG/JPEG/GIF en `<image>` embarqué. PNG
// fonctionne mais pèse ~2,3 Mo (bien trop gros pour un asset de repo) ;
// JPEG (recompressé manuellement par l'utilisateur après une première passe
// à qualité 85 via `sips -s format jpeg -s formatOptions 85`, ~273 Ko
// actuellement) sans artefact visible, c'est le format retenu. `board.webp`
// (asset original fourni) est conservé pour archive uniquement, jamais
// utilisé au rendu.
//
// ⚠️ Les pastilles des joueurs VIVANTS ne doivent JAMAIS être colorées par
// camp NI porter d'initiale (ça fuiterait le secret du camp, et l'identité
// donnerait publiquement l'info que Arène/Tour de Guet/Clairière ne livrent
// qu'en privé à celui qui agit) — couleur neutre unique, anonyme. Seuls les
// joueurs éliminés (camp déjà révélé publiquement) affichent une couleur de
// camp et leur initiale, dans la bande grisée en bas de l'image.
//
// ⚠️ Police embarquée OBLIGATOIRE (fonts/Inter-Bold.ttf), même piège que
// documenté dans pelemeleImage.js : resvg-js n'a aucune police système
// disponible sur le runtime serverless Vercel (contrairement à une machine
// de dev locale, où "Inter, system-ui, sans-serif" retombe silencieusement
// sur une police système présente) — les initiales des pions ne
// s'afficheraient pas du tout en production, sans erreur levée. `font:
// { fontFiles, loadSystemFonts: false }` dans rasterize() ci-dessous.
//
// board.jpg/end.webp/start.webp et la police sont servis depuis Vercel Blob
// (voir blobAssets.js) et non plus depuis data/ — évite qu'ils soient
// réembarqués dans le bundle de fonction à chaque déploiement. Les fichiers
// sources restent dans data/goblinhunters/images/ (régénérables/éditables),
// mais data/ n'est plus lu au runtime.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { readState, loadGoblinHuntersConfig } from "./goblinhunters.js";
import { readBlobAsset, readBlobFontPath } from "./blobAssets.js";

const BOARD_IMAGE_PATH = "goblinhunters/images/board.jpg";
const END_IMAGE_PATH = "goblinhunters/images/end.webp";
const START_IMAGE_PATH = "goblinhunters/images/start.webp";
const FONT_PATH = "fonts/Inter-Bold.ttf";
const FONT_FAMILY = "Inter";

// Dimensions natives de board.jpg (voir data/goblinhunters/images/board.jpg)
// — à ajuster si l'asset est remplacé par une image de résolution différente.
const BOARD_WIDTH = 1672;
const BOARD_HEIGHT = 941;
const BACKGROUND = "#0f172a";

// Coordonnées normalisées [0,1] du centre de chaque lieu sur board.jpg —
// calibrées à l'œil sur l'aperçu généré, dans le même esprit que
// DEFAULT_FOCAL de zoomImage.js. À affiner par itération visuelle réelle
// (comme l'historique de réglage documenté dans zoomImage.js) si le rendu
// final place les pastilles trop loin du décor attendu.
const LIEU_ANCHORS = {
  chateau: { x: 0.5, y: 0.51 },
  camp_entrainement: { x: 0.22, y: 0.24 },
  tour_de_guet: { x: 0.79, y: 0.69 },
  taverne: { x: 0.72, y: 0.24 },
  clairiere_mystique: { x: 0.17, y: 0.69 },
};

// Couleurs de camp — utilisées UNIQUEMENT pour les pastilles de joueurs déjà
// éliminés (camp révélé), jamais pour un joueur vivant.
const CAMP_COLORS = {
  chasseur: "#3b82f6",
  gobelin: "#22c55e",
};
const PION_VIVANT_COLOR = "#f1c40f";
const TOKEN_RADIUS = 22;
const TOKEN_SPACING = 52;

let boardDataUrlCache = null;

async function loadBoardDataUrl() {
  if (boardDataUrlCache) return boardDataUrlCache;
  const buffer = await readBlobAsset(BOARD_IMAGE_PATH);
  boardDataUrlCache = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  return boardDataUrlCache;
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function initialOf(username) {
  return escapeText(String(username || "?").trim().charAt(0).toUpperCase() || "?");
}

// Regroupe les joueurs vivants par lieu, puis répartit les pastilles d'un
// même lieu en petite grille (3 par ligne) centrée sur l'ancre du lieu, pour
// éviter le chevauchement quand plusieurs joueurs partagent le même endroit.
function buildTokensSvg(joueursVivants) {
  const parLieu = new Map();
  for (const j of joueursVivants) {
    const list = parLieu.get(j.position) || [];
    list.push(j);
    parLieu.set(j.position, list);
  }

  const circles = [];
  for (const [lieu, occupants] of parLieu.entries()) {
    const anchor = LIEU_ANCHORS[lieu];
    if (!anchor) continue;
    const cx0 = anchor.x * BOARD_WIDTH;
    const cy0 = anchor.y * BOARD_HEIGHT;
    occupants.forEach((j, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const cx = cx0 + (col - 1) * TOKEN_SPACING;
      const cy = cy0 + row * TOKEN_SPACING;
      circles.push(
        `<circle cx="${cx}" cy="${cy}" r="${TOKEN_RADIUS}" fill="${PION_VIVANT_COLOR}" stroke="#1e293b" stroke-width="2"/>`,
      );
    });
  }
  return circles.join("\n");
}

// Pastille numérotée de chaque lieu (même numéro que les boutons, voir
// `numero` dans goblinhunters.json) — toujours affichée, même lieu vide.
// Placée AU-DESSUS de l'ancre : les pions partent de l'ancre et descendent
// par lignes de 3, la pastille ne les chevauche donc jamais.
const BADGE_RADIUS = 20;
const BADGE_OFFSET_Y = 58;

function buildLieuBadgesSvg(lieux) {
  return Object.entries(lieux)
    .map(([lieuId, lieu]) => {
      const anchor = LIEU_ANCHORS[lieuId];
      if (!anchor || lieu.numero == null) return "";
      const cx = anchor.x * BOARD_WIDTH;
      const cy = anchor.y * BOARD_HEIGHT - BADGE_OFFSET_Y;
      return [
        `<circle cx="${cx}" cy="${cy}" r="${BADGE_RADIUS}" fill="#0f172a" fill-opacity="0.85" stroke="#f8fafc" stroke-width="2"/>`,
        `<text x="${cx}" y="${cy + 8}" font-family="${FONT_FAMILY}" font-size="22" text-anchor="middle" fill="#f8fafc">${escapeText(lieu.numero)}</text>`,
      ].join("\n");
    })
    .join("\n");
}

// Bande de pastilles grisées pour les joueurs déjà éliminés — couleur de
// camp visible (camp révélé publiquement à l'élimination), jamais le rôle
// précis.
function buildEliminatedStripSvg(joueursElimines) {
  if (!joueursElimines.length) return "";
  const y = BOARD_HEIGHT - 36;
  const startX = BOARD_WIDTH / 2 - ((joueursElimines.length - 1) * TOKEN_SPACING) / 2;
  return joueursElimines
    .map((j, index) => {
      const cx = startX + index * TOKEN_SPACING;
      const color = CAMP_COLORS[j.camp] || "#64748b";
      return [
        `<circle cx="${cx}" cy="${y}" r="${TOKEN_RADIUS - 4}" fill="${color}" fill-opacity="0.45" stroke="#1e293b" stroke-width="2"/>`,
        `<text x="${cx}" y="${y + 5}" font-family="${FONT_FAMILY}" font-size="15" text-anchor="middle" fill="#f8fafc">${initialOf(j.username)}</text>`,
        `<line x1="${cx - TOKEN_RADIUS + 4}" y1="${y - TOKEN_RADIUS + 4}" x2="${cx + TOKEN_RADIUS - 4}" y2="${y + TOKEN_RADIUS - 4}" stroke="#f8fafc" stroke-width="2"/>`,
      ].join("\n");
    })
    .join("\n");
}

async function buildBoardSvg(joueurs) {
  const dataUrl = await loadBoardDataUrl();
  const config = await loadGoblinHuntersConfig();
  const vivants = joueurs.filter((j) => j.alive);
  const elimines = joueurs.filter((j) => !j.alive);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <image x="0" y="0" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" href="${dataUrl}"/>
  ${buildLieuBadgesSvg(config.lieux)}
  ${buildTokensSvg(vivants)}
  ${buildEliminatedStripSvg(elimines)}
</svg>`;
}

async function rasterize(svg) {
  const fontPath = await readBlobFontPath(FONT_PATH);
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: BOARD_WIDTH },
    background: BACKGROUND,
    font: {
      fontFiles: [fontPath],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  const pngData = resvg.render();
  return { buffer: Buffer.from(pngData.asPng()), mimeType: "image/png" };
}

// Rendu du plateau reflétant l'état COURANT de la partie — pas un instantané
// historique par jour : l'ancien message Discord est supprimé avant chaque
// repost (voir publishAndWriteState), donc aucune image passée ne reste
// jamais référencée ailleurs. Le paramètre `jour` de la route Express ne
// sert qu'à invalider le cache Discord (embed.image.url change chaque jour).
export async function getBoardImage() {
  const state = await readState();
  if (!state?.joueurs) return null;
  const svg = await buildBoardSvg(state.joueurs);
  return rasterize(svg);
}

// Illustration statique de fin de partie — servie TELLE QUELLE (pas de
// composition SVG/resvg ici, contrairement au plateau) : le format WebP
// fonctionne très bien pour un fichier servi directement par une route
// Express, seule sa décodabilité PAR resvg à l'intérieur d'un `<image>`
// embarqué posait problème (voir board.jpg plus haut) — deux contraintes
// différentes, pas de conflit ici. Mise en cache mémoire après la première
// lecture, comme le reste des assets de ce module.
let endImageCache = null;

export async function getEndImage() {
  if (!endImageCache) {
    endImageCache = { buffer: await readBlobAsset(END_IMAGE_PATH), mimeType: "image/webp" };
  }
  return endImageCache;
}

// Illustration statique d'inscription — même principe que getEndImage() ci-
// dessus (servie telle quelle, WebP sans souci puisqu'aucune composition
// resvg n'entre en jeu ici).
let startImageCache = null;

export async function getStartImage() {
  if (!startImageCache) {
    startImageCache = { buffer: await readBlobAsset(START_IMAGE_PATH), mimeType: "image/webp" };
  }
  return startImageCache;
}
