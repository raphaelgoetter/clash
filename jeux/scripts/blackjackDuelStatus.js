#!/usr/bin/env node
// blackjackDuelStatus.js
// Liste les parties de Blackjack Duel en cours (une par joueur contre le
// Croupier, une seule à 2 joueurs) : manche, joueurs inscrits, mains jouées
// cette manche, classement cumulé et dernière activité. Chaque partie expire
// d'elle-même 1 h après la dernière action.
//
// Usage : node jeux/scripts/blackjackDuelStatus.js

import "../env.js";
import { listGames, listHands, readPoints, buildRanking } from "../services/blackjackDuel.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

(async () => {
  const games = (await listGames()).filter(({ state }) => !state.termine);
  if (!games.length) {
    console.log("Aucune partie de Blackjack Duel en cours.");
    return;
  }

  for (const { gid, state } of games) {
    const owner = await resolveDisplayName(state.ownerId, state.ownerId);
    const minutesSince = (Date.now() - new Date(state.lastActivityAt).getTime()) / 60_000;
    console.log(
      `\n━━ ${state.maxPlayers === 1 ? `Solo de ${owner}` : `2 joueurs (lancée par ${owner})`} [${gid}] ━━`,
    );
    console.log(
      `Manche ${state.manche}/${state.totalManches} — ${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}${state.rosterLocked ? " (inscriptions closes)" : ""}`,
    );
    console.log(`Dernière activité il y a ${Math.round(minutesSince)} min\n`);

    if (state.dealer) {
      console.log(
        `🎩 Croupier (manche ${state.manche}) : ${state.dealer.cards.map((c) => `${c.rank}${c.suit}`).join(" ")} (${state.dealer.score})\n`,
      );
    } else {
      console.log(`🃏 Duel entre joueurs (manche ${state.manche}) — pas de Croupier.\n`);
    }

    const hands = await listHands(gid, state.manche);
    const handEntries = Object.entries(hands);
    if (!handEntries.length) {
      console.log("Personne n'a encore joué cette manche.\n");
    } else {
      for (const [discordId, hand] of handEntries) {
        const username = await resolveDisplayName(discordId, hand.username || discordId);
        console.log(
          `${username} — ${hand.cards.map((c) => `${c.rank}${c.suit}`).join(" ")} (${hand.score}) [${hand.status}]`,
        );
      }
      console.log("");
    }

    const ranking = buildRanking(await readPoints(gid));
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
