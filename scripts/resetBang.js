#!/usr/bin/env node
// resetBang.js
// Remet Bang! à zéro : plus de partie active (la prochaine publication
// repart du jour de présentation), pioche/joueurs/journal effacés.
// L'archive des manches passées (bang:manches) est préservée par défaut —
// ajouter --manches pour l'effacer aussi (utile en phase de test).
//
// Usage :
//   node scripts/resetBang.js             — reset normal, garde l'archive des manches
//   node scripts/resetBang.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetBang } from "../backend/services/bang.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetBang({ clearManches: CLEAR_MANCHES });
    console.log(
      `Bang! remis à zéro : plus de partie active, pioche/joueurs effacés${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
