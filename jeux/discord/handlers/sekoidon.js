// ============================================================
// sekoidon.js — Handlers Discord du jeu "Sékoidon" (à quoi sert cet objet
// insolite ?), groupe « Curiosités » du mardi (voir
// jeux/services/jeuxclash.js). Instance de triviaEngine.js : la photo de la
// manche est servie par /api/sekoidon/image, gardée par le registre
// anti-spoiler du moteur (isGamePosted).
// ============================================================

import * as svc from "../../services/sekoidon.js";
import { createTriviaHandlers } from "./triviaEngine.js";
import { CLASH_JOUR } from "../../services/jeuxclash.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const handlers = createTriviaHandlers(svc, {
  name: "Sékoidon",
  emoji: "🤔",
  color: 0x8a3b12,
  jour: CLASH_JOUR,
  answerPrefix: "sekoidon_answer",
  bannerPath: null,
  imageUrl: (gameId) => `${URL_JEUX}/api/sekoidon/image?gameId=${encodeURIComponent(gameId)}`,
});

export const { post: postSekoidon, postSeasonRecap, handleAnswerButton } = handlers;
