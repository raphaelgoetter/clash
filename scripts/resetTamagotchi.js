#!/usr/bin/env node
// resetTamagotchi.js
// Remet à zéro le Tamagoshi (Bébé Dragon "Lilith") : plus de journée active
// (la prochaine publication repart du Jour 1 avec les jauges initiales de
// tamagotchi.json), votes et historique effacés.
//
// Usage : node scripts/resetTamagotchi.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetTamagotchi } from "../backend/services/tamagotchi.js";

(async () => {
  try {
    await resetTamagotchi();
    console.log("Tamagoshi remis à zéro : plus de journée active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
