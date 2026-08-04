#!/usr/bin/env node
// resetBossRaid.js
// Remet à zéro Boss Raid : plus de partie active (la prochaine publication
// repart du jour d'annonce), votes, dernier rôle finalisé et historique
// effacés. L'archive des manches passées (bossraid:manches) est préservée
// par défaut — ajouter --manches pour l'effacer aussi (utile en phase de
// test, pour ne pas polluer l'archive avec des manches de test avant le
// vrai lancement).
//
// Usage :
//   node scripts/resetBossRaid.js             — reset normal, garde l'archive des manches
//   node scripts/resetBossRaid.js --manches   — reset complet, efface aussi l'archive des manches

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetBossRaid } from "../backend/services/bossraid.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetBossRaid({ clearManches: CLEAR_MANCHES });
    console.log(
      `Boss Raid remis à zéro : plus de partie active, historique effacé${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
