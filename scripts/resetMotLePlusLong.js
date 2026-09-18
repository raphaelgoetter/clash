#!/usr/bin/env node
// resetMotLePlusLong.js
// Remet à zéro le jeu Le Mot le Plus Long : plus de manche active, ordre de
// rotation des cartes "seed" remélangé à la prochaine manche, et
// historique/scores effacés.
//
// Usage : node scripts/resetMotLePlusLong.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/motlepluslong.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Le Mot le Plus Long remis à zéro : plus de manche active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
