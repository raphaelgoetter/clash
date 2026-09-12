#!/usr/bin/env node
// pollStatus.js
// Affiche le décompte courant de chaque question du sondage actif — Discord
// fait le tally lui-même (sondage natif), ce script se contente de relire
// chaque message et d'afficher les résultats.
//
// Usage : node scripts/pollStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { getPollStatus } from "../api/discord/_handlers/poll.js";

function average(counts) {
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (!total) return null;
  const weighted = counts.reduce((sum, c) => sum + Number(c.text) * c.count, 0);
  return (weighted / total).toFixed(2);
}

(async () => {
  const status = await getPollStatus();
  if (!status) {
    console.log("Aucun sondage actif pour le moment.");
    return;
  }

  console.log(`Sondage démarré le ${status.startedAt} — salon ${status.channelId}\n`);

  for (const r of status.results) {
    console.log(`— ${r.question} —`);
    if (r.error) {
      console.log(`  Erreur : ${r.error}`);
      continue;
    }
    for (const c of r.counts) {
      console.log(`  ${c.text} : ${c.count}`);
    }
    console.log(`  Total votes : ${r.totalVotes}${r.isFinalized ? " (clôturé)" : ""}`);
    if (r.type === "note") {
      const avg = average(r.counts);
      if (avg) console.log(`  Moyenne : ${avg}/5`);
    }
    console.log("");
  }
})();
