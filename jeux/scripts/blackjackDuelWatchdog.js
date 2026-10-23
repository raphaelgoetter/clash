#!/usr/bin/env node
// blackjackDuelWatchdog.js
// Nettoie automatiquement une partie de Blackjack Duel bloquée depuis plus
// de STALE_HOURS (1h) sans aucune action — manche jamais terminée faute
// d'un joueur qui ne revient pas, ou partie jamais reprise. Appelé toutes
// les 30 minutes par .github/workflows/blackjack-duel-watchdog.yml.
//
// Usage : node jeux/scripts/blackjackDuelWatchdog.js


import "../env.js";
import { resetIfStale } from "../services/blackjackDuel.js";

(async () => {
  try {
    const result = await resetIfStale();
    if (result.reset) {
      console.log(
        `Blackjack Duel : partie inactive depuis ${result.hoursSince.toFixed(1)}h, remise à zéro.`,
      );
    } else if (result.hoursSince != null) {
      console.log(
        `Blackjack Duel : partie active, inactive depuis ${result.hoursSince.toFixed(1)}h (< 1h) — rien à faire.`,
      );
    } else {
      console.log("Blackjack Duel : aucune partie en cours — rien à faire.");
    }
  } catch (err) {
    console.error("Échec du watchdog Blackjack Duel :", err.message);
    process.exit(1);
  }
})();
