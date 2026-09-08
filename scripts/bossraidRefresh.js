#!/usr/bin/env node
// bossraidRefresh.js
// Réédite en place le message Boss Raid déjà publié, à partir de l'état
// courant (jour, votes, événement) — sans clôturer le jour actif, sans
// consommer les votes, sans écrire d'historique. Utile pour corriger un
// texte statique (embed, intro) après un fix côté code, quand le message du
// jour est déjà en ligne et qu'on ne veut pas attendre le prochain cron ou
// le prochain vote pour que le nouveau texte apparaisse. Contrairement à
// `npm run bossraid:public`, qui appelle postBossRaid() et fait donc avancer
// la partie d'un jour.
//
// Usage :
//   node scripts/bossraidRefresh.js            — réédite le message en ligne
//   node scripts/bossraidRefresh.js --dry-run  — aperçu console, aucun appel Discord

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, loadBossRaidConfig } from "../backend/services/bossraid.js";
import { refreshPublicMessage } from "../api/discord/_handlers/bossraid.js";

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Boss Raid active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée, rien à réafficher.");
    return;
  }
  if (state.phase !== "combat") {
    console.log(`Phase actuelle "${state.phase}" — rien à réafficher (le jour d'annonce n'a pas de message de combat).`);
    return;
  }

  if (DRY_RUN) {
    console.log(`DRY-RUN — réafficherait le Jour ${state.jour} sur le salon ${state.channelId} (message ${state.messageId}), sans rien écrire.`);
    return;
  }

  const config = await loadBossRaidConfig();
  await refreshPublicMessage(state, config, process.env.DISCORD_TOKEN);
  console.log(`Jour ${state.jour} réaffiché dans ${state.channelId} (message ${state.messageId}).`);
})();
