#!/usr/bin/env node
// resetZoom2.js
// Remet à zéro le jeu Zoom logo : plus de manche active (la prochaine
// repart au début du catalogue), participants, classements et archives
// effacés. Destructif, à utiliser avec précaution une fois le jeu en
// production.
//
// Usage : node jeux/scripts/resetZoom2.js

import "../env.js";

import { resetGame } from "../services/zoom2.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Zoom logo remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
