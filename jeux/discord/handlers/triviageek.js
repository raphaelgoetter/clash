// ============================================================
// triviageek.js — Handlers Discord du jeu "Trivia Geek" (QCM de culture
// geek), groupe "Culture geek" du lundi (voir jeux/services/refonte.js).
// Instance de triviaEngine.js.
// ============================================================

import * as svc from "../../services/triviageek.js";
import { createTriviaHandlers } from "./triviaEngine.js";

const handlers = createTriviaHandlers(svc, {
  name: "Trivia Geek",
  emoji: "🎮",
  color: 0x9b59b6,
  jour: "lundi",
  answerPrefix: "triviageek_answer",
  // Bannière fixe (frontend/public/images/triviageek/).
  bannerPath: "/images/triviageek/trivia-geek-game.webp",
});

export const { post: postTriviaGeek, postSeasonRecap, handleAnswerButton } = handlers;
