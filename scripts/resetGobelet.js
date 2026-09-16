#!/usr/bin/env node
// resetGobelet.js
// Remet à zéro le Jeu du Gobelet : plus de jour actif (la prochaine
// publication repart du Jour 1), points cumulés, mains et historique
// effacés. L'archive des manches passées (gobelet:manches) est préservée
// par défaut — ajouter --manches pour l'effacer aussi (utile en phase de
// test, pour ne pas polluer l'archive avec des manches de test avant le
// vrai lancement).
//
// Usage :
//   node scripts/resetGobelet.js             — reset normal, garde l'archive des manches
//   node scripts/resetGobelet.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGobelet } from "../backend/services/gobelet.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetGobelet({ clearManches: CLEAR_MANCHES });
    console.log(
      `Jeu du Gobelet remis à zéro : plus de jour actif, points et historique effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
