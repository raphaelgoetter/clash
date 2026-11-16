#!/usr/bin/env node
// gobeletStatus.js
// Affiche l'état courant du Jeu du Gobelet (jour, mains jouées aujourd'hui,
// classement cumulé), sans avoir besoin d'ouvrir Discord — pratique pour
// suivre l'avancement avant de décider de relancer manuellement
// `npm run gobelet:public`.
//
// Usage : node jeux/scripts/gobeletStatus.js


import "../env.js";
import { loadGobeletConfig, readState, listHands, readPoints, buildRanking, readAllUsernames } from "../services/gobelet.js";
import { JOURNEE, SOIR } from "../services/creneaux.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie du Jeu du Gobelet active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée.");
    return;
  }
  if (state.phase === "annonce") {
    console.log("Jour d'annonce publié, la partie commence au prochain cron.");
    return;
  }

  const config = await loadGobeletConfig();
  console.log(`Jour ${state.jour}/${config.duree_jours}\n`);

  for (const [titre, creneau] of [["Journée (8h30-20h)", JOURNEE], ["Soir (20h-8h)", SOIR]]) {
    console.log(`── ${titre} ──`);
    const hands = await listHands(state.jour, creneau);
    // Par points décroissants ; mains pas encore figées (en cours, choix) à la fin.
    const entries = Object.entries(hands).sort(([, a], [, b]) => (b.points ?? -1) - (a.points ?? -1));
    if (!entries.length) {
      console.log("Personne n'a encore joué.\n");
      continue;
    }
    for (const [discordId, hand] of entries) {
      const username = await resolveDisplayName(discordId, hand.username || discordId);
      const dice = hand.dice.join(" ");
      const detail = hand.status === "termine" ? `${hand.category} (${hand.points} pts)` : hand.status === "choix" ? "combinaison à choisir" : `en cours, tirage ${hand.tirage}/3`;
      console.log(`${username} — ${dice} [${detail}]`);
    }
    console.log(`\nTotal : ${entries.length} joueur${entries.length > 1 ? "s" : ""}.\n`);
  }

  const points = await readPoints();
  const ranking = buildRanking(points, await readAllUsernames());
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
