#!/usr/bin/env node
// synopsisScores.js
// Affiche le classement de la manche Synopsis éclaté en cours : joueur, score de
// cette manche et score total de la saison.
//
// Usage : node jeux/scripts/synopsisScores.js


import "../env.js";
import {
  loadSynopsis,
  readState,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
} from "../services/synopsis.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune manche Synopsis éclaté active pour le moment.");
    return;
  }

  const catalogue = await loadSynopsis();
  const entry = catalogue[state.currentIndex];
  const [gameRanking, seasonRanking, inProgress] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
    listGamePlayersInProgress(state.gameId),
  ]);

  console.log(
    `Synopsis éclaté — Manche ${state.seasonManche} (n°${entry.numero}, ${entry.titre}) — Saison ${state.seasonId}\n`,
  );

  const touchedIds = new Set([
    ...gameRanking.map((e) => e.discordId),
    ...inProgress.map((p) => p.discordId),
  ]);
  const notPlayedYet = seasonRanking.filter((s) => !touchedIds.has(s.discordId));

  if (gameRanking.length === 0 && inProgress.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore interagi avec cette manche.");
    return;
  }

  const solvedRows = await Promise.all(
    gameRanking.map(async (entry, idx) => {
      const seasonEntry = seasonRanking.find((s) => s.discordId === entry.discordId);
      return {
        "#": idx + 1,
        Joueur: await resolveDisplayName(entry.discordId, entry.username),
        "Score manche": entry.score,
        "Score saison": seasonEntry?.totalScore ?? entry.score,
      };
    }),
  );

  const inProgressRows = await Promise.all(
    inProgress.map(async (p) => {
      const seasonEntry = seasonRanking.find((s) => s.discordId === p.discordId);
      return {
        "#": "-",
        Joueur: await resolveDisplayName(p.discordId, p.username),
        "Score manche": "-",
        "Score saison": seasonEntry?.totalScore ?? "-",
      };
    }),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      "Score manche": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...solvedRows, ...inProgressRows, ...notPlayedRows]);
})();
