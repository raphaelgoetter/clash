#!/usr/bin/env node
// paletteScores.js
// Affiche le classement de la partie Palette en cours : joueur, réponse
// donnée, score de cette partie et score total de la saison.
//
// Usage : node scripts/paletteScores.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadPaletteCatalog,
  resolvePaletteEntry,
  readState,
  readRoundOrder,
  getCorrectLetter,
  getGameParticipants,
  computeSeasonRanking,
} from "../backend/services/palette.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Palette active pour le moment.");
    return;
  }

  const catalog = await loadPaletteCatalog();
  const entry = resolvePaletteEntry(catalog, state.gameId);
  const [participants, seasonRanking, order] = await Promise.all([
    getGameParticipants(state.gameId),
    computeSeasonRanking(state.seasonId),
    readRoundOrder(state.gameId),
  ]);

  const correctLetter = order ? getCorrectLetter(order) : "?";
  console.log(
    `Jeu Palette — Manche ${state.seasonManche}/${state.seasonMancheTotal} (${entry?.fr ?? "?"}, bonne réponse ${correctLetter}) — Saison ${state.seasonId}\n`,
  );

  // Bonnes réponses d'abord, puis ordre d'arrivée
  const sorted = [...participants].sort(
    (a, b) => b.score - a.score || a.answeredAt.localeCompare(b.answeredAt),
  );
  const answeredIds = new Set(sorted.map((p) => p.discordId));
  const notPlayedYet = seasonRanking.filter((s) => !answeredIds.has(s.discordId));

  if (sorted.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore interagi avec cette partie.");
    return;
  }

  const answeredRows = await Promise.all(
    sorted.map(async (p, idx) => {
      const seasonEntry = seasonRanking.find((s) => s.discordId === p.discordId);
      return {
        "#": idx + 1,
        Joueur: await resolveDisplayName(p.discordId, p.username),
        Réponse: `${p.letter} ${p.correct ? "✓" : "✗"}`,
        "Score partie": p.score,
        "Score saison": seasonEntry?.totalScore ?? p.score,
      };
    }),
  );

  const notPlayedRows = await Promise.all(
    notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      Réponse: "-",
      "Score partie": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  );

  console.table([...answeredRows, ...notPlayedRows]);
})();
