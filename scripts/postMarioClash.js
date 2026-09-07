#!/usr/bin/env node
// postMarioClash.js
// Poste manuellement (ou via cron) le jour de Mario Clash (course
// communautaire façon Mario Kart). Clôture d'abord le jour actif (s'il y en
// a un) : résout dé/objet/sort, vérifie la fin de course, puis publie le
// jour suivant (ou le message de fin de course).
//
// Usage :
//   node scripts/postMarioClash.js                — poste sur le salon de test
//   node scripts/postMarioClash.js --public        — poste sur le salon public
//   node scripts/postMarioClash.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postMarioClash.js --public --dry-run
//   node scripts/postMarioClash.js --no-ping       — poste sans pinger @MINI JEUX (jour de présentation uniquement)
//   node scripts/postMarioClash.js --require-active — ne fait rien si aucune course n'est déjà lancée (cron)
//   node scripts/postMarioClash.js --force          — ignore le garde-fou anti-double-avancée

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postMarioClash } from "../api/discord/_handlers/marioclash.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
const FORCE = process.argv.includes("--force") || !PUBLIC;
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe que les autres jeux
// spéciaux, voir CONTRIBUTING.md) plutôt que de provisionner un salon dédié.
const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postMarioClash(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE, force: FORCE });

    if (result.skipped) {
      if (result.reason === "tooSoonSinceLastClosure") {
        console.log(`Jour ouvert trop récemment (${result.publishedAt}) pour être re-clôturé. Rien n'est posté. Utilise --force si ce rattrapage est volontaire.`);
      } else {
        console.log("Aucune course active, rien à poster (cron sans lancement manuel préalable).");
      }
      return;
    }
    if (result.wrongChannel) {
      console.error(
        `Une course est déjà active sur un AUTRE salon (${result.activeChannelId}) — rien n'est posté ici. ` +
          `Si c'était une course de test oubliée, lance "npm run marioclash:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }
    if (result.termine) {
      console.log("Course déjà terminée, rien à poster.");
      return;
    }
    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.final) {
      console.log(`Fin de la course postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }
    console.log(`Jour ${result.jour ?? "de présentation"} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
