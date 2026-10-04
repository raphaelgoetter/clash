#!/usr/bin/env node
// draftRoyaleBots.js
// Fait jouer des joueurs fictifs sur le draft de TEST, pour tester seul le
// marché : chaque bot pioche, fait un vœu au hasard s'il a déposé la veille,
// puis dépose une carte au hasard. Après la clôture suivante, leurs cartes
// sont au marché et le menu des vœux devient utilisable ; s'ils prennent ta
// carte, ta popularité monte.
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

import {
  loadDraftRoyaleConfig,
  readState,
  readJoueur,
  readMarche,
  piocher,
  deposer,
  enregistrerVoeu,
  cartesSouhaitables,
  depotDuJour,
} from "../backend/services/draftroyale.js";

const NB_BOTS = Number(process.argv[2]) || 3;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

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

  const config = await loadDraftRoyaleConfig();
  const jour = state.jour;
  const marcheVeille = await readMarche(jour - 1);

  for (let i = 1; i <= NB_BOTS; i++) {
    const id = `bot-${i}`;
    const nom = `Bot ${i}`;
    const lignes = [];
    const pioche = await piocher(jour, id, nom);
    if (pioche.status === "ok") lignes.push(`pioche ${pioche.key}`);

    const joueur = await readJoueur(id);
    if (depotDuJour(joueur, jour - 1)) {
      const souhaitables = cartesSouhaitables(marcheVeille, joueur, jour);
      if (souhaitables.length) {
        const key = pick(souhaitables);
        await enregistrerVoeu(jour, id, 1, key, config);
        lignes.push(`vœu ${key}`);
      }
    }

    const apres = await readJoueur(id);
    if (jour <= config.jour_dernier_depot && apres.main.length) {
      const key = pick(apres.main);
      const depot = await deposer(jour, id, key, config);
      if (depot.status === "ok") lignes.push(`dépôt ${key}`);
    }
    console.log(`${nom} : ${lignes.join(", ") || "rien de nouveau (déjà joué aujourd'hui)"}`);
  }
  console.log("\nLes cartes déposées seront au marché après la prochaine clôture (npm run draftroyale:test).");
})();
