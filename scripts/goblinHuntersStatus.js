#!/usr/bin/env node
// goblinHuntersStatus.js
// Affiche l'état courant de Goblin Hunters (phase, inscrits ou roster
// complet avec camps/rôles/PV/positions, progression des actions du jour)
// sans avoir besoin d'ouvrir Discord. ⚠️ Usage ADMIN UNIQUEMENT — spoile les
// camps/rôles de tous les joueurs, ne jamais partager cette sortie avec les
// joueurs en cours de partie (voir CONTRIBUTING.md).
//
// Usage : node scripts/goblinHuntersStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadGoblinHuntersConfig, readState, listInscriptions, readActions } from "../backend/services/goblinhunters.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Goblin Hunters active pour le moment.");
    return;
  }

  const config = await loadGoblinHuntersConfig();

  if (state.phase === "inscription") {
    const inscriptions = await listInscriptions();
    console.log(`Phase : inscription — clôture le ${state.closingAt}`);
    console.log(`${inscriptions.length}/${config.effectif_max} inscrits (minimum ${config.effectif_min}) :\n`);
    inscriptions.forEach((i) => console.log(`  ${i.username} (${i.discordId})`));
    return;
  }

  if (state.termine) {
    console.log("Partie terminée.");
    return;
  }

  console.log(`⚠️  SORTIE ADMIN — révèle les camps/rôles, ne jamais partager avec les joueurs.\n`);
  console.log(`Jour ${state.jour}/${config.duree_jours}\n`);

  for (const j of state.joueurs) {
    const camp = config.camps[j.camp];
    const roleLabel = j.role ? ` [${config.roles[j.role].label}]` : "";
    const statut = j.alive ? `${j.pv}/${j.pvMax} PV @ ${j.position}` : `☠️ éliminé(e) (jour ${j.campReveleAt})`;
    console.log(`  ${camp.emoji} ${j.username}${roleLabel} — ${statut}`);
  }

  const actions = await readActions(state.jour);
  const vivants = state.joueurs.filter((j) => j.alive);
  console.log(`\nActions soumises aujourd'hui : ${Object.keys(actions).length}/${vivants.length}`);
  for (const j of vivants) {
    const a = actions[j.discordId];
    if (!a) {
      console.log(`  ${j.username} : —`);
      continue;
    }
    const primary = a.primary ? `${a.primary.lieu}${a.primary.cibleId ? ` → ${a.primary.cibleId}` : ""}` : "—";
    const secondary = a.secondary ? ` + ${a.secondary.lieu}${a.secondary.cibleId ? ` → ${a.secondary.cibleId}` : ""}` : "";
    console.log(`  ${j.username} : ${primary}${secondary}`);
  }
})();
