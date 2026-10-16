#!/usr/bin/env node
// resetMeow.js
// Remet Meow à zéro : plus de partie active (la prochaine publication
// repart du jour de présentation), carte/joueurs/combats effacés. L'archive
// des manches passées (meow:manches) est préservée par défaut — ajouter
// --manches pour l'effacer aussi (utile en phase de test).
//
// Usage :
//   node scripts/resetMeow.js             — reset normal, garde l'archive des manches
//   node scripts/resetMeow.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetMeow } from "../backend/services/meow.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetMeow({ clearManches: CLEAR_MANCHES });
    console.log(`Meow remis à zéro : plus de partie active, carte/joueurs effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`);
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
