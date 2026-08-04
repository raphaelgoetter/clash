#!/usr/bin/env node
// resetBossRaid.js
// Remet à zéro Boss Raid : plus de partie active (la prochaine publication
// repart du jour d'annonce), votes, dernier rôle finalisé et historique
// effacés.
//
// Usage : node scripts/resetBossRaid.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetBossRaid } from "../backend/services/bossraid.js";

(async () => {
  try {
    await resetBossRaid();
    console.log("Boss Raid remis à zéro : plus de partie active, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
