#!/usr/bin/env node
// bossRaidStatus.js
// Affiche l'état courant de Boss Raid (phase, jour, posture du Boss, score
// cumulé, votes du jour) sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run bossraid:public`. Comme pour l'Aventure/le Tamagoshi/Robinson, ce
// script tient lieu d'affichage admin (le bouton Journal ne montre lui que
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
} from "../backend/services/bossraid.js";
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
})();
