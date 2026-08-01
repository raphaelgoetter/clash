#!/usr/bin/env node
// tamagotchiStatus.js
// Affiche l'état courant du Tamagoshi (jauges, étoiles, votes du jour) sans
// avoir besoin d'ouvrir Discord — pratique pour suivre l'avancement avant de
// décider de relancer manuellement `npm run tamagotchi:public`. Ce jeu n'a
// pas de bouton "Historique" dans Discord, ce script en tient lieu côté
// admin (comme scripts/aventureVotes.js pour l'Aventure).
//
// Usage : node scripts/tamagotchiStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadTamagotchiConfig, readState, tallyVotes, listVotes } from "../backend/services/tamagotchi.js";
import { renderGaugeBar } from "../api/discord/handlers/tamagotchi.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucun Tamagoshi actif pour le moment.");
    return;
  }
  if (state.termine) {
    console.log(`Défi déjà terminé — ${state.starTotal} étoiles de dressage.`);
    return;
  }

  const config = await loadTamagotchiConfig();
  console.log(`Jour ${state.jour}/${config.duree_jours} — ⭐ ${state.starTotal} étoile(s) de dressage\n`);
  console.log(`🔥 Estomac : ${renderGaugeBar(state.gauges.estomac)}`);
  console.log(`⚡ Énergie : ${renderGaugeBar(state.gauges.energie)}`);
  console.log(`🥨 Moral   : ${renderGaugeBar(state.gauges.moral)}\n`);

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
    if (action.is_info_action) continue;
    const votants = votes.filter((v) => v.actionId === id);
    console.log(`${action.emoji} ${action.label} — ${voteCounts[id] || 0} vote${(voteCounts[id] || 0) > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} vote${votes.length > 1 ? "s" : ""} aujourd'hui.`);
})();
