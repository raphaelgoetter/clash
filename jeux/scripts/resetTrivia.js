#!/usr/bin/env node
// resetTrivia.js
// Remet à zéro le jeu Trivia : plus de manche active, participants,
// classements et archives de saison effacés. L'ordre de tirage des
// questions n'est pas conservé : la prochaine manche repart au début du
// catalogue. Destructif, à utiliser avec
// précaution une fois le jeu en production.
//
// Usage : node jeux/scripts/resetTrivia.js [--geek]   (--geek : Trivia Geek)

import "../env.js";

import { resetGame as resetTrivia } from "../services/trivia.js";
import { resetGame as resetTriviaGeek } from "../services/triviageek.js";

const GEEK = process.argv.includes("--geek");
const LABEL = GEEK ? "Trivia Geek" : "Trivia";

(async () => {
  try {
    await (GEEK ? resetTriviaGeek : resetTrivia)();
    console.log(`Jeu ${LABEL} remis à zéro : plus de manche active, participants et archives de saison effacés.`);
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
