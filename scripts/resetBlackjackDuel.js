#!/usr/bin/env node
// resetBlackjackDuel.js
// Remet à zéro Blackjack Duel : efface la partie active (quel que soit son
// état ou son ancienneté), points, mains et verrous de résolution. Sert de
// filet manuel en remplacement du watchdog automatique (retiré le 12/09 —
// une seule partie à la fois sur le serveur, voir backend/services/
// blackjackDuel.js) : si une partie reste bloquée (joueur qui ne revient
// pas, manche jamais résolue), lance cette commande pour la débloquer et
// permettre à /blackjack de relancer une nouvelle partie.
//
// Usage : node scripts/resetBlackjackDuel.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetBlackjackDuel } from "../backend/services/blackjackDuel.js";

(async () => {
  try {
    await resetBlackjackDuel();
    console.log("Blackjack Duel remis à zéro : plus de partie active, points et mains effacés.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
