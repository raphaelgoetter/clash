#!/usr/bin/env node
// resetRobinson.js
// Remet à zéro Robinson : plus de jour actif (la prochaine publication
// repart du Jour 1 avec les stocks initiaux de robinson.json), votes,
// économie et historique effacés. L'archive des manches passées
// (robinson:manches) est préservée par défaut — ajouter --manches pour
// l'effacer aussi (utile en phase de test, pour ne pas polluer l'archive
// avec des manches de test avant le vrai lancement).
//
// Usage :
//   node scripts/resetRobinson.js             — reset normal, garde l'archive des manches
//   node scripts/resetRobinson.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetRobinson } from "../backend/services/robinson.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetRobinson({ clearManches: CLEAR_MANCHES });
    console.log(
      `Robinson remis à zéro : plus de jour actif, historique effacé${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
