#!/usr/bin/env node
// triviaScores.js
// Affiche le classement de la manche Trivia en cours : joueur, score de
// cette manche et score total de la saison. Contrairement à frameScores.js,
// pas de notion "en cours" (essai unique verrouillé) : un joueur a répondu
// (correct ou non) ou n'a pas encore répondu, point final.
//
// Usage : node scripts/triviaScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadTriviaCatalog,
  resolveTriviaEntry,
  readState,
  getGameParticipants,
  computeSeasonRanking,
} from "../backend/services/trivia.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune manche Trivia active pour le moment.");
    return;
  }

  const catalog = await loadTriviaCatalog();
  const entry = resolveTriviaEntry(catalog, state.gameId);
  const [gameParticipants, seasonRanking] = await Promise.all([
    getGameParticipants(state.gameId),
    computeSeasonRanking(state.seasonId),
  ]);

  console.log(
    `Jeu Trivia — Manche ${state.seasonManche}/${state.seasonMancheTotal} (${entry?.question ?? state.gameId}) — Saison ${state.seasonId}\n`,
  );

  const answeredIds = new Set(gameParticipants.map((p) => p.discordId));
  const notPlayedYet = seasonRanking.filter((s) => !answeredIds.has(s.discordId));

  if (gameParticipants.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore répondu à cette manche.");
    return;
  }

  const answeredRows = await Promise.all(
    gameParticipants
      .sort((a, b) => new Date(a.answeredAt) - new Date(b.answeredAt))
      .map(async (p) => {
        const seasonEntry = seasonRanking.find((s) => s.discordId === p.discordId);
        return {
          Joueur: await resolveDisplayName(p.discordId, p.username),
          Réponse: p.letter,
          Résultat: p.correct ? "✅ correct" : "❌ incorrect",
          "Score manche": p.score,
          "Score saison": seasonEntry?.totalScore ?? p.score,
        };
      }),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      Réponse: "-",
      Résultat: "n'a pas joué",
      "Score manche": "-",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...answeredRows, ...notPlayedRows]);
})();
