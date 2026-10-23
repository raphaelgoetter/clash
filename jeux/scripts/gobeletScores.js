#!/usr/bin/env node
// gobeletScores.js
// Affiche le classement cumulé de la manche du Jeu du Gobelet en cours (ou
// terminée) — réservé à l'admin : accessible à tout moment, sans attendre
// la révélation finale du Jour 7.
//
// Usage : node jeux/scripts/gobeletScores.js


import "../env.js";
import { loadGobeletConfig, readState, readPoints, buildRanking, readAllUsernames } from "../services/gobelet.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie du Jeu du Gobelet active pour le moment.");
    return;
  }
  if (state.phase === "annonce") {
    console.log("Jour d'annonce publié, la partie commence au prochain cron.");
    return;
  }

  const config = await loadGobeletConfig();
  console.log(`Jeu du Gobelet — Jour ${state.jour}/${config.duree_jours}${state.termine ? " (terminée)" : ""}\n`);

  const points = await readPoints();
  const ranking = buildRanking(points, await readAllUsernames());
  if (!ranking.length) {
    console.log("Personne n'a encore marqué de point.");
    return;
  }

  const rows = await Promise.all(
    ranking.map(async (r, i) => ({
      "#": i + 1,
      Joueur: await resolveDisplayName(r.discordId, r.username),
      Points: r.points,
    })),
  );
  console.table(rows);
})();
