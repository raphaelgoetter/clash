#!/usr/bin/env node
// blackjackDuelStatus.js
// Affiche l'état de la partie de Blackjack Duel en cours (manche, joueurs
// inscrits, mains jouées cette manche, classement cumulé) ainsi que son
// ancienneté d'inactivité — pratique pour décider À LA MAIN si une partie
// mérite un `npm run blackjackduel:reset` (plus de watchdog automatique
// depuis le 12/09, voir .github/workflows/ — une seule partie à la fois sur
// le serveur, donc une partie oubliée bloquerait /blackjack indéfiniment
// sans ce point de contrôle manuel).
//
// Usage : node scripts/blackjackDuelStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, listHands, readPoints, buildRanking } from "../backend/services/blackjackDuel.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

const STALE_HOURS = 24;

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Blackjack Duel en cours.");
    return;
  }
  if (state.termine) {
    console.log("Partie terminée (sera effacée automatiquement au prochain lancement).");
    return;
  }

  const hoursSince = (Date.now() - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  const staleWarning = hoursSince >= STALE_HOURS ? " ⚠️ inactive depuis plus de 24h — envisage `npm run blackjackduel:reset`" : "";

  console.log(
    `Manche ${state.manche}/${state.totalManches} — ${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}${state.rosterLocked ? " (inscriptions closes)" : ""}`,
  );
  console.log(`Dernière activité il y a ${hoursSince.toFixed(1)}h${staleWarning}\n`);

  console.log(
    `🎩 Croupier (manche ${state.manche}) : ${state.dealer.cards.map((c) => `${c.rank}${c.suit}`).join(" ")} (${state.dealer.score})\n`,
  );

  const playerNames = await Promise.all(state.players.map((id) => resolveDisplayName(id, id)));
  console.log(`Joueurs inscrits : ${playerNames.join(", ") || "aucun"}\n`);

  const hands = await listHands(state.manche);
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
