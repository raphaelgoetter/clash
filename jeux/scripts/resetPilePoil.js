#!/usr/bin/env node
// resetPilePoil.js
// Remet à zéro Pile Poil. Par défaut, seulement les clés du salon de test
// (pilepoil:test:*) : le jeu public tourne en permanence.
//
// Usage :
//   node jeux/scripts/resetPilePoil.js            — efface les clés de test
//   node jeux/scripts/resetPilePoil.js --public   — DESTRUCTIF : efface aussi le jeu public
//                                                   (égalités, essais, séries, classements)

import "../env.js";

import { resetPilePoil } from "../services/pilepoil.js";

const PUBLIC = process.argv.includes("--public");

(async () => {
  try {
    await resetPilePoil("test");
    if (PUBLIC) await resetPilePoil("public");
    console.log(PUBLIC ? "Pile Poil remis à zéro (test ET public)." : "Pile Poil : clés de test effacées (jeu public intact).");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
