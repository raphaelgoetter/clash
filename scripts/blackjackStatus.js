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
  readUsernames,
  buildRanking,
  sumCardsPerPlayer,
  compareToDealer,
} from "../backend/services/blackjack.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

// Étiquette + ordre d'affichage du meilleur au pire résultat plutôt que par
// ordre d'arrivée en jeu (14/09, retour utilisateur) — hand.status seul ne
// distingue pas une main arrêtée gagnante d'une perdante ("stand" pour les
// deux) : win (bat le Croupier), tie (égalité), stand (arrêtée mais perdue),
// run (encore en train de jouer), bust (a sauté).
function classifyHand(hand, dealer) {
  if (hand.status === "bust") return { rank: 4, label: "bust" };
  if (hand.status === "en_cours") return { rank: 3, label: "run" };
  const result = compareToDealer(hand.score, dealer);
  if (result === "win") return { rank: 0, label: "win" };
  if (result === "push") return { rank: 1, label: "tie" };
  return { rank: 2, label: "stand" };
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
  const entries = Object.entries(hands)
    .map(([discordId, hand]) => [discordId, hand, classifyHand(hand, state.dealer)])
    .sort(([, , a], [, , b]) => a.rank - b.rank);
  if (!entries.length) {
    console.log("Personne n'a encore joué aujourd'hui.\n");
  } else {
    for (const [discordId, hand, { label }] of entries) {
      const username = await resolveDisplayName(discordId, hand.username || discordId);
      console.log(`${username} — ${hand.cards.map((c) => `${c.rank}${c.suit}`).join(" ")} (${hand.score}) [${label}]`);
    }
    console.log(`\nTotal : ${entries.length} joueur${entries.length > 1 ? "s" : ""} aujourd'hui.\n`);
  }

  const [points, usernames, cardsDrawn] = await Promise.all([readPoints(), readUsernames(), sumCardsPerPlayer()]);
  const ranking = buildRanking(points, usernames, cardsDrawn);
  if (ranking.length) {
    console.log("Classement cumulé :");
    const rows = await Promise.all(
      ranking.map(async (r, i) => ({
        "#": i + 1,
        Joueur: await resolveDisplayName(r.discordId, r.username),
        Points: r.points,
        Cartes: r.cards,
      })),
    );
    console.table(rows);
  }
})();
