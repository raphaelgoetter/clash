#!/usr/bin/env node
// resetBlindRoyale.js
// Remet à zéro le jeu Blind Royale : plus de partie active (la prochaine
// partie repart à la première carte du pool) et historique/scores effacés.
//
// Usage : node scripts/resetBlindRoyale.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/blindroyale.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Blind Royale remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
