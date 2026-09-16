#!/usr/bin/env node
// resetGobeletDuel.js
// Remet à zéro le Jeu du Gobelet Duel : efface la partie active (quel que
// soit son état ou son ancienneté), points, mains et verrous de résolution.
// Sert de filet manuel : une seule partie à la fois sur le serveur (voir
// backend/services/gobeletDuel.js) — si une partie reste bloquée (joueur qui
// ne revient pas, manche jamais résolue), lance cette commande pour la
// débloquer et permettre à /gobelet de relancer une nouvelle partie.
//
// Usage : node scripts/resetGobeletDuel.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetGobeletDuel } from "../backend/services/gobeletDuel.js";

(async () => {
  try {
    await resetGobeletDuel();
    console.log("Jeu du Gobelet Duel remis à zéro : plus de partie active, points et mains effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
