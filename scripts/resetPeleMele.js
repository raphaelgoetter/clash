#!/usr/bin/env node
// resetPeleMele.js
// Remet à zéro le jeu Pêle-mêle : plus de manche active, ordre de
// rotation des cartes "seed" remélangé à la prochaine manche, et
// historique/scores effacés.
//
// Usage : node scripts/resetPeleMele.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/pelemele.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Pêle-mêle remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
