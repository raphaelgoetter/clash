#!/usr/bin/env node
// blackjackStatus.js
// Affiche l'état courant de Blackjack (jour, mains jouées aujourd'hui,
// classement cumulé) ainsi qu'une projection de la clôture du jour actif
// basée sur les mains actuelles, sans avoir besoin d'ouvrir Discord —
// pratique pour suivre l'avancement avant de décider de relancer
// manuellement `npm run blackjack:public`.
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
} from "../backend/services/blackjack.js";
import { postBlackjack } from "../api/discord/_handlers/blackjack.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

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
  const entries = Object.entries(hands);
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

  // Projection : réutilise postBlackjack() en --dry-run (lecture seule,
  // aucune écriture Redis, aucun appel Discord) pour ne pas dupliquer la
  // logique de résolution — canal factice, la publication n'est jamais
  // atteinte en dry-run.
  const projection = await postBlackjack(state.channelId, { dryRun: true, noPing: true, isPublic: false });
  console.log(`\n🔮 Projection si la clôture avait lieu maintenant :`);
  if (projection.skipped) {
    console.log(`→ Projection indisponible (${projection.reason ?? "raison inconnue"}).`);
  } else if (projection.final) {
    console.log("→ Ce serait la révélation finale (Jour 7 clos).");
  } else {
    console.log(`→ Ouverture du Jour ${projection.jour}/${config.duree_jours}.`);
  }
})();
