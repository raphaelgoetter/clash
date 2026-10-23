#!/usr/bin/env node
// resetBlackjack.js
// Remet à zéro Blackjack : plus de jour actif (la prochaine publication
// repart du Jour 1), points cumulés, mains et historique effacés. L'archive
// des manches passées (blackjack:manches) est préservée par défaut — ajouter
// --manches pour l'effacer aussi (utile en phase de test, pour ne pas
// polluer l'archive avec des manches de test avant le vrai lancement).
//
// Usage :
//   node jeux/scripts/resetBlackjack.js             — reset normal, garde l'archive des manches
//   node jeux/scripts/resetBlackjack.js --manches   — reset complet, efface aussi l'archive des manches

import "../env.js";

import { resetBlackjack } from "../services/blackjack.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetBlackjack({ clearManches: CLEAR_MANCHES });
    console.log(
      `Blackjack remis à zéro : plus de jour actif, points et historique effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
