// ============================================================
// marioclashImage.js — Synthèse de l'image du plateau pour Mario Clash :
// compose le décor statique (data/marioclash/images/mario-clash-board.jpg)
// avec les pions des joueurs positionnés sur leur case (1 à 49). Même
// technique que goblinhuntersImage.js/zoomImage.js : SVG avec un
// `<image href="data:...">` de fond, rastérisé en PNG via @resvg/resvg-js.
//
// ⚠️ JPEG, ni WebP ni AVIF : les deux échouent SILENCIEUSEMENT (aucune
// exception, l'image de fond reste simplement absente du rendu) — resvg/
// usvg ne sait décoder que PNG/JPEG/GIF en `<image>` embarqué. Même piège
// que documenté dans goblinhuntersImage.js. `mario-clash-board.webp` (asset
// original généré) est conservé pour archive uniquement ; le rendu utilise
// `mario-clash-board.jpg` (qualité 85, converti via
// `sips -s format jpeg -s formatOptions 85`).
//
// ⚠️ Coordonnées des 49 cases : la grille serpentin 7×7 dessinée par l'IA
// n'est PAS parfaitement régulière (rangées et colonnes d'espacement
// variable) — une simple formule linéaire (marge + pas constant) plaçait
// les pions visiblement à côté du centre réel de la case, en particulier
// sur les rangées du milieu. Les positions ci-dessous viennent d'une
// détection par pixels (piste tan vs herbe verte, par rangée) sur l'image
// source, pas d'une estimation à l'œil — voir le calibrage réel avant de
// modifier `mario-clash-board.jpg` sous peine de désynchroniser CASE_ANCHORS.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { readJoueurs } from "./marioclash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_IMAGE_PATH = path.resolve(__dirname, "..", "..", "data", "marioclash", "images", "mario-clash-board.jpg");
const ILLUSTRATION_IMAGE_PATH = path.resolve(__dirname, "..", "..", "data", "marioclash", "images", "mario-clash.webp");

// Dimensions natives de mario-clash-board.jpg — à ajuster si l'asset est
// remplacé par une image de résolution différente (et à recalibrer les
// coordonnées ci-dessous en conséquence).
const BOARD_WIDTH = 840;
const BOARD_HEIGHT = 840;
const BACKGROUND = "#0f172a";

// Y mesuré par rangée (1 à 7) — bandes détectées par pixel, pas régulières.
const ROW_Y = [126.8, 231.7, 330.7, 431, 530, 626.7, 724.3];

// X mesuré par rangée, dans l'ordre PHYSIQUE gauche→droite (7 valeurs par
// rangée) — chaque rangée a sa propre étendue piste, distincte des autres.
const ROW_X = [
  [174, 263, 351, 440, 529, 617, 706], // rangée 1 (cases 1-7)
  [127, 227, 327, 427, 527, 627, 727], // rangée 2 (cases 8-14, sens inverse)
  [126, 227, 328, 429, 530, 631, 732], // rangée 3 (cases 15-21)
  [106, 207, 308, 410, 511, 612, 713], // rangée 4 (cases 22-28, sens inverse)
  [126, 221, 316, 411, 506, 601, 696], // rangée 5 (cases 29-35)
  [136, 232, 328, 424, 520, 616, 712], // rangée 6 (cases 36-42, sens inverse)
  [138, 234, 330, 426, 521, 617, 713], // rangée 7 (cases 43-49)
];

// Grille serpentin : rangée paire (0-indexée) = sens gauche→droite, rangée
// impaire = sens inverse (le tracé remonte visuellement dans l'autre sens).
export const CASE_COUNT = 49;
const CASE_ANCHORS = [null]; // index 0 inutilisé, les cases sont numérotées 1-49
for (let r = 0; r < 7; r++) {
  const y = ROW_Y[r];
  for (let i = 0; i < 7; i++) {
    const x = r % 2 === 0 ? ROW_X[r][i] : ROW_X[r][6 - i];
    CASE_ANCHORS.push({ x, y });
  }
}

function anchorForCase(position) {
  const clamped = Math.min(CASE_COUNT, Math.max(1, Math.round(position)));
  return CASE_ANCHORS[clamped];
}

// 30 couleurs choisies à la main (pas une rotation mécanique de teinte, qui
// regroupe trop de verts/cyans proches et rendait certains joueurs
// indiscernables — voir le retour utilisateur). Les 15 premières couvrent
// tout le cercle chromatique avec un écart perceptuel maximal (cas normal,
// jusqu'à 15 joueurs) ; les 15 suivantes sont des variantes assombries des
// mêmes teintes, pour l'improbable cas où plus de 15 joueurs participent le
// même jour (toujours distinctes entre elles, et de leur "jumelle" claire).
const PAWN_COLORS = [
  "#e6194b", "#f58231", "#f2c614", "#9acd32", "#3cb44b",
  "#17a589", "#42d4f4", "#4363d8", "#1b1f8a", "#911eb4",
  "#f032e6", "#e6007e", "#9a6324", "#800000", "#6b6b0a",
  "#8f102f", "#98511e", "#967b0c", "#5f7f1f", "#25702f",
  "#0e6655", "#298397", "#2a3d86", "#111356", "#5a1370",
  "#951f8f", "#8f004e", "#5f3d16", "#4f0000", "#424206",
];
const TOKEN_RADIUS = 15;
const TOKEN_SPREAD = 32; // écart horizontal entre pions partageant une case

