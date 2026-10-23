#!/usr/bin/env node
// postSynopsis.js
// Poste manuellement une nouvelle manche du jeu Synopsis éclaté (devine le
// film ou la série à partir du pire synopsis possible). En production, la
// publication passe par jeux/scripts/postJeuxCulture.js (orchestrateur du
// groupe) ; ce script sert aux tests et aux rattrapages.
//
// Usage :
//   node jeux/scripts/postSynopsis.js               — poste sur le salon de test
//   node jeux/scripts/postSynopsis.js --public       — poste sur le salon public
//   node jeux/scripts/postSynopsis.js --dry-run      — aperçu console, sans écrire ni poster
//   node jeux/scripts/postSynopsis.js --force        — ignore le garde-fou anti-double-post
//   node jeux/scripts/postSynopsis.js --no-ping      — poste sans pinger @MINI-JEUX

import "../env.js";

import { postSynopsis } from "../discord/handlers/synopsis.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
// Jamais de ping sur le salon de test, même sans --no-ping explicite.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postSynopsis(channelId, { dryRun: DRY_RUN, noPing: NO_PING, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) : ${result.entry.variante} → ${result.entry.titre}`);
      console.log(`  Ping @MINI-JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée dans ${channelId} — ${result.entry.titre} (message ${result.message.id})`);
  } catch (err) {
    console.error("Échec de la publication Synopsis éclaté :", err.message);
    process.exit(1);
  }
})();
