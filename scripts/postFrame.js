#!/usr/bin/env node
// postFrame.js
// Poste manuellement (ou via cron) une nouvelle partie du jeu Frame.
// Aucune commande Discord associée : c'est l'unique déclencheur de
// publication, en phase de test comme en production.
//
// Usage :
//   node scripts/postFrame.js                — poste sur le salon de test
//   node scripts/postFrame.js --public        — poste sur le salon public
//   node scripts/postFrame.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postFrame.js --public --dry-run

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postFrame } from "../api/discord/handlers/frames.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");

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
    const result = await postFrame(channelId, { dryRun: DRY_RUN });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine partie (salon ${channelId}) :`);
      console.log(`  Film : ${result.frameEntry.titre} (${result.frameEntry.image})`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    console.log(
      `Partie postée dans ${channelId} — ${result.frameEntry.image} (message ${result.message.id})`,
    );
  } catch (err) {
    console.error("Échec de la publication Frame :", err.message);
    process.exit(1);
  }
})();
