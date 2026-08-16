#!/usr/bin/env node
// resetJusteCarte.js
// Remet à zéro le jeu La Juste Carte : plus de partie active, ordre de
// rotation remélangé à la prochaine partie, et historique/scores effacés.
//
// Usage : node scripts/resetJusteCarte.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/lajustecarte.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu La Juste Carte remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
