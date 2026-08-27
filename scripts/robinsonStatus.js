#!/usr/bin/env node
// robinsonStatus.js
// Affiche l'état courant de Robinson (stocks, radeau, votes du jour) ainsi
// qu'une projection du Jour suivant basée sur les votes actuels, sans avoir
// besoin d'ouvrir Discord — pratique pour suivre l'avancement avant de
// décider de relancer manuellement `npm run robinson:public`. Comme pour le
// Tamagoshi, ce script tient lieu d'affichage admin (le bouton Journal de
// Bord ne montre lui que les besoins et l'historique, jamais le détail des
// votants).
//
// Usage : node scripts/robinsonStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadRobinsonConfig,
  readState,
  readStocks,
  readRadeauPoints,
  computeRaftSections,
  computeDailyConsumption,
  getHistoriqueEntry,
  tallyVotes,
  listVotes,
} from "../backend/services/robinson.js";
import { postRobinson, outcomeLabel } from "../api/discord/_handlers/robinson.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Robinson active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Partie déjà terminée.");
    return;
  }

  const config = await loadRobinsonConfig();
  const [stocks, radeauPoints] = await Promise.all([readStocks(), readRadeauPoints()]);
  const sections = computeRaftSections(radeauPoints, config.points_par_section);

  console.log(`Jour ${state.jour}/${config.duree_jours}${state.event ? ` — événement : ${state.event.nom}` : ""}\n`);
  console.log(`🐟 Nourriture : ${stocks.poisson}`);
  console.log(`💧 Eau        : ${stocks.eau}`);
  console.log(`🪵 Bois       : ${stocks.bois}`);
  console.log(`🛶 Radeau     : ${radeauPoints} pts (${sections}/${config.radeau_sections_max} sections)\n`);

  const votes = await listVotes(state.jour);
  // Pseudo actuel résolu en direct pour chaque votant (jamais celui figé au
  // moment du vote) — voir discordUsers.js. Repli sur le username stocké
  // (ou le discordId en dernier recours) si l'API Discord échoue.
  await Promise.all(
    votes.map(async (v) => {
      v.username = await resolveDisplayName(v.discordId, v.username || v.discordId);
    }),
  );

  const voteCounts = await tallyVotes(state.jour);
  for (const [id, action] of Object.entries(config.actions)) {
    const votants = votes.filter((v) => v.actionId === id);
    console.log(`${action.emoji} ${action.label} — ${voteCounts[id] || 0} vote${(voteCounts[id] || 0) > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} votant${votes.length > 1 ? "s" : ""} aujourd'hui.`);

  // Projection : réutilise postRobinson() en --dry-run (lecture seule, aucune
  // écriture Redis, aucun appel Discord) pour ne pas dupliquer la logique des
  // événements (bonus Épave/Colis Royal/Poissons pourris) — canal factice, la
  // publication n'est jamais atteinte en dry-run.
  const projection = await postRobinson(state.channelId, { dryRun: true, noPing: true, isPublic: false });
  console.log(`\n🔮 Projection si la clôture avait lieu maintenant :`);
  if (projection.skipped) {
    console.log(`→ Projection indisponible (${projection.reason ?? "raison inconnue"}).`);
  } else if (projection.final) {
    console.log(`→ Fin de partie : ${outcomeLabel(projection.outcome)}`);
  } else {
    const sectionsProjetees = computeRaftSections(projection.radeauPoints, config.points_par_section);
    const detailEvenement =
      projection.event?.perte != null ? ` (-${projection.event.perte} Poisson)` : "";
    console.log(`→ Jour ${projection.jour}/${config.duree_jours}${projection.event ? ` — événement : ${projection.event.nom}${detailEvenement}` : ""} :`);

    // La consommation réelle (computeClosure(), backend/services/robinson.js)
    // se base sur la mobilisation de LA VEILLE, pas sur les votes d'aujourd'hui
    // — sinon une baisse de participation réduirait mécaniquement le besoin
    // d'autant, rendant le désengagement sans conséquence. On reproduit ici
    // exactement la même base pour que ce détail corresponde à la vraie
    // clôture, pas à un autre calcul. Jour 1 : pas de veille, on retombe sur
    // le décompte du jour même (comportement historique, seule exception).
    const veille = state.jour > 1 ? await getHistoriqueEntry(state.jour - 1) : null;
    const vConsommation = veille ? veille.V : votes.length;
    const baseConso = veille ? `${vConsommation} d'hier` : `${vConsommation} aujourd'hui, Jour 1`;
    const conso = computeDailyConsumption(vConsommation);
    // N'inclut pas le vol des Gobelins (Jour 8, conditionnel au Bois final
    // <5) : trop dépendant des autres lignes pour un calcul indépendant simple.
    const eventDelta = (resource) => {
      const e = projection.event;
      if (!e) return 0;
      if ((e.id === "colis_royal" || e.id === "evenement")) return e.bonus_ressources ?? 0;
      if (e.id === "indigestion_royale" && resource === "eau") return e.bonus_eau ?? 2;
      if (e.id === "poissons_pourris" && resource === "poisson") return -(e.perte ?? 0);
      return 0;
    };
    const detailLigne = (emoji, label, resource, consoKey) => {
      const delta = eventDelta(resource);
      const detail = delta !== 0 ? ` ${delta > 0 ? "+" : "−"} ${Math.abs(delta)} événement` : "";
      return `  ${emoji} ${label.padEnd(10)} : ${stocks[resource]} actuel − ${conso[consoKey]} conso (${baseConso})${detail} = ${projection.stocks[resource]}`;
    };
    console.log(detailLigne("🐟", "Nourriture", "poisson", "poisson"));
    console.log(detailLigne("💧", "Eau", "eau", "eau"));
    console.log(detailLigne("🪵", "Bois", "bois", "bois"));
    console.log(`  🛶 Radeau     : ${projection.radeauPoints} pts (${sectionsProjetees}/${config.radeau_sections_max} sections)`);
  }
})();
