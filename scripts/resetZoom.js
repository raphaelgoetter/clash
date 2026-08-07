#!/usr/bin/env node
// resetZoom.js
// Remet à zéro le jeu Zoom carte : plus de partie active (la prochaine
// partie repart au début du catalogue data/zoom/zoom.json) et
// historique/scores effacés.
//
// Usage : node scripts/resetZoom.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/zoom.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Zoom carte remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
