#!/usr/bin/env node
// resetSynopsis.js
// Remet à zéro le jeu Synopsis éclaté : plus de manche active (la prochaine
// repart au début du catalogue), participants, classements et archives
// effacés. Destructif, à utiliser avec précaution une fois le jeu en
// production.
//
// Usage : node jeux/scripts/resetSynopsis.js

import "../env.js";

import { resetGame } from "../services/synopsis.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Synopsis éclaté remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
