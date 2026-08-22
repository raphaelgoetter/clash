#!/usr/bin/env node
// quizScores.js
// Affiche le classement de la manche de Quiz en cours (ou terminée) —
// réservé à l'admin : accessible même en cours de semaine, avant que les
// joueurs ne découvrent les bonnes réponses à la révélation finale.
//
// Usage : node scripts/quizScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadQuizConfig, readState, computeMancheRanking } from "../backend/services/quiz.js";
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

  const ranking = await computeMancheRanking(state.manche, mancheConfig);
  if (!ranking.length) {
    console.log("Personne n'a encore voté.");
    return;
  }

  const rows = await Promise.all(
    ranking.map(async (r, i) => ({
      "#": i + 1,
      Joueur: await resolveDisplayName(r.discordId, r.username),
      "Score (sur jours joués)": r.score,
    })),
  );
  console.table(rows);
})();
