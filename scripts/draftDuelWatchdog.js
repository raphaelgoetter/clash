#!/usr/bin/env node
// draftDuelWatchdog.js
// Nettoie une partie de Draft (duel) bloquée sans aucune action depuis
// `duel.stale_heures`. 100% manuel, aucun workflow GitHub Actions ne
// l'appelle (même principe que gobeletDuelWatchdog.js). Voir
// `npm run draftduel:status` pour décider.
//
// Usage : node scripts/draftDuelWatchdog.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetIfStale } from "../backend/services/draftDuel.js";

(async () => {
  try {
    const result = await resetIfStale();
    if (result.reset) {
      console.log(`Draft : partie inactive depuis ${result.hoursSince.toFixed(1)}h, remise à zéro.`);
    } else if (result.hoursSince != null) {
      console.log(`Draft : partie active, inactive depuis ${result.hoursSince.toFixed(1)}h, rien à faire.`);
    } else {
      console.log("Draft : aucune partie en cours, rien à faire.");
    }
  } catch (err) {
    console.error("Échec du watchdog Draft :", err.message);
    process.exit(1);
  }
})();
