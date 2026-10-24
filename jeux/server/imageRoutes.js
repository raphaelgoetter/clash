// Routes HTTP des images de jeux (plateaux, cartes, illustrations), montées
// par le serveur Express qui expose les jeux.

import express from "express";
import { getCurrentFrameImage, getFrameImageByGameId } from "../services/frames.js";
import { getZoomCardImage, getZoomHintImage, getZoomRevealImage } from "../services/zoomImage.js";
import { getZoom2CardImage, getZoom2HintImage, getZoom2RevealImage } from "../services/zoom2Image.js";
import { getPlatImage } from "../services/platpaysImage.js";
import { getIntrusImage } from "../services/intrusImage.js";
import { getPaletteQuestionImage, getPaletteResultImage } from "../services/paletteImage.js";
import { getPeleMeleRackImage } from "../services/pelemeleImage.js";
import {
  getBoardImage as getGoblinHuntersBoardImage,
  getEndImage as getGoblinHuntersEndImage,
  getStartImage as getGoblinHuntersStartImage,
} from "../services/goblinhuntersImage.js";
import {
  getBoardImage as getMarioClashBoardImage,
  getIllustrationImage as getMarioClashIllustrationImage,
} from "../services/marioclashImage.js";
import {
  getMainImage as getBangMainImage,
  getIllustrationImage as getBangIllustrationImage,
  getTableImage as getBangTableImage,
  decodeTable as decodeBangTable,
} from "../services/bangImage.js";
import {
  decodeGrille as decodeQuiEstCeGrille,
  getGrilleImage as getQuiEstCeGrilleImage,
  getIllustrationImage as getQuiEstCeIllustrationImage,
} from "../services/quiestceImage.js";
import {
  decodeCarte as decodeMeowCarte,
  getCarteImage as getMeowCarteImage,
  getIllustrationImage as getMeowIllustrationImage,
} from "../services/meowImage.js";

const router = express.Router();

