// ============================================================
// triviageek.js — Jeu "Trivia Geek" (QCM de culture geek : web, jeux vidéo,
// pop culture), groupe "Culture geek" du lundi en alternance avec Intrus de
// l'inventaire (voir refonte.js). Instance du moteur commun triviaEngine.js :
// préfixe Redis `triviageek:`, catalogue
// jeux/data/triviageek/trivia-geek.json, publication le lundi.
// ============================================================

import path from "path";
import { fileURLToPath } from "url";
import { createTriviaService } from "./triviaEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svc = createTriviaService({
  prefix: "triviageek",
  catalogPath: path.resolve(__dirname, "..", "data", "triviageek", "trivia-geek.json"),
  weekday: 1, // lundi, créneau du groupe jeuxaveugle
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
  getPlayerSeasonResults,
  getGameParticipants,
  computeSeasonRanking,
  getAllArchivedResults,
  grantErratumPoint,
  claimErratumAnnouncement,
  releaseErratumAnnouncement,
  findRank,
  findTiedRank,
} = svc;
