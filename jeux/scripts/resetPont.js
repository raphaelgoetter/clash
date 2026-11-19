#!/usr/bin/env node
// resetPont.js
// Remet à zéro le Pont du Troll : plus de partie active, choix, Jokers,
// Indices, pièces et historique effacés. L'archive des parties
// (pont:manches) est conservée, sauf avec --manches.
//
// Usage :
//   node jeux/scripts/resetPont.js            — garde l'archive des parties
//   node jeux/scripts/resetPont.js --manches  — efface aussi l'archive

import "../env.js";

import { resetPont } from "../services/pont.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetPont({ clearManches: CLEAR_MANCHES });
    console.log(`Pont du Troll remis à zéro${CLEAR_MANCHES ? ", archive des parties effacée" : " (archive des parties conservée)"}.`);
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
