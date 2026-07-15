#!/usr/bin/env node
// frameScores.js
// Affiche le classement de la partie Frame en cours : joueur, score de
// cette partie et score total de la saison.
//
// Usage : node scripts/frameScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadFrames,
  readState,
  computeGameRanking,
  computeSeasonRanking,
} from "../backend/services/frames.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Frame active pour le moment.");
    return;
  }

  const frames = await loadFrames();
  const frameEntry = frames[state.currentIndex];
  const [gameRanking, seasonRanking] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
  ]);

  console.log(
    `Jeu Frame — Partie ${state.currentIndex + 1} (${frameEntry.titre}) — Saison ${state.seasonId}\n`,
  );

  if (gameRanking.length === 0) {
    console.log("Personne n'a encore trouvé la réponse pour cette partie.");
    return;
  }

  const rows = gameRanking.map((entry, idx) => {
    const seasonEntry = seasonRanking.find((s) => s.discordId === entry.discordId);
    return {
      "#": idx + 1,
      Joueur: entry.username,
      "Score partie": entry.score,
      "Score saison": seasonEntry?.totalScore ?? entry.score,
    };
  });

  console.table(rows);
})();
