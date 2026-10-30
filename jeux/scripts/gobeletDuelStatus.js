#!/usr/bin/env node
// gobeletDuelStatus.js
// Liste les parties du Jeu du Gobelet Duel en cours (une par joueur en
// solo, une seule à 2 joueurs) : manche, joueurs inscrits, mains jouées
// cette manche, classement cumulé et dernière activité. Chaque partie
// expire d'elle-même 1 h après la dernière action.
//
// Usage : node jeux/scripts/gobeletDuelStatus.js

import "../env.js";
import {
  listGames,
  listHands,
  readPoints,
  buildRanking,
} from "../services/gobeletDuel.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

(async () => {
  const games = (await listGames()).filter(({ state }) => !state.termine);
  if (!games.length) {
    console.log("Aucune partie du Jeu du Gobelet Duel en cours.");
    return;
  }

  for (const { gid, state } of games) {
    const owner = await resolveDisplayName(state.ownerId, state.ownerId);
    const minutesSince =
      (Date.now() - new Date(state.lastActivityAt).getTime()) / 60_000;
    console.log(
      `\n━━ ${state.maxPlayers === 1 ? `Solo de ${owner}` : `2 joueurs (lancée par ${owner})`} [${gid}] ━━`,
    );

    console.log(
      `Manche ${state.manche}/${state.totalManches} — ${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}${state.rosterLocked ? " (inscriptions closes)" : ""}`,
    );
    console.log(`Dernière activité il y a ${Math.round(minutesSince)} min\n`);

    const playerNames = await Promise.all(
      state.players.map((id) => resolveDisplayName(id, id)),
    );
    console.log(`Joueurs inscrits : ${playerNames.join(", ") || "aucun"}\n`);

    const hands = await listHands(gid, state.manche);
    const handEntries = Object.entries(hands);
    if (!handEntries.length) {
      console.log("Personne n'a encore joué cette manche.\n");
    } else {
      for (const [discordId, hand] of handEntries) {
        const username = await resolveDisplayName(
          discordId,
          hand.username || discordId,
        );
        const detail =
          hand.status === "termine"
            ? `${hand.category} (${hand.points} pts)`
            : hand.status === "choix"
              ? "combinaison à choisir"
              : `en cours, tirage ${hand.tirage}/3`;
        console.log(`${username} — ${hand.dice.join(" ")} [${detail}]`);
      }
      console.log("");
    }

    const points = await readPoints(gid);
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
  }
})();
