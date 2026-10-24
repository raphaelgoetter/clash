#!/usr/bin/env node
// postPlatPays.js
// Poste manuellement une nouvelle manche du jeu Plat Pays (devine le pays
// d'origine d'un plat à partir de sa photo). En production, la publication passe par
// jeux/scripts/postJeuxVisuels.js (orchestrateur du groupe) ; ce script sert
// aux tests et aux rattrapages.
//
// Usage :
//   node jeux/scripts/postPlatPays.js               — poste sur le salon de test
//   node jeux/scripts/postPlatPays.js --public       — poste sur le salon public
//   node jeux/scripts/postPlatPays.js --dry-run      — aperçu console, sans écrire ni poster
//   node jeux/scripts/postPlatPays.js --force        — ignore le garde-fou anti-double-post
//   node jeux/scripts/postPlatPays.js --no-ping      — poste sans pinger @MINI-JEUX

import "../env.js";

import { postPlatPays } from "../discord/handlers/platpays.js";

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
    const result = await postPlatPays(channelId, { dryRun: DRY_RUN, noPing: NO_PING, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) : n° ${result.entry.numero} → ${result.entry.plat} (${result.entry.pays})`);
      console.log(`  Ping @MINI-JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée dans ${channelId} — ${result.entry.plat} (${result.entry.pays}) (message ${result.message.id})`);
  } catch (err) {
    console.error("Échec de la publication Plat Pays :", err.message);
    process.exit(1);
  }
})();
