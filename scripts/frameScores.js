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
  listGamePlayersInProgress,
} from "../backend/services/frames.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Frame active pour le moment.");
    return;
  }

  const frames = await loadFrames();
  const frameEntry = frames[state.currentIndex];
  const [gameRanking, seasonRanking, inProgress] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
    listGamePlayersInProgress(state.gameId),
  ]);

  console.log(
    `Jeu Frame — Partie ${state.currentIndex + 1} (${frameEntry.titre}) — Saison ${state.seasonId}\n`,
  );

  const touchedIds = new Set([
    ...gameRanking.map((e) => e.discordId),
    ...inProgress.map((p) => p.discordId),
  ]);
  const notPlayedYet = seasonRanking.filter((s) => !touchedIds.has(s.discordId));

  if (gameRanking.length === 0 && inProgress.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore interagi avec cette partie.");
    return;
  }

  const solvedRows = gameRanking.map((entry, idx) => {
    const seasonEntry = seasonRanking.find((s) => s.discordId === entry.discordId);
    return {
      "#": idx + 1,
      Joueur: entry.username,
      "Score partie": entry.score,
      "Score saison": seasonEntry?.totalScore ?? entry.score,
    };
  });

  const inProgressRows = inProgress.map((p) => {
    const seasonEntry = seasonRanking.find((s) => s.discordId === p.discordId);
    return {
      "#": "-",
      Joueur: p.username,
      "Score partie": "-",
      "Score saison": seasonEntry?.totalScore ?? "-",
    };
  });

  const notPlayedRows = notPlayedYet.map((s) => ({
    "#": "-",
    Joueur: s.pseudo,
    "Score partie": "n'a pas joué",
    "Score saison": s.totalScore,
  }));

  console.table([...solvedRows, ...inProgressRows, ...notPlayedRows]);
})();
