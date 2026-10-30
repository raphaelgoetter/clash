#!/usr/bin/env node
// resetBlackjackDuel.js
// Efface toutes les parties de Blackjack Duel en cours (points, mains,
// verrous de résolution), quel que soit leur état ; le high score est
// préservé. Rarement utile : chaque partie expire d'elle-même 1 h après la
// dernière action (voir jeux/services/blackjackDuel.js).
//
// Usage : node jeux/scripts/resetBlackjackDuel.js

import "../env.js";

import { resetBlackjackDuel } from "../services/blackjackDuel.js";

(async () => {
  try {
    await resetBlackjackDuel();
    console.log("Blackjack Duel remis à zéro : plus de partie active, points et mains effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
