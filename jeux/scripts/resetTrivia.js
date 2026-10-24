#!/usr/bin/env node
// resetTrivia.js
// Remet à zéro le jeu Trivia : plus de manche active, participants,
// classements et archives de saison effacés. L'ordre de tirage des
// questions n'est pas conservé : la prochaine manche repart au début du
// catalogue. Destructif, à utiliser avec
// précaution une fois le jeu en production.
//
// Usage : node jeux/scripts/resetTrivia.js [--geek | --intrus]
//   (--geek : Trivia Geek, --intrus : Intrus de l'inventaire)

import "../env.js";

import { resetGame as resetTrivia } from "../services/trivia.js";
import { resetGame as resetTriviaGeek } from "../services/triviageek.js";
import { resetGame as resetIntrus } from "../services/intrus.js";

const GEEK = process.argv.includes("--geek");
const INTRUS = process.argv.includes("--intrus");
const LABEL = INTRUS ? "Intrus de l'inventaire" : GEEK ? "Trivia Geek" : "Trivia";

(async () => {
  try {
    await (INTRUS ? resetIntrus : GEEK ? resetTriviaGeek : resetTrivia)();
    console.log(`Jeu ${LABEL} remis à zéro : plus de manche active, participants et archives de saison effacés.`);
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
