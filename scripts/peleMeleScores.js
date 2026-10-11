#!/usr/bin/env node
// peleMeleScores.js
// Affiche le classement de la partie Pêle-mêle en cours : joueur, mots
// trouvés, score de cette partie et score total de la saison.
//
// Usage : node scripts/peleMeleScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  readState,
  computeGameRanking,
  listGamePlayersInProgress,
  computeSeasonRanking,
} from "../backend/services/pelemele.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Pêle-mêle active pour le moment.");
    return;
  }

  const [ranking, inProgress, seasonRanking] = await Promise.all([
    computeGameRanking(state.gameId),
    listGamePlayersInProgress(state.gameId),
    computeSeasonRanking(state.seasonId),
  ]);

  console.log(
    `Jeu Pêle-mêle — Manche ${state.seasonManche}/${state.seasonMancheTotal} (lettres ${state.letters.join("")}, ${state.totalValidWords} mots possibles, max ${state.maxWordLength} lettres) — Saison ${state.seasonId}\n`,
  );

  const seenIds = new Set([...ranking, ...inProgress].map((p) => p.discordId));
  const notPlayedYet = seasonRanking.filter((s) => !seenIds.has(s.discordId));

  if (ranking.length === 0 && inProgress.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore interagi avec cette partie.");
    return;
  }

  const seasonScore = (discordId, fallback) =>
    seasonRanking.find((s) => s.discordId === discordId)?.totalScore ?? fallback;

  const foundRows = await Promise.all(
    ranking.map(async (p, idx) => ({
      "#": idx + 1,
      Joueur: await resolveDisplayName(p.discordId, p.username),
      Mots: `${p.foundWords.length} (${p.foundWords.join(", ")})`,
      "Score partie": p.score,
      "Score saison": seasonScore(p.discordId, p.score),
    })),
  );

  const inProgressRows = await Promise.all(
    inProgress.map(async (p) => ({
      "#": "-",
      Joueur: await resolveDisplayName(p.discordId, p.username),
      Mots: "aucun mot valide",
      "Score partie": 0,
      "Score saison": seasonScore(p.discordId, 0),
    })),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      Mots: "-",
      "Score partie": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...foundRows, ...inProgressRows, ...notPlayedRows]);
})();
