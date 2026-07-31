#!/usr/bin/env node
// aventureVotes.js
// Affiche le décompte des votes du chapitre actif de l'Aventure interactive,
// sans avoir besoin d'ouvrir Discord — pratique pour suivre l'avancement
// avant de décider de relancer manuellement `npm run aventure:public`.
//
// Usage : node scripts/aventureVotes.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadHistoire, readState, assignJourNumber, tallyVotes } from "../backend/services/aventure.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune aventure active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("L'aventure est déjà terminée (chapitre final atteint).");
    return;
  }

  const histoire = await loadHistoire();
  const chapitreEntry = histoire.chapitres[state.chapitreId];
  const jour = await assignJourNumber(state.chapitreId);
  const counts = await tallyVotes(state.chapitreId);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  console.log(`${chapitreEntry.titre} (jour ${jour})\n`);

  if (!chapitreEntry.choix?.length) {
    console.log("Ce chapitre n'a pas de choix (chapitre final).");
    return;
  }

  const rows = chapitreEntry.choix.map((c) => ({
    Choix: `${c.emoji ? c.emoji + " " : ""}${c.label}`,
    Votes: counts[c.id] || 0,
  }));

  console.table(rows);
  console.log(`Total : ${total} vote${total > 1 ? "s" : ""}.`);
})();
