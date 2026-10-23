#!/usr/bin/env node
// resetZoom.js
// Remet à zéro le jeu Zoom carte : plus de partie active (la prochaine
// partie repart au début du catalogue jeux/data/jeux-visuels/zoom/zoom.json) et
// historique/scores effacés.
//
// Usage : node jeux/scripts/resetZoom.js

import "../env.js";

import { resetGame } from "../services/zoom.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Zoom carte remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
