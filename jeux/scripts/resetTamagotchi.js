#!/usr/bin/env node
// resetTamagotchi.js
// Remet à zéro le Tamagoshi (Bébé Dragon "Lilith") : plus de journée active
// (la prochaine publication repart du Jour 1 avec les jauges initiales de
// tamagotchi.json), votes et historique effacés. L'archive des manches
// passées (tamagotchi:manches) est préservée par défaut — ajouter
// --manches pour l'effacer aussi (utile en phase de test, pour ne pas
// polluer l'archive avec des manches de test avant le vrai lancement).
//
// Usage :
//   node jeux/scripts/resetTamagotchi.js             — reset normal, garde l'archive des manches
//   node jeux/scripts/resetTamagotchi.js --manches   — reset complet, efface aussi l'archive des manches

import "../env.js";

import { resetTamagotchi } from "../services/tamagotchi.js";

const CLEAR_MANCHES = process.argv.includes("--manches");

(async () => {
  try {
    await resetTamagotchi({ clearManches: CLEAR_MANCHES });
    console.log(
      `Tamagoshi remis à zéro : plus de journée active, historique effacé${CLEAR_MANCHES ? ", archive des manches effacée" : " (archive des manches conservée)"}.`,
    );
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
