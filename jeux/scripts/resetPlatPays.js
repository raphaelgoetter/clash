#!/usr/bin/env node
// resetPlatPays.js
// Remet à zéro le jeu Plat Pays : plus de manche active (la prochaine
// repart au début du catalogue), participants, classements et archives
// effacés. Destructif, à utiliser avec précaution une fois le jeu en
// production.
//
// Usage : node jeux/scripts/resetPlatPays.js

import "../env.js";

import { resetGame } from "../services/platpays.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Plat Pays remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
