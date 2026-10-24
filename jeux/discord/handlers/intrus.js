// ============================================================
// intrus.js — Handlers Discord du jeu "Intrus de l'inventaire" (trouver
// l'objet venu d'un autre jeu vidéo), groupe "Culture geek" du lundi (voir
// jeux/services/refonte.js). Instance de triviaEngine.js : l'image de la
// manche (grille 2×2 A/B/C/D) est servie par /api/intrus/image, gardée par
// le registre anti-spoiler du moteur (isGamePosted).
// ============================================================

import * as svc from "../../services/intrus.js";
import { createTriviaHandlers } from "./triviaEngine.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

const handlers = createTriviaHandlers(svc, {
  name: "Intrus de l'inventaire",
  emoji: "🎒",
  color: 0xe67e22,
  jour: "lundi",
  answerPrefix: "intrus_answer",
  bannerPath: null,
  imageUrl: (gameId) => `${TRUST_ROYALE_URL}/api/intrus/image?gameId=${encodeURIComponent(gameId)}`,
  // Image seule : les noms des objets trahiraient souvent le jeu, ils ne
  // sont révélés qu'à la réponse.
  afficherPropositions: false,
  consigne:
    "Ton sac à dos contient 4 objets. Trois de ces objets viennent du même jeu vidéo, le quatrième est un intrus venu d'un autre jeu : trouve-le !",
});

export const { post: postIntrus, postSeasonRecap, handleAnswerButton } = handlers;
