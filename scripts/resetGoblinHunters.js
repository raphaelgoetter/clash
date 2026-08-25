#!/usr/bin/env node
// resetGoblinHunters.js
// Remet à zéro Goblin Hunters : plus de partie active (la prochaine
// publication repart de l'ouverture des inscriptions), inscriptions,
// actions/votes du jour et historique effacés. L'archive des manches
// passées (goblinhunters:manches) est préservée par défaut — ajouter
// --manches pour l'effacer aussi (utile en phase de test).
//
// Usage :
//   node scripts/resetGoblinHunters.js             — reset normal, garde l'archive des manches
//   node scripts/resetGoblinHunters.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGoblinHunters } from "../backend/services/goblinhunters.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetGoblinHunters({ clearManches: CLEAR_MANCHES });
    console.log(
      `Goblin Hunters remis à zéro : plus de partie active, inscriptions et historique effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
