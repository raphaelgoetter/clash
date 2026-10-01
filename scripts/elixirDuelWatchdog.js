#!/usr/bin/env node
// elixirDuelWatchdog.js
// Nettoie une partie d'Élixir bloquée depuis plus de 2h sans aucune action.
// 100% manuel, aucun workflow GitHub Actions ne l'appelle (même principe que
// gobeletDuelWatchdog.js). Voir `npm run elixirduel:status` pour décider.
//
// Usage : node scripts/elixirDuelWatchdog.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetIfStale } from "../backend/services/elixirDuel.js";

(async () => {
  try {
    const result = await resetIfStale();
    if (result.reset) {
      console.log(`Élixir : partie inactive depuis ${result.hoursSince.toFixed(1)}h, remise à zéro.`);
    } else if (result.hoursSince != null) {
      console.log(`Élixir : partie active, inactive depuis ${result.hoursSince.toFixed(1)}h (< 2h), rien à faire.`);
    } else {
      console.log("Élixir : aucune partie en cours, rien à faire.");
    }
  } catch (err) {
    console.error("Échec du watchdog Élixir :", err.message);
    process.exit(1);
  }
})();
