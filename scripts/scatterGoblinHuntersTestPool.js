#!/usr/bin/env node
// scatterGoblinHuntersTestPool.js
// TESTS UNIQUEMENT — répartit le pool de faux joueurs (test_fake_*) sur les
// 5 lieux du village au lieu de les laisser tous groupés au Château, et les
// y maintient jour après jour. Sans ce script, les faux joueurs restent
// coincés au Château pour toujours : aucun ne clique jamais de bouton, donc
// le pass automatique (retombe au Château, voir computeNewPositions) les y
// ramène systématiquement à chaque clôture — inutilisable pour tester le
// ciblage combat/enquête, qui nécessite des cibles co-localisées à des
// lieux différents du sien.
//
// Effet double :
//   1. Écrit directement goblinhunters:state.joueurs[].position — effet
//      immédiat, pour tester un select de cible sans attendre une clôture.
//   2. Soumet une action "reste ici" (recordAction) au nom de chaque faux
//      joueur pour le jour EN COURS — effet persistant : la prochaine
//      clôture verra une vraie action (pas un pass) et les maintiendra à
//      cette position plutôt que de les faire retomber au Château.
// Répartition déterministe (round-robin sur l'ordre des joueurs) : relancer
// ce script chaque jour de test, AVANT `npm run goblinhunters:test`,
// remet chaque faux joueur exactement à la même place qu'avant.
//
// Usage : node scripts/scatterGoblinHuntersTestPool.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, writeState, recordAction } from "../backend/services/goblinhunters.js";

const LIEUX = ["chateau", "camp_entrainement", "tour_de_guet", "taverne", "clairiere_mystique"];

(async () => {
  const state = await readState();
  if (!state || state.phase !== "jeu") {
    console.error("Aucune partie en phase de jeu — lance d'abord goblinhunters:test puis goblinhunters:test:force-close.");
    process.exit(1);
  }

  const fakes = state.joueurs.filter((j) => j.discordId.startsWith("test_fake_") && j.alive);
  if (!fakes.length) {
    console.log("Aucun faux joueur vivant à répartir.");
    return;
  }

  const positionByDiscordId = {};
  fakes.forEach((j, i) => {
    positionByDiscordId[j.discordId] = LIEUX[i % LIEUX.length];
  });

  const joueurs = state.joueurs.map((j) =>
    positionByDiscordId[j.discordId] ? { ...j, position: positionByDiscordId[j.discordId] } : j,
  );
  await writeState({ ...state, joueurs });

  for (const j of fakes) {
    await recordAction(state.jour, j.discordId, "primary", { lieu: positionByDiscordId[j.discordId], cibleId: null }, j.username);
  }

  console.log(`${fakes.length} faux joueur(s) réparti(s) pour le Jour ${state.jour} :`);
  for (const j of fakes) {
    console.log(`  ${j.username} → ${positionByDiscordId[j.discordId]}`);
  }
})();
