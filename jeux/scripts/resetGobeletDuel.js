#!/usr/bin/env node
// resetGobeletDuel.js
// Efface toutes les parties du Jeu du Gobelet Duel en cours (points,
// mains, verrous de résolution), quel que soit leur état ; le high score
// est préservé. Rarement utile : chaque partie expire d'elle-même 1 h après
// la dernière action (voir jeux/services/gobeletDuel.js).
//
// Usage : node jeux/scripts/resetGobeletDuel.js

import "../env.js";

import { resetGobeletDuel } from "../services/gobeletDuel.js";

(async () => {
  try {
    await resetGobeletDuel();
    console.log("Jeu du Gobelet Duel remis à zéro : plus de partie active, points et mains effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
