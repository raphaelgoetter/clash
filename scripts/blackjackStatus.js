#!/usr/bin/env node
// blackjackStatus.js
// Affiche l'état courant de Blackjack (jour, mains jouées aujourd'hui,
// classement cumulé), sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run blackjack:public`.
//
// Usage : node scripts/blackjackStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadBlackjackConfig,
  readState,
  listHands,
  readPoints,
  buildRanking,
  compareToDealer,
} from "../backend/services/blackjack.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

// Ordre d'affichage du meilleur au pire résultat plutôt que par ordre
// d'arrivée en jeu (14/09, retour utilisateur) : bat le Croupier, égalité,
// perdu sans sauter, encore en train de jouer, sauté.
function handRank(hand, dealer) {
  if (hand.status === "bust") return 4;
  if (hand.status === "en_cours") return 3;
  const result = compareToDealer(hand.score, dealer);
  if (result === "win") return 0;
  if (result === "push") return 1;
  return 2;
}

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Blackjack active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée.");
    return;
  }

  const config = await loadBlackjackConfig();
  console.log(`Jour ${state.jour}/${config.duree_jours}\n`);

  const hands = await listHands(state.jour);
  const entries = Object.entries(hands).sort(
    ([, a], [, b]) => handRank(a, state.dealer) - handRank(b, state.dealer),
  );
  if (!entries.length) {
    console.log("Personne n'a encore joué aujourd'hui.\n");
  } else {
    for (const [discordId, hand] of entries) {
      const username = await resolveDisplayName(discordId, hand.username || discordId);
      console.log(`${username} — ${hand.cards.map((c) => `${c.rank}${c.suit}`).join(" ")} (${hand.score}) [${hand.status}]`);
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
