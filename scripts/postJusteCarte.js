#!/usr/bin/env node
// postJusteCarte.js
// Poste manuellement (ou via cron) une nouvelle partie du jeu La Juste Carte.
// Aucune commande Discord associée : c'est l'unique déclencheur de
// publication, en phase de test comme en production.
//
// Usage :
//   node scripts/postJusteCarte.js                — poste sur le salon de test
//   node scripts/postJusteCarte.js --public        — poste sur le salon public
//   node scripts/postJusteCarte.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postJusteCarte.js --public --dry-run
//   node scripts/postJusteCarte.js --no-ping       — poste sans pinger @MINI JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postJusteCarte } from "../api/discord/_handlers/lajustecarte.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Jamais de ping sur le salon de test, même sans --no-ping explicite (voir
// postTamagotchi.js pour le même garde-fou).
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

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
    const result = await postJusteCarte(channelId, { dryRun: DRY_RUN, noPing: NO_PING });

    if (DRY_RUN) {
      if (result.seasonRecapEmbed) {
        console.log("DRY-RUN — récap de fin de saison qui serait posté AVANT la manche :");
        console.log(JSON.stringify({ embeds: [result.seasonRecapEmbed] }, null, 2));
        console.log("");
      }
      console.log(`DRY-RUN — prochaine partie (salon ${channelId}) :`);
      console.log(`  Cartes éligibles dans le pool : ${result.catalogSize}`);
      console.log(`  Ping @MINI JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    console.log(
      `Partie postée dans ${channelId} — carte secrète "${result.entry.cardKey}" (message ${result.message.id})`,
    );
  } catch (err) {
    console.error("Échec de la publication La Juste Carte :", err.message);
    process.exit(1);
  }
})();
