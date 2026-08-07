#!/usr/bin/env node
// zoomScores.js
// Affiche le classement de la partie Zoom carte en cours : joueur, statut
// de chaque slot (gauche/droite), score de cette manche (somme des 2 slots)
// et score total de la saison.
//
// Usage : node scripts/zoomScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadZoomCatalog,
  resolveZoomPair,
  readState,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
} from "../backend/services/zoom.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

function slotCell(slot) {
  if (!slot?.solved) return "-";
  return `+${slot.score} pts${slot.hintUsed ? " (indice)" : ""}`;
}

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Zoom carte active pour le moment.");
    return;
  }

  const catalog = await loadZoomCatalog();
  const { entryA, entryB } = resolveZoomPair(catalog, state.gameId);
  const [gameRanking, seasonRanking, inProgress] = await Promise.all([
    computeGameRanking(state.gameId),
    computeSeasonRanking(state.seasonId),
    listGamePlayersInProgress(state.gameId),
  ]);

  console.log(
    `Jeu Zoom carte — Manche ${state.seasonManche}/${state.seasonMancheTotal} (${entryA?.answer ?? "?"} & ${entryB?.answer ?? "?"}) — Saison ${state.seasonId}\n`,
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
        Gauche: slotCell(entry.slots?.A),
        Droite: slotCell(entry.slots?.B),
        "Score partie": entry.totalScore,
        "Score saison": seasonEntry?.totalScore ?? entry.totalScore,
      };
    }),
  );

  const inProgressRows = await Promise.all(
    inProgress.map(async (p) => {
      const seasonEntry = seasonRanking.find((s) => s.discordId === p.discordId);
      return {
        "#": "-",
        Joueur: await resolveDisplayName(p.discordId, p.username),
        Gauche: "-",
        Droite: "-",
        "Score partie": "-",
        "Score saison": seasonEntry?.totalScore ?? "-",
      };
    }),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      Gauche: "-",
      Droite: "-",
      "Score partie": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...solvedRows, ...inProgressRows, ...notPlayedRows]);
})();
