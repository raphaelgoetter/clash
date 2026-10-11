#!/usr/bin/env node
// resetQuiEstCe.js
// Remet Qui est-ce ? à zéro : plus de partie active (la prochaine
// publication repart du jour de présentation), grille/joueurs/enquêtes
// effacés. L'archive des manches passées (quiestce:manches) est préservée
// par défaut — ajouter --manches pour l'effacer aussi (utile en phase de test).
//
// Usage :
//   node scripts/resetQuiEstCe.js             — reset normal, garde l'archive des manches
//   node scripts/resetQuiEstCe.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetQuiEstCe } from "../backend/services/quiestce.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetQuiEstCe({ clearManches: CLEAR_MANCHES });
    console.log(
      `Qui est-ce ? remis à zéro : plus de partie active, grille/joueurs effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
