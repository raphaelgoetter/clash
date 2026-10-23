#!/usr/bin/env node
// resetConcept.js
// Remet à zéro le jeu Concept : plus de manche active (la prochaine repart
// au début du catalogue), participants, classements et archives effacés.
// Destructif, à utiliser avec précaution une fois le jeu en production.
//
// Usage : node jeux/scripts/resetConcept.js

import "../env.js";

import { resetGame } from "../services/concept.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Concept remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
