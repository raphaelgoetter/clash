#!/usr/bin/env node
// anagramScores.js
// Affiche le classement de la partie Anagram en cours : joueur, position
// d'arrivée, score de cette partie et score total de la saison.
//
// Usage : node scripts/anagramScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadAnagrams,
  readState,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
} from "../backend/services/anagrams.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Anagram active pour le moment.");
    return;
  }

  const anagrams = await loadAnagrams();
  const entry = anagrams[state.currentIndex];
  const [gameRanking, seasonRanking, inProgress] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
    listGamePlayersInProgress(state.gameId),
  ]);

  console.log(
    `Jeu Anagram — Partie ${state.currentIndex + 1} (${entry.answer}) — Saison ${state.seasonId}\n`,
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

  const solvedRows = gameRanking.map((e) => {
    const seasonEntry = seasonRanking.find((s) => s.discordId === e.discordId);
    return {
      "#": e.position,
      Joueur: e.username,
      "Score partie": e.score,
      "Score saison": seasonEntry?.totalScore ?? e.score,
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
