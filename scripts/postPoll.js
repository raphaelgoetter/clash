#!/usr/bin/env node
// postPoll.js
// Poste les questions de data/poll/poll.json comme sondages natifs Discord
// distincts (un message par question), dans le salon de test ou public.
// Aucun ping associé : ce n'est pas un mini-jeu, juste un sondage ponctuel.
//
// Usage :
//   node scripts/postPoll.js                — poste sur le salon de test
//   node scripts/postPoll.js --public        — poste sur le salon public (Général)
//   node scripts/postPoll.js --dry-run       — simulation, affiche les sondages sans les poster
//   node scripts/postPoll.js --force         — si un sondage est déjà actif sur ce salon,
//                                               supprime les anciens messages et reposte
//                                               (utile pour itérer sur le salon de test)
//   node scripts/postPoll.js --public --dry-run

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postPoll } from "../api/discord/_handlers/poll.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");

const channelId = PUBLIC
  ? process.env.DISCORD_CHANNEL_GENERAL
  : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(
    `Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_GENERAL" : "DISCORD_CHANNEL_FRAME_TEST"}`,
  );
  process.exit(1);
}

(async () => {
  try {
    const result = await postPoll(channelId, { dryRun: DRY_RUN, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — sondages qui seraient postés dans ${channelId} :`);
      for (const q of result.questions) {
        console.log(`\n— ${q.id} —`);
        console.log(JSON.stringify(q.poll, null, 2));
      }
      return;
    }

    if (result.alreadyPosted) {
      console.log(
        `Un sondage est déjà actif dans ${result.state.channelId} depuis le ${result.state.startedAt} — relancer avec --force pour reposter.`,
      );
      return;
    }

    console.log(`${result.messages.length} sondage(s) posté(s) dans ${channelId} :`);
    for (const m of result.messages) {
      console.log(`  - ${m.questionId} (message ${m.messageId})`);
    }
  } catch (err) {
    console.error("Échec de la publication du sondage :", err.message);
    process.exit(1);
  }
})();
