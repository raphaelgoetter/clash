#!/usr/bin/env node
// resetPoll.js
// Supprime les messages de sondage déjà postés (best-effort) et efface
// l'état — repart de zéro pour un prochain poll:test ou poll:public.
//
// Usage : node scripts/resetPoll.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetPoll } from "../api/discord/_handlers/poll.js";

(async () => {
  try {
    const result = await resetPoll();
    if (!result.hadState) {
      console.log("Aucun sondage actif à remettre à zéro.");
      return;
    }
    console.log(
      `Sondage remis à zéro : ${result.messagesDeleted}/${result.totalMessages} message(s) supprimé(s).`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
