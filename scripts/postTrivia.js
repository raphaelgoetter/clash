#!/usr/bin/env node
// postTrivia.js
// Poste manuellement (ou via cron) une nouvelle manche du jeu Trivia (QCM de
// culture Clash Royale, 4 propositions A/B/C/D). En alternance une saison
// sur deux avec Frame — voir backend/services/jeuxculture.js et
// scripts/postJeuxCulture.js, seul point d'entrée en production. Ce script
// reste utile pour tester Trivia seul, en dehors de l'orchestrateur (comme
// postPalette.js pour Palette).
//
// Usage :
//   node scripts/postTrivia.js               — poste sur le salon de test
//   node scripts/postTrivia.js --public       — poste sur le salon public
//   node scripts/postTrivia.js --dry-run      — aperçu console, sans écrire ni poster
//   node scripts/postTrivia.js --force        — ignore le garde-fou anti-double-post
//   node scripts/postTrivia.js --public --dry-run
//   node scripts/postTrivia.js --no-ping      — poste sans pinger @MINI-JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postTrivia } from "../api/discord/_handlers/trivia.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
// Jamais de ping sur le salon de test, même sans --no-ping explicite (voir
// postPalette.js pour le même garde-fou).
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
    const result = await postTrivia(channelId, { dryRun: DRY_RUN, noPing: NO_PING, force: FORCE });

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

    console.log(`Manche postée dans ${channelId} — "${result.entry.question}" (message ${result.message.id})`);
  } catch (err) {
    console.error("Échec de la publication Trivia :", err.message);
    process.exit(1);
  }
})();
