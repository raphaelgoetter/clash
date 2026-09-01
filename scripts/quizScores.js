#!/usr/bin/env node
// quizScores.js
// Affiche le classement de la manche de Quiz en cours (ou terminée) — score
// jour par jour + total cumulé, comme les autres scripts *Scores.js (voir
// anagramScores.js) — réservé à l'admin : accessible même en cours de
// semaine, avant que les joueurs ne découvrent les bonnes réponses à la
// révélation finale.
//
// Usage : node scripts/quizScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadQuizConfig, readState, computeMancheDailyScores } from "../backend/services/quiz.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune manche de Quiz active pour le moment.");
    return;
  }

  const config = await loadQuizConfig();
  const mancheConfig = config.manches[state.mancheIndex];
  console.log(
    `Quiz — Manche ${state.manche} « ${state.theme} » — Jour ${state.jour}/7${state.termine ? " (terminée)" : ""}\n`,
  );

  const scores = await computeMancheDailyScores(state.manche, mancheConfig, state.jour);
  if (!scores.length) {
    console.log("Personne n'a encore voté.");
    return;
  }

  scores.sort((a, b) => b.total - a.total);

  const rows = await Promise.all(
    scores.map(async (entry, i) => {
      const row = { "#": i + 1, Joueur: await resolveDisplayName(entry.discordId, entry.username) };
      for (let jour = 1; jour <= state.jour; jour++) {
        row[`Jour ${jour}`] = entry.days[jour] ?? "-";
      }
      row.Total = entry.total;
      return row;
    }),
  );
  console.table(rows);
})();
