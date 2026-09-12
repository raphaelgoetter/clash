#!/usr/bin/env node
// pollStatus.js
// Affiche uniquement les votes "extrêmes" jugés intéressants (voir
// EXTREME_RULES dans api/discord/_handlers/poll.js) — le décompte et la
// moyenne par réponse sont déjà visibles directement dans le sondage natif
// Discord, ce script ne sert qu'à voir QUI se cache derrière ces réponses.
//
// Usage : node scripts/pollStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { getPollStatus } from "../api/discord/_handlers/poll.js";

(async () => {
  const status = await getPollStatus();
  if (!status) {
    console.log("Aucun sondage actif pour le moment.");
    return;
  }

  console.log(`Sondage démarré le ${status.startedAt} — salon ${status.channelId}\n`);

  for (const e of status.extremes) {
    console.log(`— ${e.question} —`);
    if (e.error) {
      console.log(`  Erreur : ${e.error}`);
    } else if (e.voters.length) {
      console.log(`  ${e.label} : ${e.voters.join(", ")}`);
    } else {
      console.log(`  ${e.label} : personne`);
    }
    console.log("");
  }

  if (status.ideas?.length) {
    console.log(`💡 ${status.ideas.length} idée(s) proposée(s) :`);
    for (const idea of status.ideas) {
      console.log(`  - ${idea.username} : ${idea.text}`);
    }
  } else {
    console.log("💡 Aucune idée proposée pour le moment.");
  }
})();
