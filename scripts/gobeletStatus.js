#!/usr/bin/env node
// gobeletStatus.js
// Affiche l'état courant du Jeu du Gobelet (jour, mains jouées aujourd'hui,
// classement cumulé), sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run gobelet:public`.
//
// Usage : node scripts/gobeletStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadGobeletConfig, readState, listHands, readPoints, buildRanking } from "../backend/services/gobelet.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie du Jeu du Gobelet active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée.");
    return;
  }

  const config = await loadGobeletConfig();
  console.log(`Jour ${state.jour}/${config.duree_jours}\n`);

  const hands = await listHands(state.jour);
  const entries = Object.entries(hands).sort(([, a], [, b]) => (a.status === "termine") - (b.status === "termine"));
  if (!entries.length) {
    console.log("Personne n'a encore joué aujourd'hui.\n");
  } else {
    for (const [discordId, hand] of entries) {
      const username = await resolveDisplayName(discordId, hand.username || discordId);
      const dice = hand.dice.join(" ");
      const detail = hand.status === "termine" ? `${hand.category} (${hand.points} pts)` : `en cours, tirage ${hand.tirage}/3`;
      console.log(`${username} — ${dice} [${detail}]`);
    }
    console.log(`\nTotal : ${entries.length} joueur${entries.length > 1 ? "s" : ""} aujourd'hui.\n`);
  }

  const points = await readPoints();
  const ranking = buildRanking(points);
  if (ranking.length) {
    console.log("Classement cumulé :");
    const rows = await Promise.all(
      ranking.map(async (r, i) => ({
        "#": i + 1,
        Joueur: await resolveDisplayName(r.discordId, r.username),
        Points: r.points,
      })),
    );
    console.table(rows);
  }
})();
