#!/usr/bin/env node
// postConcept.js
// Poste manuellement une nouvelle manche du jeu Concept (devine le concept
// caché derrière une suite d'emojis). En production, la publication passe
// par jeux/scripts/postJeuxDeLettres.js (orchestrateur du groupe) ; ce
// script sert aux tests et aux rattrapages.
//
// Usage :
//   node jeux/scripts/postConcept.js               — poste sur le salon de test
//   node jeux/scripts/postConcept.js --public       — poste sur le salon public
//   node jeux/scripts/postConcept.js --dry-run      — aperçu console, sans écrire ni poster
//   node jeux/scripts/postConcept.js --force        — ignore le garde-fou anti-double-post
//   node jeux/scripts/postConcept.js --no-ping      — poste sans pinger @MINI-JEUX

import "../env.js";

import { postConcept } from "../discord/handlers/concept.js";

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
    const result = await postConcept(channelId, { dryRun: DRY_RUN, noPing: NO_PING, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) : ${result.entry.emojis} → ${result.entry.reponse}`);
      console.log(`  Ping @MINI-JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée dans ${channelId} — ${result.entry.reponse} (message ${result.message.id})`);
  } catch (err) {
    console.error("Échec de la publication Concept :", err.message);
    process.exit(1);
  }
})();
