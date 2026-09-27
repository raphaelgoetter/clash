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

import { loadGoblinHuntersConfig, readState, listInscriptions, readActions, readPlayerIndices, revealedTargetsForDay } from "../backend/services/goblinhunters.js";

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
    inscriptions.forEach((i) => console.log(`  ${i.username}`));
    return;
  }

  if (state.termine) {
    console.log("Partie terminée.");
    return;
  }

  // Identifiant technique "camp_entrainement" affiché "arène" (plus lisible)
  const nomLieu = (lieu) => (lieu === "camp_entrainement" ? "arène" : lieu);

  console.log(`⚠️  SORTIE ADMIN — révèle les camps/rôles, ne jamais partager avec les joueurs.\n`);
  console.log(`Jour ${state.jour}/${config.duree_jours}`);
  const immune = state.joueurs.find((j) => j.discordId === state.immuneId);
  console.log(`Immunisé(e) du jour : ${immune ? immune.username : "aucun"}\n`);

  for (const j of state.joueurs) {
    const camp = config.camps[j.camp];
    const roleLabel = j.role ? ` [${config.roles[j.role].label}]` : "";
    const statut = j.alive ? `${j.pv}/${j.pvMax} PV @ ${nomLieu(j.position)}` : `☠️ éliminé(e) (jour ${j.campReveleAt})`;
    console.log(`  ${camp.emoji} ${j.username}${roleLabel} — ${statut}`);
  }

  const actions = await readActions(state.jour);
  const vivants = state.joueurs.filter((j) => j.alive);
  console.log(`\nActions soumises aujourd'hui : ${Object.keys(actions).length}/${vivants.length}`);
  // Pseudo de la cible plutôt que son discordId brut (illisible)
  const usernameById = new Map(state.joueurs.map((j) => [j.discordId, j.username]));
  const formatAction = (action) =>
    `${nomLieu(action.lieu)}${
      action.cibleId
        ? ` → ${usernameById.get(action.cibleId) || action.cibleId}`
        : action.pending
          ? " (cible pas encore choisie)"
          : ["camp_entrainement", "tour_de_guet"].includes(action.lieu)
            ? " (cible au hasard)"
            : ""
    }`;
  // Joueurs repérés à la Clairière à la clôture précédente (ciblables à
  // l'Arène aujourd'hui par ce joueur) — ceux d'aujourd'hui ne sont tirés
  // qu'à la prochaine clôture.
  const reperesDe = async (discordId) => {
    const ids = [...revealedTargetsForDay(await readPlayerIndices(discordId), state.jour - 1)];
    return ids.length
      ? ` (${ids.map((id) => usernameById.get(id) || id).join(", ")})`
      : "";
  };
  for (const j of vivants) {
    const a = actions[j.discordId];
    const reperes = await reperesDe(j.discordId);
    if (!a) {
      console.log(`  ${j.username} : —${reperes}`);
      continue;
    }
    const primary = a.primary ? formatAction(a.primary) : "—";
    const secondary = a.secondary ? ` + ${formatAction(a.secondary)}` : "";
    console.log(`  ${j.username} : ${primary}${secondary}${reperes}`);
  }
})();
