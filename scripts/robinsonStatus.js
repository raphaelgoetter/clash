#!/usr/bin/env node
// robinsonStatus.js
// Affiche l'état courant de Robinson (stocks, radeau, votes du jour) sans
// avoir besoin d'ouvrir Discord — pratique pour suivre l'avancement avant de
// décider de relancer manuellement `npm run robinson:public`. Comme pour
// l'Aventure/le Tamagoshi, ce script tient lieu d'affichage admin (le bouton
// Journal de Bord ne montre lui que les besoins et l'historique, jamais le
// détail des votants).
//
// Usage : node scripts/robinsonStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadRobinsonConfig,
  readState,
  readStocks,
  readRadeauPoints,
  computeRaftSections,
  tallyVotes,
  listVotes,
} from "../backend/services/robinson.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Robinson active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée.");
    return;
  }

  const config = await loadRobinsonConfig();
  const [stocks, radeauPoints] = await Promise.all([readStocks(), readRadeauPoints()]);
  const sections = computeRaftSections(radeauPoints, config.points_par_section);

  console.log(`Jour ${state.jour}/${config.duree_jours}${state.event ? ` — événement : ${state.event.nom}` : ""}\n`);
  console.log(`🐟 Nourriture : ${stocks.poisson}`);
  console.log(`💧 Eau        : ${stocks.eau}`);
  console.log(`🪵 Bois       : ${stocks.bois}`);
  console.log(`🛶 Radeau     : ${radeauPoints} pts (${sections}/${config.radeau_sections_max} sections)\n`);

  const votes = await listVotes(state.jour);
  // Pseudo actuel résolu en direct pour chaque votant (jamais celui figé au
  // moment du vote) — voir discordUsers.js. Repli sur le username stocké
  // (ou le discordId en dernier recours) si l'API Discord échoue.
  await Promise.all(
    votes.map(async (v) => {
      v.username = await resolveDisplayName(v.discordId, v.username || v.discordId);
    }),
  );

  const voteCounts = await tallyVotes(state.jour);
  for (const [id, action] of Object.entries(config.actions)) {
    const votants = votes.filter((v) => v.actionId === id);
    console.log(`${action.emoji} ${action.label} — ${voteCounts[id] || 0} vote${(voteCounts[id] || 0) > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} votant${votes.length > 1 ? "s" : ""} aujourd'hui.`);
})();
