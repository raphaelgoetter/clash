// ============================================================
// trivia.js — Jeu "Trivia" (QCM de culture Clash Royale), en alternance une
// saison sur deux avec Frame ("Devine le film") sous le nom collectif
// "Mini-jeux de Culture" (voir jeux/services/jeuxculture.js) jusqu'à la
// refonte, puis avec Zoom carte dans le groupe Clash (voir jeuxclash.js).
// Instance du moteur commun triviaEngine.js : préfixe Redis `trivia:`,
// catalogue jeux/data/triviaclash/trivia-clash.json, publication le
// mercredi, puis le mardi à partir de la refonte.
// ============================================================

import path from "path";
import { fileURLToPath } from "url";
import { createTriviaService } from "./triviaEngine.js";
import { publicationWeekday } from "./jeuxclash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svc = createTriviaService({
  prefix: "trivia",
  catalogPath: path.resolve(__dirname, "..", "data", "triviaclash", "trivia-clash.json"),
  weekday: (seasonId) => publicationWeekday(seasonId, 3), // mercredi (créneau de Frame), puis mardi
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
