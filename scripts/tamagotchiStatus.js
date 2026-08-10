#!/usr/bin/env node
// tamagotchiStatus.js
// Affiche l'état courant du Tamagoshi (jauges, étoiles, votes du jour) ainsi
// qu'une projection du Jour suivant basée sur les votes actuels, sans avoir
// besoin d'ouvrir Discord — pratique pour suivre l'avancement avant de
// décider de relancer manuellement `npm run tamagotchi:public`. Ce jeu n'a
// pas de bouton "Historique" dans Discord, ce script en tient lieu côté
// admin (comme scripts/aventureVotes.js pour l'Aventure).
//
// Usage : node scripts/tamagotchiStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadTamagotchiConfig,
  readState,
  tallyVotes,
  listVotes,
  previewCloseDay,
  eventForDay,
  applyGaugeDelta,
} from "../backend/services/tamagotchi.js";
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
  console.log(`🔥 Estomac : ${renderGaugeBar(state.gauges.estomac)} ${state.gauges.estomac}%`);
  console.log(`⚡ Énergie : ${renderGaugeBar(state.gauges.energie)} ${state.gauges.energie}%`);
  console.log(`🥨 Moral   : ${renderGaugeBar(state.gauges.moral)} ${state.gauges.moral}%\n`);

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

  // Projection : clôture le jour EN COURS avec les votes actuels (lecture
  // seule, previewCloseDay n'écrit rien) — même calcul que --dry-run, sans
  // consommer les votes. Ne préjuge pas des votes qui arriveront encore
  // avant 08:00 UTC.
  const closure = await previewCloseDay(state, config);
  const jourSuivant = state.jour + 1;
  console.log(`\n🔮 Projection si la clôture avait lieu maintenant :`);
  console.log(`Bilan du Jour ${state.jour} : ${closure.rating.rating} (${closure.rating.starDelta >= 0 ? "+" : ""}${closure.rating.starDelta} ⭐)`);

  if (jourSuivant > config.duree_jours) {
    console.log(`→ Jour ${jourSuivant} : fin de partie, ${state.starTotal + closure.rating.starDelta} étoile(s) au total.`);
  } else {
    const event = eventForDay(jourSuivant, config.evenements_possibles);
    const gaugesProjetees = event ? applyGaugeDelta(closure.gaugesClosing, event.modificateur_jauges) : closure.gaugesClosing;
    console.log(`→ Jour ${jourSuivant}/${config.duree_jours} :`);
    if (event) console.log(`  📯 Événement : ${event.titre}`);
    console.log(`  🍭 Estomac : ${renderGaugeBar(gaugesProjetees.estomac)} ${gaugesProjetees.estomac}%`);
    console.log(`  ⚡ Énergie : ${renderGaugeBar(gaugesProjetees.energie)} ${gaugesProjetees.energie}%`);
    console.log(`  🥨 Moral   : ${renderGaugeBar(gaugesProjetees.moral)} ${gaugesProjetees.moral}%`);
  }
})();
