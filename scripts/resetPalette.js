#!/usr/bin/env node
// resetPalette.js
// Remet à zéro le jeu Palette : plus de manche active, participants,
// classements et archives de saison effacés. L'ordre de tirage des cartes
// (palette:play_order) n'est pas touché — la prochaine manche reprend
// simplement au tirage suivant. Destructif, à utiliser avec précaution une
// fois le jeu en production.
//
// Usage : node scripts/resetPalette.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/palette.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Palette remis à zéro : plus de manche active, participants et archives de saison effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
