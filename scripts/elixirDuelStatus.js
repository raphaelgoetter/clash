#!/usr/bin/env node
// elixirDuelStatus.js
// Affiche l'état de la partie d'Élixir en cours (manche, joueurs, stocks,
// collections, offres de la manche, score projeté) et son ancienneté
// d'inactivité, pour décider à la main d'un `npm run elixirduel:reset`.
//
// Usage : node scripts/elixirDuelStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, readPlayers, readOffers, readCurrentScores, loadCatalog, mancheCards } from "../backend/services/elixirDuel.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

const STALE_HOURS = 2;

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie d'Élixir en cours.");
    return;
  }
  if (state.termine) {
    console.log(`Partie terminée${state.expired ? " (expirée)" : ""}, sera effacée au prochain lancement.`);
    return;
  }

  const hoursSince = (Date.now() - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  const staleWarning = hoursSince >= STALE_HOURS ? " ⚠️ inactive depuis plus de 2h, envisage `npm run elixirduel:reset`" : "";
  console.log(
    `Manche ${state.manche}/${state.totalManches} · ${state.players.length}/${state.maxPlayers} joueur(s)${state.rosterLocked ? " (inscriptions closes)" : ""}`,
  );
  console.log(`Dernière activité il y a ${hoursSince.toFixed(1)}h${staleWarning}\n`);

  const [catalog, players, offers, scores] = await Promise.all([loadCatalog(), readPlayers(), readOffers(state.manche), readCurrentScores(state)]);
  const cards = mancheCards(state, state.manche, catalog);
  console.log(`Cartes de la manche : ${cards.map((c) => `${c.fr} (${c.minBid})`).join(", ")}\n`);

  const rows = await Promise.all(
    scores.map(async (s) => {
      const offer = offers[s.id];
      return {
        Joueur: s.id === "bot" ? "Bot" : await resolveDisplayName(s.id, s.username),
        Élixir: players[s.id]?.stock,
        Cartes: players[s.id]?.collection.length,
        Score: s.total,
        Offre: !offer ? "en attente" : offer.card == null ? "passe" : `${cards[offer.card]?.fr} ${offer.bid}`,
      };
    }),
  );
  console.table(rows);
})();
