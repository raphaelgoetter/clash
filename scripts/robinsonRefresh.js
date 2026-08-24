#!/usr/bin/env node
// robinsonRefresh.js
// Réédite en place le message Robinson déjà publié, à partir de l'état
// courant (stocks, radeau, votes, événement) — sans clôturer le jour actif,
// sans consommer les votes, sans écrire d'historique. Utile pour corriger un
// texte statique (embed, intro) après un fix côté code, quand le message du
// jour est déjà en ligne et qu'on ne veut pas attendre le prochain cron pour
// que le nouveau texte apparaisse. Contrairement à `npm run robinson:public`,
// qui appelle postRobinson() et fait donc avancer la partie d'un jour.
//
// Usage :
//   node scripts/robinsonRefresh.js            — réédite le message en ligne
//   node scripts/robinsonRefresh.js --dry-run  — aperçu console, aucun appel Discord

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, loadRobinsonConfig } from "../backend/services/robinson.js";
import { refreshPublicMessage } from "../api/discord/_handlers/robinson.js";

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Robinson active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée, rien à réafficher.");
    return;
  }

  if (DRY_RUN) {
    console.log(`DRY-RUN — réafficherait le Jour ${state.jour} sur le salon ${state.channelId} (message ${state.messageId}), sans rien écrire.`);
    return;
  }

  const config = await loadRobinsonConfig();
  await refreshPublicMessage(state, config, process.env.DISCORD_TOKEN);
  console.log(`Jour ${state.jour} réaffiché dans ${state.channelId} (message ${state.messageId}).`);
})();