// Attribution par ORDRE D'ARRIVÉE (`joueur.colorIndex`, assigné une fois
// pour toutes à la création du joueur — voir ensureJoueur() dans
// marioclash.js), jamais par hash : un hash sur discordId peut faire
// collision entre deux joueurs bien avant d'épuiser la palette (paradoxe
// des anniversaires — même avec 30 couleurs, ~20 joueurs hashés au hasard
// ont une probabilité de collision proche de 100%). L'index garantit zéro
// collision tant que le nombre de joueurs ne dépasse pas la palette.
function colorForPlayer(colorIndex) {
  const i = Number.isInteger(colorIndex) ? colorIndex : 0;
  return PAWN_COLORS[i % PAWN_COLORS.length];
}

let boardDataUrlCache = null;

async function loadBoardDataUrl() {
  if (boardDataUrlCache) return boardDataUrlCache;
  const buffer = await fs.readFile(BOARD_IMAGE_PATH);
  boardDataUrlCache = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  return boardDataUrlCache;
}

// Regroupe les joueurs par case, puis répartit les pions d'une même case
// horizontalement (taille FIXE, jamais réduite — un rétrécissement variable
// donnait des pions d'aspect incohérent d'une case à l'autre).
function buildTokensSvg(joueurs) {
  const parCase = new Map();
  for (const j of joueurs) {
    const list = parCase.get(j.position) || [];
    list.push(j);
    parCase.set(j.position, list);
  }

  const circles = [];
  for (const [position, occupants] of parCase.entries()) {
    const anchor = anchorForCase(position);
    occupants.forEach((j, index) => {
      const dx = occupants.length > 1 ? (index - (occupants.length - 1) / 2) * TOKEN_SPREAD : 0;
      const cx = anchor.x + dx;
      const cy = anchor.y;
      circles.push(
        `<circle cx="${cx}" cy="${cy}" r="${TOKEN_RADIUS}" fill="${colorForPlayer(j.colorIndex)}" stroke="#1e293b" stroke-width="2.5"/>`,
      );
    });
  }
  return circles.join("\n");
}

async function buildBoardSvg(joueurs) {
  const dataUrl = await loadBoardDataUrl();
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BACKGROUND}"/>
  <image x="0" y="0" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" href="${dataUrl}"/>
  ${buildTokensSvg(joueurs)}
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

// Rendu du plateau pour un état de jeu donné — `joueurs` = liste de
// { discordId, username, position } (position 1-49). Ne dépend d'aucun
// state Redis : l'appelant (backend/services/marioclash.js, à venir) est
// responsable de lire l'état et d'appeler cette fonction avec les joueurs
// vivants du jour.
export async function renderBoardImage(joueurs) {
  const svg = await buildBoardSvg(joueurs || []);
  return rasterize(svg);
}

// Rendu du plateau reflétant l'état COURANT de la partie — pas un
// instantané par jour : l'ancien message est supprimé avant chaque repost
// (voir publishAndWriteState du handler), donc aucune image passée ne
// reste jamais référencée ailleurs. Même principe que
// goblinhuntersImage.js/getBoardImage().
// `jour` : le Jour 1 affiche systématiquement le plateau VIDE (aucun pion),
// quel que soit qui a déjà cliqué un bouton ce jour-là — personne n'a encore
// de position significative avant la toute première clôture (tout le monde
// est à la case 0), afficher des pions bunchés à la case 1 avant même de
// connaître l'effectif final de la course serait trompeur.
export async function getBoardImage(jour) {
  if (Number(jour) === 1) return renderBoardImage([]);
  const joueurs = await readJoueurs();
  const liste = Object.entries(joueurs).map(([discordId, j]) => ({
    discordId,
    username: j.username,
    position: j.position,
    colorIndex: j.colorIndex,
  }));
  return renderBoardImage(liste);
}

// Illustration statique du jour de présentation / de fin de course — servie
// TELLE QUELLE (pas de composition SVG/resvg ici, contrairement au
// plateau) : WebP fonctionne très bien pour un fichier servi directement
// par une route Express, seule sa décodabilité PAR resvg à l'intérieur d'un
// `<image>` embarqué posait problème (voir board.jpg plus haut) — deux
// contraintes différentes, pas de conflit ici. Même principe que
// getEndImage()/getStartImage() de goblinhuntersImage.js.
let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await fs.readFile(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
