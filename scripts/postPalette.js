#!/usr/bin/env node
// postPalette.js [TEST]
// Poste manuellement une manche du jeu Palette (devine la couleur
// dominante d'une carte parmi 4 propositions). Pas de workflow GitHub
// Actions pour l'instant (décision explicite, phase [TEST]) : lancement
// uniquement à la main, sur le salon de test.
//
// Usage :
//   node scripts/postPalette.js               — poste sur le salon de test
//   node scripts/postPalette.js --dry-run      — aperçu console, sans écrire ni poster
//   node scripts/postPalette.js --force        — ignore le garde-fou anti-double-post (6h)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postPalette } from "../api/discord/_handlers/palette.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const channelId = process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error("Variable d'environnement manquante : DISCORD_CHANNEL_FRAME_TEST");
  process.exit(1);
}

(async () => {
  try {
    const result = await postPalette(channelId, { dryRun: DRY_RUN, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) :`);
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
