#!/usr/bin/env node
// resetQuiz.js
// Remet à zéro le Quiz thématique : plus de manche active (la prochaine
// publication repart du Jour 1 de la thématique suivante), votes effacés.
// L'archive des manches passées (quiz:manches) est préservée par défaut —
// ajouter --manches pour l'effacer aussi (utile en phase de test, pour ne
// pas polluer l'archive avec des manches de test).
//
// Usage :
//   node scripts/resetQuiz.js             — reset normal, garde l'archive des manches
//   node scripts/resetQuiz.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetQuiz } from "../backend/services/quiz.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetQuiz({ clearManches: CLEAR_MANCHES });
    console.log(
      `Quiz remis à zéro : plus de manche active${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
