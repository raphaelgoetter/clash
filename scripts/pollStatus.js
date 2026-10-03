#!/usr/bin/env node
// pollStatus.js
// Affiche uniquement les idées soumises via la question "freetext" du
// sondage — le décompte des votes est déjà visible directement dans le
// sondage natif Discord.
//
// Usage : node scripts/pollStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { listIdeas } from "../backend/services/poll.js";

(async () => {
  const ideas = await listIdeas();

  if (ideas?.length) {
    console.log(`💡 ${ideas.length} idée(s) proposée(s) :`);
    for (const idea of ideas) {
      console.log(`  - ${idea.username} : ${idea.text}`);
    }
  } else {
    console.log("💡 Aucune idée proposée pour le moment.");
  }
})();
