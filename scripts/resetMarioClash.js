#!/usr/bin/env node
// resetMarioClash.js
// Remet à zéro Mario Clash : plus de course active (la prochaine
// publication repart du jour de présentation), joueurs/actions/historique
// effacés. L'archive des manches passées (marioclash:manches) est préservée
// par défaut — ajouter --manches pour l'effacer aussi (utile en phase de
// test, pour ne pas polluer l'archive avec des manches de test).
//
// Usage :
//   node scripts/resetMarioClash.js             — reset normal, garde l'archive des manches
//   node scripts/resetMarioClash.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetMarioClash } from "../backend/services/marioclash.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetMarioClash({ clearManches: CLEAR_MANCHES });
    console.log(
      `Mario Clash remis à zéro : plus de course active, joueurs/historique effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
