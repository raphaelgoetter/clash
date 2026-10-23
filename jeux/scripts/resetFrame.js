#!/usr/bin/env node
// resetFrame.js
// Remet à zéro le jeu Frame : plus de partie active (la prochaine partie
// repart à la première image de frames.json) et historique/scores effacés.
//
// Usage : node jeux/scripts/resetFrame.js

import "../env.js";

import { resetGame } from "../services/frames.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Frame remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
