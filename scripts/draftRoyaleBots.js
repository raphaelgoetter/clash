#!/usr/bin/env node
// draftRoyaleBots.js
// Fait jouer des joueurs fictifs sur le draft de TEST, pour tester seul les
// échanges : chaque bot reçoit sa main (premier passage) puis prévoit
// l'échange qui rapproche le plus sa main d'un carré. Les bots disputent
// ainsi des cartes au marché à la clôture suivante.
//
// ⚠️ Refuse de tourner si le draft actif n'est pas sur le salon de test
// (DISCORD_CHANNEL_FRAME_TEST) : jamais de faux joueurs dans une vraie partie.
// Les bots disparaissent avec `npm run draftroyale:reset`.
//
// Usage :
//   node scripts/draftRoyaleBots.js        — 3 bots
//   node scripts/draftRoyaleBots.js 5      — 5 bots

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, readPartie, ensureJoueur, enregistrerChoix } from "../backend/services/draftroyale.js";
import { choixGlouton } from "../backend/services/draftRules.js";

const NB_BOTS = Number(process.argv[2]) || 3;

(async () => {
  const state = await readState();
  const testChannel = process.env.DISCORD_CHANNEL_FRAME_TEST;
  if (!state || state.phase !== "jour" || state.termine) {
    console.error("Aucun jour de draft en cours : lance d'abord npm run draftroyale:test.");
    process.exit(1);
  }
  if (!testChannel || state.channelId !== testChannel) {
    console.error("Le draft actif n'est pas sur le salon de test : bots refusés.");
    process.exit(1);
  }

  for (let i = 1; i <= NB_BOTS; i++) {
    const id = `bot-${i}`;
    const nom = `Bot ${i}`;
    const { joueur } = await ensureJoueur(id, nom);
    const partie = await readPartie();
    const choix = choixGlouton(joueur.main, partie.marche, Math.random, partie.vedettes || []);
    if (!choix) {
      console.log(`${nom} : aucun échange possible`);
      continue;
    }
    await enregistrerChoix(state.jour, id, "prise", choix.prise);
    await enregistrerChoix(state.jour, id, "depot", choix.depot);
    console.log(`${nom} : main ${joueur.main.join(", ")} → prend ${choix.prise}, dépose ${choix.depot}`);
  }
  console.log("\nLes échanges seront résolus à la prochaine clôture (npm run draftroyale:test).");
})();
