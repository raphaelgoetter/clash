// ============================================================
// trivia.js — Handlers Discord du jeu "Trivia" (QCM de culture Clash
// Royale), en alternance une saison sur deux avec Frame (voir
// jeux/services/jeuxculture.js). Instance de triviaEngine.js ; commande
// `/trivia` pour les scores personnels.
// ============================================================

import * as svc from "../../services/trivia.js";
import { createTriviaHandlers } from "./triviaEngine.js";

const handlers = createTriviaHandlers(svc, {
  name: "Trivia",
  emoji: "🧠",
  color: 0xf1c40f,
  jour: "mercredi",
  answerPrefix: "trivia_answer",
  statsRefreshId: "trivia_stats_refresh",
  // Bannière fixe (frontend/public/images/trivia/images/).
  bannerPath: "/images/trivia/images/trivia-game.webp",
});

export const {
  post: postTrivia,
  postSeasonRecap,
  handleAnswerButton,
  handleStatsCommand: handleTriviaStatsCommand,
} = handlers;
