#!/usr/bin/env node
// marioClashStatus.js
// Affiche l'état courant de Mario Clash (phase, jour, classement, actions du
// jour déjà enregistrées) sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run marioclash:public`.
//
// Usage : node scripts/marioClashStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadMarioClashConfig, readState, readJoueurs, readActions } from "../backend/services/marioclash.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune course Mario Clash active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Course déjà terminée.");
    return;
  }

  const config = await loadMarioClashConfig();

  if (state.phase === "annonce") {
    console.log("Phase : présentation (la course commence au prochain post).\n");
    return;
  }

  console.log(`Jour ${state.jour}/${config.duree_jours}\n`);

  const joueurs = await readJoueurs();
  const ranking = Object.entries(joueurs)
    .map(([discordId, j]) => ({ discordId, ...j }))
    .sort((a, b) => b.position - a.position || a.username.localeCompare(b.username));

  if (!ranking.length) {
    console.log("Aucun joueur n'a encore rejoint la course.");
  } else {
    console.log("Classement :");
    ranking.forEach((j, i) => {
      const objet = j.objet ? ` [${config.objets[j.objet]?.label}]` : "";
      console.log(`  ${i + 1}. ${j.username} — case ${j.position}/${config.case_arrivee}, ${j.points} pt(s)${objet}`);
    });
  }

  const actions = await readActions(state.jour);
  const nbActions = Object.keys(actions).length;
  console.log(`\nActions enregistrées aujourd'hui : ${nbActions} joueur(s).`);
  for (const [discordId, action] of Object.entries(actions)) {
    const username = joueurs[discordId]?.username || discordId;
    const parts = [];
    if (action.dice) parts.push("🎲 dé");
    if (action.item) parts.push("🎒 objet");
    if (action.spell) parts.push("✨ sort");
    console.log(`  - ${username} : ${parts.join(", ") || "(aucune)"}`);
  }
})();
