#!/usr/bin/env node
// resetElixirDuel.js
// Remet à zéro le jeu Élixir : efface la partie active (quel que soit son
// état ou son ancienneté), joueurs, offres et verrous de résolution. Filet
// manuel, même principe que resetGobeletDuel.js (une seule partie à la fois
// sur le serveur). Le high score n'est jamais effacé.
//
// Usage : node scripts/resetElixirDuel.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetElixirDuel } from "../backend/services/elixirDuel.js";

(async () => {
  try {
    await resetElixirDuel();
    console.log("Élixir remis à zéro : plus de partie active, joueurs et offres effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
