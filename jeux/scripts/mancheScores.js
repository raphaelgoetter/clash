#!/usr/bin/env node
// mancheScores.js
// Affiche le classement de la manche en cours d'un jeu hebdomadaire à
// réponse libre (Zoom logo, Concept, Plat Pays) : joueur, score de la manche
// et score total de la saison, puis les joueurs en cours et ceux qui n'ont
// pas encore joué.
//
// Usage : node jeux/scripts/mancheScores.js <zoom2|concept|platpays>

import "../env.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

const JEUX = {
  zoom2: {
    titre: "Zoom logo",
    module: "../services/zoom2.js",
    libelle: (svc, gameId) => svc.getZoom2RoundLabel(gameId),
  },
  concept: {
    titre: "Concept",
    module: "../services/concept.js",
    libelle: (svc, gameId) => svc.getConceptLabel(gameId),
  },
  platpays: {
    titre: "Plat Pays",
    module: "../services/platpays.js",
    libelle: (svc, gameId) => svc.getPlatLabel(gameId),
  },
};

const cle = process.argv[2];
const jeu = JEUX[cle];
if (!jeu) {
  console.error(`Usage : node jeux/scripts/mancheScores.js <${Object.keys(JEUX).join("|")}>`);
  process.exit(1);
}

(async () => {
  const svc = await import(jeu.module);
  const state = await svc.readState();
  if (!state) {
    console.log(`Aucune manche ${jeu.titre} active pour le moment.`);
    return;
  }

  const [libelle, gameRanking, seasonRanking, inProgress] = await Promise.all([
    jeu.libelle(svc, state.gameId),
    svc.computeGameRanking(state.gameId),
    svc.computeSeasonRanking(state.seasonId),
    svc.listGamePlayersInProgress(state.gameId),
  ]);

  const total = state.seasonMancheTotal ? `/${state.seasonMancheTotal}` : "";
  console.log(
    `${jeu.titre} — Manche ${state.seasonManche ?? "?"}${total} (${libelle ?? state.gameId}) — Saison ${state.seasonId}\n`,
  );

  const touchedIds = new Set([...gameRanking.map((e) => e.discordId), ...inProgress.map((p) => p.discordId)]);
  const notPlayedYet = seasonRanking.filter((s) => !touchedIds.has(s.discordId));

  if (gameRanking.length === 0 && inProgress.length === 0 && notPlayedYet.length === 0) {
    console.log("Personne n'a encore interagi avec cette manche.");
    return;
  }

  const scoreSaison = (discordId) => seasonRanking.find((s) => s.discordId === discordId)?.totalScore;

  const rows = await Promise.all([
    ...gameRanking.map(async (e, idx) => ({
      "#": idx + 1,
      Joueur: await resolveDisplayName(e.discordId, e.username),
      "Score manche": e.score,
      "Score saison": scoreSaison(e.discordId) ?? e.score,
    })),
    ...inProgress.map(async (p) => ({
      "#": "-",
      Joueur: await resolveDisplayName(p.discordId, p.username),
      "Score manche": "-",
      "Score saison": scoreSaison(p.discordId) ?? "-",
    })),
    ...notPlayedYet.map(async (s) => ({
      "#": "-",
      Joueur: await resolveDisplayName(s.discordId, s.pseudo),
      "Score manche": "n'a pas joué",
      "Score saison": s.totalScore,
    })),
  ]);

  console.table(rows);
})();
