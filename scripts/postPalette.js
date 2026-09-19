#!/usr/bin/env node
// postPalette.js
// Poste manuellement (ou via cron) une nouvelle manche du jeu Palette
// (devine la couleur dominante d'une carte parmi 4 propositions). En
// alternance une saison sur deux avec Zoom carte — voir
// backend/services/jeuxvisuels.js et scripts/postJeuxVisuels.js, seul point
// d'entrée en production. Ce script reste utile pour tester Palette seul,
// en dehors de l'orchestrateur (comme postPeleMele.js pour Pêle-mêle).
//
// Usage :
//   node scripts/postPalette.js               — poste sur le salon de test
//   node scripts/postPalette.js --public       — poste sur le salon public
//   node scripts/postPalette.js --dry-run      — aperçu console, sans écrire ni poster
//   node scripts/postPalette.js --force        — ignore le garde-fou anti-double-post
//   node scripts/postPalette.js --public --dry-run
//   node scripts/postPalette.js --no-ping      — poste sans pinger @MINI-JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postPalette } from "../api/discord/_handlers/palette.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
// Jamais de ping sur le salon de test, même sans --no-ping explicite (voir
// postZoom.js/postTamagotchi.js pour le même garde-fou).
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
    const result = await postPalette(channelId, { dryRun: DRY_RUN, noPing: NO_PING, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) :`);
      console.log(`  Ping @MINI-JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée dans ${channelId} — "${result.entry.fr}" (message ${result.message.id})`);
  } catch (err) {
    console.error("Échec de la publication Palette :", err.message);
    process.exit(1);
  }
})();
