// ============================================================
// sekoidon.js — Jeu "Sékoidon" (photo d'un objet insolite, ancien ou
// moderne : à quoi sert-il ?), groupe « Curiosités » du mardi en alternance
// avec Zoom truc, à partir de janvier 2027 à la place du Trivia Clash
// Royale (voir REMPLACEMENTS dans refonte.js). Instance du moteur commun
// triviaEngine.js : préfixe Redis `sekoidon:`, un seul essai, 1 pt.
//
// Catalogue jeux/data/jeux-visuels/sekoidon/sekoidon.json : `numero`
// (= position), `objet` (identifiant lisible), `famille` (etrange, moderne
// ou classique), `univers` (médecine, guerre…), `nom`, `epoque`, `bonne`,
// `leurres` (3), `explication`, `source`, `image` (JPEG servi par Blob),
// `photo` ({ page, auteur, licence } : crédit affiché à la révélation).
// Parcouru dans l'ordre du fichier, en boucle ; gameId = `s` + numéro sur 3
// chiffres. Ne jamais réordonner, ajouter en fin.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createTriviaService } from "./triviaEngine.js";
import { CLASH_WEEKDAY } from "./jeuxclash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Chemin de fichier explicite, sans constante de répertoire : @vercel/nft
// embarque tout dossier référencé (images comprises, servies par Blob).
const CATALOG_PATH = path.resolve(__dirname, "..", "data", "jeux-visuels", "sekoidon", "sekoidon.json");

export const QUESTION = "À quoi sert cet objet ?";

export function gameIdFor(numero) {
  return `s${String(numero).padStart(3, "0")}`;
}

// Crédit de la photo, obligatoire pour les licences CC BY / CC BY-SA.
export function creditPhoto(photo) {
  const auteur = photo.auteur?.trim() || "Wikimedia Commons";
  return `📷 Photo : [${auteur}](${photo.page})${photo.licence ? `, ${photo.licence}` : ""}`;
}

// Fonction pure : objet du catalogue → entrée du moteur (options[0] = bonne
// réponse, ordre mélangé par manche par le moteur).
export function parseSekoidonEntry(objet) {
  return {
    id: gameIdFor(objet.numero),
    numero: objet.numero,
    titre: null,
    question: QUESTION,
    options: [objet.bonne, ...objet.leurres],
    image: objet.image,
    explication: `**${objet.nom}** (${objet.epoque}). ${objet.explication}`,
    source: `${objet.source}\n${creditPhoto(objet.photo)}`,
    label: objet.nom,
    erratum: objet.erratum ?? null,
  };
}

export async function loadObjets() {
  return JSON.parse(await fs.readFile(CATALOG_PATH, "utf-8"));
}

async function loadSekoidonCatalog() {
  return (await loadObjets()).map(parseSekoidonEntry);
}

const svc = createTriviaService({
  prefix: "sekoidon",
  weekday: CLASH_WEEKDAY,
  loadCatalog: loadSekoidonCatalog,
});

export const {
  LETTERS,
  loadTriviaCatalog,
  resolveTriviaEntry,
  readState,
  writeState,
  resetGame,
  getCurrentSeasonId,
  pickNextTriviaIndex,
  alreadyPostedThisWeek,
  computeSeasonMancheTotal,
  previewSeasonManche,
  getSeasonManches,
  getSeasonMancheNumber,
  getTriviaRoundLabel,
  startNewGame,
  isGamePosted,
  readRoundOrder,
  checkAnswer,
  getCorrectLetter,
  computeScore,
  readParticipant,
  recordAnswer,
  archiveAnswer,
  getGameParticipants,
  computeSeasonRanking,
  getAllArchivedResults,
  grantErratumPoint,
  claimErratumAnnouncement,
  releaseErratumAnnouncement,
  findRank,
  findTiedRank,
} = svc;
