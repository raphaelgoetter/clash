#!/usr/bin/env node
// zoomScores.js
// Affiche le classement de la partie Zoom carte en cours : joueur, score de
// cette partie et score total de la saison.
//
// Usage : node scripts/zoomScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadZoomCatalog,
  resolveZoomEntry,
  readState,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
} from "../backend/services/zoom.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Zoom carte active pour le moment.");
    return;
  }

  const catalog = await loadZoomCatalog();
  const entry = resolveZoomEntry(catalog, state.gameId);
  const [gameRanking, seasonRanking, inProgress] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
    listGamePlayersInProgress(state.gameId),
  ]);

  console.log(
    `Jeu Zoom carte — Manche ${state.seasonManche}/${state.seasonMancheTotal} (${entry?.answer ?? "?"}) — Saison ${state.seasonId}\n`,
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

  const solvedRows = await Promise.all(
    gameRanking.map(async (entry, idx) => {
      const seasonEntry = seasonRanking.find((s) => s.discordId === entry.discordId);
      return {
        "#": idx + 1,
        Joueur: await resolveDisplayName(entry.discordId, entry.username),
        "Score partie": entry.score,
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
        "Score partie": "-",
        "Score saison": seasonEntry?.totalScore ?? "-",
      };
    }),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      "Score partie": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...solvedRows, ...inProgressRows, ...notPlayedRows]);
})();
