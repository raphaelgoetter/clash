// ============================================================
// trivia.js — Jeu "Trivia" (QCM de culture Clash Royale), en alternance une
// saison sur deux avec Frame ("Devine le film") sous le nom collectif
// "Mini-jeux de Culture" (voir jeux/services/jeuxculture.js), jusqu'à la
// refonte (voir refonte.js). Instance du moteur commun triviaEngine.js :
// préfixe Redis `trivia:`, catalogue jeux/data/triviaclash/trivia-clash.json,
// publication le mercredi.
// ============================================================

import path from "path";
import { fileURLToPath } from "url";
import { createTriviaService } from "./triviaEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svc = createTriviaService({
  prefix: "trivia",
  catalogPath: path.resolve(__dirname, "..", "data", "triviaclash", "trivia-clash.json"),
  weekday: 3, // mercredi, même créneau que Frame
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
