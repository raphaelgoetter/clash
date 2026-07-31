#!/usr/bin/env node
// aventureVotes.js
// Affiche le décompte des votes du chapitre actif de l'Aventure interactive,
// sans avoir besoin d'ouvrir Discord — pratique pour suivre l'avancement
// avant de décider de relancer manuellement `npm run aventure:public`.
//
// Usage : node scripts/aventureVotes.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadHistoire, readState, assignJourNumber, listVotes } from "../backend/services/aventure.js";

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
  const votes = await listVotes(state.chapitreId);

  console.log(`${chapitreEntry.titre} (jour ${jour})\n`);

  if (!chapitreEntry.choix?.length) {
    console.log("Ce chapitre n'a pas de choix (chapitre final).");
    return;
  }

  for (const c of chapitreEntry.choix) {
    const votants = votes.filter((v) => v.choixId === c.id);
    const label = `${c.emoji ? c.emoji + " " : ""}${c.label}`;
    console.log(`${label} — ${votants.length} vote${votants.length > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} vote${votes.length > 1 ? "s" : ""}.`);
})();
