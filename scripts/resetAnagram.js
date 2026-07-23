#!/usr/bin/env node
// resetAnagram.js
// Remet à zéro le jeu Anagram : plus de partie active (la prochaine partie
// repart à la première entrée de anagrams.json) et historique/scores effacés.
//
// Usage : node scripts/resetAnagram.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGame } from "../backend/services/anagrams.js";

(async () => {
  try {
    await resetGame();
    console.log("Jeu Anagram remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