// Jeu Frame : sert l'image d'une manche précise (?gameId=), ou par défaut
// celle de la partie active — jamais une image future par nom de fichier
// deviné (jeux/data/frames/images n'est pas exposé statiquement, seule cette
// route y donne accès). Le paramètre gameId permet aux anciens posts
// Discord de continuer à afficher LEUR image même après que la partie ait
// avancé (voir getFrameImageByGameId, gardé par un registre des gameId déjà
// postés — jamais une manche qui n'a pas encore eu lieu).
router.get("/api/frames/image", async (req, res) => {
  const { gameId } = req.query;
  const image = await (gameId
    ? getFrameImageByGameId(String(gameId))
    : getCurrentFrameImage()
  ).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Zoom carte : sert l'image en zoom extrême de la manche en cours
// (embed public), ou dézoomée (indice, ?stage=hint), ou la carte entière
// (révélation, ?stage=reveal) — jamais un fichier brut de jeux/data/jeux-visuels/zoom/images
// (non exposé statiquement, seule cette route y donne accès). Anti-spoiler :
// les trois fonctions vérifient que gameId a réellement été posté (voir
// isGamePosted dans services/zoom.js), même garde-fou que Frame.
router.get("/api/zoom/image", async (req, res) => {
  const { gameId, stage } = req.query;
  if (!gameId) return res.status(400).end();
  const getImage = stage === "hint" ? getZoomHintImage : stage === "reveal" ? getZoomRevealImage : getZoomCardImage;
  const image = await getImage(String(gameId)).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Zoom logo : mêmes trois étapes que Zoom carte, même garde-fou
// anti-spoiler (isGamePosted dans services/zoom2.js).
router.get("/api/zoom2/image", async (req, res) => {
  const { gameId, stage } = req.query;
  if (!gameId) return res.status(400).end();
  const getImage = stage === "hint" ? getZoom2HintImage : stage === "reveal" ? getZoom2RevealImage : getZoom2CardImage;
  const image = await getImage(String(gameId)).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Plat Pays : photo du plat d'une manche déjà postée (garde-fou
// anti-spoiler isGamePosted dans services/platpays.js). Une seule image : la
// photo est montrée entière dès le post, les indices sont textuels.
router.get("/api/platpays/image", async (req, res) => {
  const { gameId } = req.query;
  if (!gameId) return res.status(400).end();
  const image = await getPlatImage(String(gameId)).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Intrus de l'inventaire : grille 2×2 des objets d'une manche déjà
// postée, dans l'ordre A/B/C/D de la manche (garde-fou anti-spoiler
// isGamePosted dans services/intrus.js).
router.get("/api/intrus/image", async (req, res) => {
  const { gameId } = req.query;
  if (!gameId) return res.status(400).end();
  const image = await getIntrusImage(String(gameId)).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// [TEST] Jeu Palette : sert l'image de la manche en cours (carte + 4
// pastilles A/B/C/D), ou le résultat avec voile + pourcentages
// (?stage=result) — jamais un fichier brut de jeux/data/jeux-visuels/palette/images ou
// jeux/data/jeux-visuels/palette/highlights (non exposés statiquement). Anti-spoiler :
// isGamePosted (palette:order:<gameId>), même garde-fou que Zoom.
router.get("/api/palette/image", async (req, res) => {
  const { gameId, stage } = req.query;
  if (!gameId) return res.status(400).end();
  const getImage = stage === "result" ? getPaletteResultImage : getPaletteQuestionImage;
  const image = await getImage(String(gameId)).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// [TEST] Jeu Pêle-mêle : sert l'image du chevalet de tuiles pour
// la manche EN COURS (pas d'anti-spoiler ici, les lettres sont publiques dès
// la publication — voir pelemeleImage.js). gameId n'est qu'un
// cache-buster d'URL, comme `jour` pour Goblin Hunters ci-dessous.
router.get("/api/pelemele/image", async (req, res) => {
  const image = await getPeleMeleRackImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Goblin Hunters : sert l'image du plateau (positions publiques). Le
// paramètre jour n'est PAS une clé de lookup (contrairement à gameId côté
// Frame/Zoom) : le rendu reflète toujours l'état COURANT de la partie —
// l'ancien message est supprimé avant chaque repost, donc aucune image
// passée ne reste jamais référencée ailleurs. jour sert uniquement à
// invalider le cache Discord (voir goblinhuntersImage.js).
router.get("/api/goblinhunters/image", async (req, res) => {
  const { jour } = req.query;
  if (!jour) return res.status(400).end();
  const image = await getGoblinHuntersBoardImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Goblin Hunters : illustration statique de fin de partie (servie telle
// quelle, jamais composée via resvg contrairement au plateau — voir
// goblinhuntersImage.js). Pas de paramètre : un seul fichier, inchangé
// pendant toute la manche.
router.get("/api/goblinhunters/end-image", async (req, res) => {
  const image = await getGoblinHuntersEndImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Goblin Hunters : illustration statique d'inscription (même principe
// que end-image ci-dessus).
router.get("/api/goblinhunters/start-image", async (req, res) => {
  const image = await getGoblinHuntersStartImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Mario Clash : sert l'image du plateau (positions publiques courantes).
// Même principe que /api/goblinhunters/image — jour sert uniquement à
// invalider le cache Discord, pas une clé de lookup.
router.get("/api/marioclash/image", async (req, res) => {
  const { jour } = req.query;
  if (!jour) return res.status(400).end();
  const image = await getMarioClashBoardImage(jour).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Jeu Mario Clash : illustration statique (jour de présentation / fin de
// course), servie telle quelle — même principe que /api/goblinhunters/end-image.
router.get("/api/marioclash/illustration", async (req, res) => {
  const image = await getMarioClashIllustrationImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Bang! : main d'un joueur, rendu sans état à partir des cartes passées
// dans l'URL (c = identifiants de cartes séparés par "|", une carte
// répétée affiche un badge ×N).
router.get("/api/bang/main", async (req, res) => {
  const ids = req.query.c ? String(req.query.c).split("|").filter(Boolean) : [];
  const image = await getBangMainImage(ids).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(image.buffer);
});

// Bang! : plateau d'avancement (jour, pioche, Rois), rendu sans état à
// partir de l'état encodé dans l'URL (d = base64url, voir encodeTable) :
// l'URL change avec l'état, ce qui contourne le cache d'images de Discord.
router.get("/api/bang/table", async (req, res) => {
  const etat = decodeBangTable(req.query.d);
  const image = etat ? await getBangTableImage(etat).catch(() => null) : null;
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(image.buffer);
});

// Bang! : illustration statique (présentation).
router.get("/api/bang/illustration", async (req, res) => {
  const image = await getBangIllustrationImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Qui est-ce ? : grille des cartes de la partie (publique ou fiche
// d'enquête avec cartes barrées), rendu sans état à partir de l'état encodé
// dans l'URL (d = base64url, voir encodeGrille).
router.get("/api/quiestce/grille", async (req, res) => {
  const entrees = await decodeQuiEstCeGrille(req.query.d);
  const image = entrees ? await getQuiEstCeGrilleImage(entrees).catch(() => null) : null;
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(image.buffer);
});

// Qui est-ce ? : illustration statique (présentation).
router.get("/api/quiestce/illustration", async (req, res) => {
  const image = await getQuiEstCeIllustrationImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// Meow : carte de la maison, rendu sans état à partir de l'état encodé
// dans l'URL (d, voir encodeCarte), en JPEG.
router.get("/api/meow/carte", async (req, res) => {
  const coins = decodeMeowCarte(req.query.d);
  const image = coins ? await getMeowCarteImage(coins).catch(() => null) : null;
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(image.buffer);
});

// Meow : illustration statique (présentation et fin de partie).
router.get("/api/meow/illustration", async (req, res) => {
  const image = await getMeowIllustrationImage().catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

export default router;
