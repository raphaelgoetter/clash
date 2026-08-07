#!/usr/bin/env node
// postZoom.js
// Poste manuellement (ou via cron) une nouvelle partie du jeu Zoom carte.
// Aucune commande Discord associée : c'est l'unique déclencheur de
// publication, en phase de test comme en production.
//
// Usage :
//   node scripts/postZoom.js                — poste sur le salon de test
//   node scripts/postZoom.js --public        — poste sur le salon public
//   node scripts/postZoom.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postZoom.js --public --dry-run
//   node scripts/postZoom.js --no-ping       — poste sans pinger @MINI JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postZoom } from "../api/discord/handlers/zoom.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const NO_PING = process.argv.includes("--no-ping");

const channelId = PUBLIC
  ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC
  : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(
    `Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`,
  );
  process.exit(1);
}

(async () => {
  try {
    const result = await postZoom(channelId, { dryRun: DRY_RUN, noPing: NO_PING });

    if (DRY_RUN) {
      if (result.seasonRecapEmbed) {
        console.log("DRY-RUN — récap de fin de saison qui serait posté AVANT la manche :");
        console.log(JSON.stringify({ embeds: [result.seasonRecapEmbed] }, null, 2));
        console.log("");
      }
      console.log(`DRY-RUN — prochaine partie (salon ${channelId}) :`);
      console.log(`  Carte gauche : ${result.entryA.answer} (${result.entryA.id})`);
      console.log(`  Carte droite : ${result.entryB.answer} (${result.entryB.id})`);
      console.log(`  Ping @MINI JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    console.log(
      `Partie postée dans ${channelId} — "${result.entryA.answer}" & "${result.entryB.answer}" (message ${result.message.id})`,
    );
  } catch (err) {
    console.error("Échec de la publication Zoom carte :", err.message);
    process.exit(1);
  }
})();
