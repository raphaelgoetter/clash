#!/usr/bin/env node
// resetDraftDuel.js
// Remet à zéro le jeu Draft (duel) : efface la partie active (quel que soit
// son état ou son ancienneté), joueurs, actions et verrous de résolution.
// Filet manuel, même principe que resetGobeletDuel.js (une seule partie à
// la fois sur le serveur). Le high score n'est jamais effacé.
//
// Usage : node scripts/resetDraftDuel.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetDraftDuel } from "../backend/services/draftDuel.js";

(async () => {
  try {
    await resetDraftDuel();
    console.log("Draft remis à zéro : plus de partie active, joueurs et actions effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
