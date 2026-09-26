#!/usr/bin/env node
// gobeletDuelWatchdog.js
// Nettoie une partie du Jeu du Gobelet Duel bloquée depuis plus de
// STALE_HOURS (2h) sans aucune action — manche jamais terminée faute d'un
// joueur qui ne revient pas, ou partie jamais reprise.
//
// 100% manuel : aucun workflow GitHub Actions n'appelle ce script (même
// principe que blackjackDuelWatchdog.js — retour utilisateur explicite sur
// Blackjack Duel : "je ne souhaite absolument pas de cron/action pour
// cela"). Voir `npm run gobeletduel:status` pour décider s'il est temps de
// le lancer.
//
// Usage : node scripts/gobeletDuelWatchdog.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetIfStale } from "../backend/services/gobeletDuel.js";

(async () => {
  try {
    const result = await resetIfStale();
    if (result.reset) {
      console.log(`Gobelet Duel : partie inactive depuis ${result.hoursSince.toFixed(1)}h, remise à zéro.`);
    } else if (result.hoursSince != null) {
      console.log(`Gobelet Duel : partie active, inactive depuis ${result.hoursSince.toFixed(1)}h (< 2h) — rien à faire.`);
    } else {
      console.log("Gobelet Duel : aucune partie en cours — rien à faire.");
    }
  } catch (err) {
    console.error("Échec du watchdog Gobelet Duel :", err.message);
    process.exit(1);
  }
})();
