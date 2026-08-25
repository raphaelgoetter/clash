// ============================================================
// goblinhuntersImage.js — Synthèse de l'image du plateau pour Goblin
// Hunters : compose le décor statique (data/goblinhunters/images/board.png)
// avec les pastilles des joueurs vivants positionnées par lieu, et une
// bande de pastilles grisées pour les joueurs éliminés (camp révélé,
// jamais le rôle précis). Même technique que zoomImage.js : SVG avec un
// `<image href="data:...">` de fond, rastérisé en PNG via @resvg/resvg-js.
//
// ⚠️ PNG, pas WebP : un premier test avait semblé valider le WebP embarqué
// (le rendu ne levait aucune exception), mais une vérification VISUELLE du
// PNG produit a révélé que l'image de fond restait silencieusement absente
// (seul le fond de couleur uni apparaissait) — resvg/usvg ne sait pas
// décoder un `<image>` WebP embarqué en data URI, sans jamais lever
// d'erreur. `data/goblinhunters/images/board.webp` (l'asset original fourni)
// est conservé pour archive ; `board.png` (converti une fois, `sips -s
// format png`) est le seul fichier réellement utilisé au rendu. Toujours
// VÉRIFIER VISUELLEMENT un rendu resvg avant de le considérer fonctionnel —
// l'absence d'exception ne garantit rien ici.
//
// ⚠️ Les pastilles des joueurs VIVANTS ne doivent JAMAIS être colorées par
// camp (ça fuiterait le secret que le jeu entier repose sur) — couleur
// neutre unique + initiale du pseudo, quel que soit le camp réel. Seuls les
// joueurs éliminés (camp déjà révélé publiquement) affichent une couleur de
// camp, dans la bande grisée en bas de l'image.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { readState } from "./goblinhunters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_IMAGE_PATH = path.resolve(__dirname, "..", "..", "data", "goblinhunters", "images", "board.png");

// Dimensions natives de board.png (voir data/goblinhunters/images/board.png)
// — à ajuster si l'asset est remplacé par une image de résolution différente.
const BOARD_WIDTH = 1672;
const BOARD_HEIGHT = 941;
const BACKGROUND = "#0f172a";

// Coordonnées normalisées [0,1] du centre de chaque lieu sur board.png —
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
  const buffer = await fs.readFile(BOARD_IMAGE_PATH);
  boardDataUrlCache = `data:image/png;base64,${buffer.toString("base64")}`;
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
        `<text x="${cx}" y="${cy + 6}" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="#1e293b">${initialOf(j.username)}</text>`,
      );
    });
  }
  return circles.join("\n");
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
        `<text x="${cx}" y="${y + 5}" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="#f8fafc">${initialOf(j.username)}</text>`,
        `<line x1="${cx - TOKEN_RADIUS + 4}" y1="${y - TOKEN_RADIUS + 4}" x2="${cx + TOKEN_RADIUS - 4}" y2="${y + TOKEN_RADIUS - 4}" stroke="#f8fafc" stroke-width="2"/>`,
      ].join("\n");
    })
    .join("\n");
}

async function buildBoardSvg(joueurs) {
  const dataUrl = await loadBoardDataUrl();
  const vivants = joueurs.filter((j) => j.alive);
  const elimines = joueurs.filter((j) => !j.alive);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <image x="0" y="0" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" href="${dataUrl}"/>
  ${buildTokensSvg(vivants)}
  ${buildEliminatedStripSvg(elimines)}
</svg>`;
}

async function rasterize(svg) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: BOARD_WIDTH },
    background: BACKGROUND,
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
