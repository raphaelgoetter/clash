#!/usr/bin/env node
// triviaScores.js
// Affiche le classement de la manche Trivia en cours : joueur, score de
// cette manche et score total de la saison. Contrairement à frameScores.js,
// pas de notion "en cours" (essai unique verrouillé) : un joueur a répondu
// (correct ou non) ou n'a pas encore répondu, point final.
//
// Usage : node jeux/scripts/triviaScores.js [--geek | --intrus]
//   (--geek : Trivia Geek, --intrus : Intrus de l'inventaire)

import "../env.js";

import * as triviaSvc from "../services/trivia.js";
import * as triviaGeekSvc from "../services/triviageek.js";
import * as intrusSvc from "../services/intrus.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

const GEEK = process.argv.includes("--geek");
const INTRUS = process.argv.includes("--intrus");
const LABEL = INTRUS ? "Intrus de l'inventaire" : GEEK ? "Trivia Geek" : "Trivia";
const { loadTriviaCatalog, resolveTriviaEntry, readState, getGameParticipants, computeSeasonRanking } = INTRUS
  ? intrusSvc
  : GEEK
    ? triviaGeekSvc
    : triviaSvc;

(async () => {
  const state = await readState();
  if (!state) {
    console.log(`Aucune manche ${LABEL} active pour le moment.`);
    return;
  }

  const catalog = await loadTriviaCatalog();
  const entry = resolveTriviaEntry(catalog, state.gameId);
  const [gameParticipants, seasonRanking] = await Promise.all([
    getGameParticipants(state.gameId),
    computeSeasonRanking(state.seasonId),
  ]);

  console.log(
    `Jeu ${LABEL} — Manche ${state.seasonManche}/${state.seasonMancheTotal} (${entry?.label ?? entry?.question ?? state.gameId}) — Saison ${state.seasonId}\n`,
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
