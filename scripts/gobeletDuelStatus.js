#!/usr/bin/env node
// gobeletDuelStatus.js
// Affiche l'état de la partie du Jeu du Gobelet Duel en cours (manche,
// joueurs inscrits, mains jouées cette manche, classement cumulé) ainsi que
// son ancienneté d'inactivité — pratique pour décider À LA MAIN si une
// partie mérite un `npm run gobeletduel:reset` (aucun watchdog automatique,
// une seule partie à la fois sur le serveur, donc une partie oubliée
// bloquerait /gobelet indéfiniment sans ce point de contrôle manuel).
//
// Usage : node scripts/gobeletDuelStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, listHands, readPoints, buildRanking } from "../backend/services/gobeletDuel.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

const STALE_HOURS = 2;

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie du Jeu du Gobelet Duel en cours.");
    return;
  }
  if (state.termine) {
    console.log("Partie terminée (sera effacée automatiquement au prochain lancement).");
    return;
  }

  const hoursSince = (Date.now() - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  const staleWarning =
    hoursSince >= STALE_HOURS ? " ⚠️ inactive depuis plus de 2h — envisage `npm run gobeletduel:reset`" : "";

  console.log(
    `Manche ${state.manche}/${state.totalManches} — ${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}${state.rosterLocked ? " (inscriptions closes)" : ""}`,
  );
  console.log(`Dernière activité il y a ${hoursSince.toFixed(1)}h${staleWarning}\n`);

  const playerNames = await Promise.all(state.players.map((id) => resolveDisplayName(id, id)));
  console.log(`Joueurs inscrits : ${playerNames.join(", ") || "aucun"}\n`);

  const hands = await listHands(state.manche);
  const handEntries = Object.entries(hands);
  if (!handEntries.length) {
    console.log("Personne n'a encore joué cette manche.\n");
  } else {
    for (const [discordId, hand] of handEntries) {
      const username = await resolveDisplayName(discordId, hand.username || discordId);
      const detail = hand.status === "termine" ? `${hand.category} (${hand.points} pts)` : `en cours, tirage ${hand.tirage}/3`;
      console.log(`${username} — ${hand.dice.join(" ")} [${detail}]`);
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
