#!/usr/bin/env node
// bossRaidStatus.js
// Affiche l'état courant de Boss Raid (phase, jour, posture du Boss, score
// cumulé, votes du jour) ainsi qu'une projection du Jour suivant basée sur
// les votes actuels, sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run bossraid:public`. Comme pour le Tamagoshi/Robinson, ce script
// tient lieu d'affichage admin (le bouton Journal ne montre lui que
// le score et l'historique, jamais le détail des votants).
//
// Usage : node scripts/bossRaidStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadBossRaidConfig,
  readState,
  tallyVotes,
  listVotes,
  previewCloture,
  activeEventForDay,
} from "../backend/services/bossraid.js";
import { ULTIMATE_NAMES, ULTIMATE_EFFECTS } from "../api/discord/_handlers/bossraid.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Boss Raid active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Raid déjà terminé.");
    return;
  }

  const config = await loadBossRaidConfig();

  if (state.phase === "annonce") {
    console.log("Phase : annonce (le combat commence au prochain post).\n");
  } else {
    console.log(`Jour ${state.jour}/${config.duree_jours}\n`);
  }

  console.log(`🛡️ Défense    : ${state.bossStats.defense}/10`);
  console.log(`🔮 Résistance : ${state.bossStats.resistance}/10`);
  console.log(`🏆 Dégâts cumulés : ${state.totalDegatsCumules}\n`);

  if (state.phase !== "combat") return;

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
  for (const [id, role] of Object.entries(config.roles)) {
    const votants = votes.filter((v) => v.roleId === id);
    console.log(`${role.emoji} ${role.label} — ${voteCounts[id] || 0} vote${(voteCounts[id] || 0) > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} votant${votes.length > 1 ? "s" : ""} aujourd'hui.`);

  // Projection : clôture le jour EN COURS avec les votes actuels (lecture
  // seule, previewCloture n'écrit rien) — même calcul que le bouton Espion.
  // Ne préjuge pas des votes qui arriveront encore avant 08:00 UTC.
  const projection = await previewCloture(state.jour, config);
  console.log(`\n🔮 Projection si la clôture avait lieu maintenant :`);
  console.log(`💥 Dégâts infligés aujourd'hui : ${projection.totalDamageDuJour}`);
  if (projection.allIn) {
    console.log(`⚡ Ultime déclenchée : ${ULTIMATE_NAMES[projection.allIn]} — ${ULTIMATE_EFFECTS[projection.allIn]}.`);
  }
  console.log(`\n→ Jour ${state.jour + 1}/${config.duree_jours} :`);
  console.log(`  🛡️ Défense    : ${projection.bossStatsApres.defense}/10`);
  console.log(`  🔮 Résistance : ${projection.bossStatsApres.resistance}/10`);
  console.log(`  🏆 Dégâts cumulés : ${projection.totalDegatsApres}`);

  const lendemain = activeEventForDay(state.jour + 1, config.evenements_boss);
  if (lendemain) {
    console.log(`  📯 Événement prévu : ${lendemain.emoji} ${lendemain.nom} — ${lendemain.description}`);
  }
})();
