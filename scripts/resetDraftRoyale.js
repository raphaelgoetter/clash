#!/usr/bin/env node
// resetDraftRoyale.js
// Remet à zéro le Draft Royale : plus de draft actif (la prochaine
// publication repart du jour de présentation), joueurs/actions/marchés/historique
// effacés. L'archive des manches passées (draftroyale:manches) est préservée
// par défaut — ajouter --manches pour l'effacer aussi (utile en phase de
// test, pour ne pas polluer l'archive avec des manches de test).
//
// Usage :
//   node scripts/resetDraftRoyale.js             — reset normal, garde l'archive des manches
//   node scripts/resetDraftRoyale.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetDraftRoyale } from "../backend/services/draftroyale.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetDraftRoyale({ clearManches: CLEAR_MANCHES });
    console.log(
      `Draft Royale remis à zéro : plus de draft actif, joueurs/historique effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
