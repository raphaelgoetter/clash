#!/usr/bin/env node
// resetAventure.js
// Remet à zéro l'Aventure interactive : plus de chapitre actif (la
// prochaine publication repart du chapitre "debut" de histoire.json),
// votes, numérotation des jours et historique effacés.
//
// Usage : node scripts/resetAventure.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetAventure } from "../backend/services/aventure.js";

(async () => {
  try {
    await resetAventure();
    console.log("Aventure remise à zéro : plus de chapitre actif, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
