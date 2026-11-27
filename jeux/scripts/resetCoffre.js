#!/usr/bin/env node
// resetCoffre.js
// Remet à zéro Le Coffre : plus de partie active, codes, essais, points et
// historique effacés. L'archive des parties (coffre:manches) est conservée,
// sauf avec --manches.
//
// Usage :
//   node jeux/scripts/resetCoffre.js            — garde l'archive des parties
//   node jeux/scripts/resetCoffre.js --manches  — efface aussi l'archive

import "../env.js";

import { resetCoffre } from "../services/coffre.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetCoffre({ clearManches: CLEAR_MANCHES });
    console.log(`Le Coffre remis à zéro${CLEAR_MANCHES ? ", archive des parties effacée" : " (archive des parties conservée)"}.`);
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
