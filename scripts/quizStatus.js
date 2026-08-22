#!/usr/bin/env node
// quizStatus.js
// Affiche l'état courant du Quiz (manche, thème, jour) et le nombre de
// joueurs ayant déjà voté aujourd'hui — SANS révéler le contenu de leur
// vote ni les scores (contrairement à quizScores.js, réservé à l'admin qui
// veut voir le classement en avance).
//
// Usage : node scripts/quizStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, listVotes } from "../backend/services/quiz.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucun Quiz actif pour le moment.");
    return;
  }
  if (state.termine) {
    console.log(`Quiz terminé (manche ${state.manche} — « ${state.theme} »).`);
    return;
  }

  console.log(`Quiz — Manche ${state.manche} « ${state.theme} » — Jour ${state.jour}/7\n`);

  const votes = await listVotes(state.manche, state.jour);
  const usernames = await Promise.all(votes.map((v) => resolveDisplayName(v.discordId, v.username || v.discordId)));

  console.log(`${votes.length} joueur${votes.length > 1 ? "s" : ""} a/ont voté aujourd'hui.`);
  if (usernames.length) console.log(usernames.join(", "));
})();
