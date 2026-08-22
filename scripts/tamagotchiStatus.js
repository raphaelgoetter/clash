#!/usr/bin/env node
// tamagotchiStatus.js
// Affiche l'état courant du Tamagoshi (jauges, étoiles, votes du jour) ainsi
// qu'une projection du Jour suivant basée sur les votes actuels, sans avoir
// besoin d'ouvrir Discord — pratique pour suivre l'avancement avant de
// décider de relancer manuellement `npm run tamagotchi:public`. Ce jeu n'a
// pas de bouton "Historique" dans Discord, ce script en tient lieu côté
// admin (comme scripts/aventureVotes.js pour l'Aventure).
//
// Usage : node scripts/tamagotchiStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadTamagotchiConfig,
  readState,
  tallyVotes,
  listVotes,
  previewCloseDay,
  eventForDay,
  computeDayOpenGauges,
  computeFinalTier,
  capTierByConfiance,
  readPiluleState,
} from "../backend/services/tamagotchi.js";
import { renderGaugeBar, formatGaugeImpact, formatActionOverrides } from "../api/discord/_handlers/tamagotchi.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucun Tamagoshi actif pour le moment.");
    return;
  }
  if (state.termine) {
    console.log(`Défi déjà terminé — ${state.starTotal} étoiles de dressage.`);
    return;
  }

  const config = await loadTamagotchiConfig();
  console.log(`Jour ${state.jour}/${config.duree_jours} — ⭐ ${state.starTotal} étoile(s) de dressage\n`);
  console.log(`🔥 Estomac : ${renderGaugeBar(state.gauges.estomac)} ${state.gauges.estomac}%`);
  console.log(`⚡ Énergie : ${renderGaugeBar(state.gauges.energie)} ${state.gauges.energie}%`);
  console.log(`🥨 Moral   : ${renderGaugeBar(state.gauges.moral)} ${state.gauges.moral}%`);
  if (config.confiance && state.confiance != null) {
    console.log(`🤝 Confiance : ${renderGaugeBar(state.confiance)} ${state.confiance}%`);
  }
  if (config.fatigue) {
    console.log(
      `😵 Action fatiguée aujourd'hui : ${state.actionFatiguee ? config.actions[state.actionFatiguee]?.label ?? state.actionFatiguee : "aucune"}`,
    );
  }
  console.log("");

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
    // Pilule a son propre bloc dédié ci-dessous (quota de la manche, pas un
    // simple compteur de votes) — seule elle est exclue de cette boucle.
    if (id === "pilule") continue;
    const votants = votes.filter((v) => v.actionId === id);
    console.log(`${action.emoji} ${action.label} — ${voteCounts[id] || 0} vote${(voteCounts[id] || 0) > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} vote${votes.length > 1 ? "s" : ""} aujourd'hui.`);

  const pilule = config.actions.pilule;
  if (state.jour >= pilule.day_min && state.jour <= pilule.day_max) {
    const piluleState = await readPiluleState(state.jour, pilule.total_cap);
    const statut = piluleState.exhausted
      ? "épuisée pour cette manche"
      : piluleState.usedToday
        ? "déjà utilisée aujourd'hui"
        : "disponible";
    console.log(`\n💊 Pilule : ${statut} — ${piluleState.totalUsed}/${pilule.total_cap} utilisée(s) cette manche`);
    // Un vote Pilule reste dans le hash de votes uniquement si le claim a
    // réussi (voir handlePilule : sinon il est libéré) — donc tout votant
    // "pilule" trouvé ici l'a bien utilisée aujourd'hui.
    const votantsPilule = votes.filter((v) => v.actionId === "pilule");
    if (votantsPilule.length > 0) {
      console.log(`  ${votantsPilule.map((v) => v.username).join(", ")}`);
    }
  }

  // Projection : clôture le jour EN COURS avec les votes actuels (lecture
  // seule, previewCloseDay n'écrit rien) — même calcul que --dry-run, sans
  // consommer les votes. Ne préjuge pas des votes qui arriveront encore
  // avant 08:00 UTC.
  const closure = await previewCloseDay(state, config);
  const jourSuivant = state.jour + 1;
  console.log(`\n🔮 Projection si la clôture avait lieu maintenant :`);
  console.log(`Bilan du Jour ${state.jour} : ${closure.rating.rating} (${closure.rating.starDelta >= 0 ? "+" : ""}${closure.rating.starDelta} ⭐)`);
  if (config.confiance) {
    console.log(`  🤝 Confiance projetée : ${closure.confianceApres}/100`);
  }
  if (config.fatigue) {
    console.log(
      `  😵 Action fatiguée demain : ${closure.actionFatigueeSuivante ? config.actions[closure.actionFatigueeSuivante]?.label ?? closure.actionFatigueeSuivante : "aucune"}`,
    );
  }

  if (jourSuivant > config.duree_jours) {
    const starTotalFinal = state.starTotal + closure.rating.starDelta;
    const tierBrut = computeFinalTier(starTotalFinal);
    const tier = capTierByConfiance(tierBrut, closure.confianceApres, config.confiance);
    const plafondNote = tier !== tierBrut ? ` (plafonné depuis ${tierBrut} par la Confiance)` : "";
    console.log(`→ Jour ${jourSuivant} : fin de partie, ${starTotalFinal} étoile(s) au total — palier ${tier}${plafondNote}.`);
  } else {
    const event = eventForDay(jourSuivant, config.evenements_possibles);
    // Un événement à actions_modifiees (ex. Indigestion de bonbons) n'a pas
    // d'effet instantané au démarrage du jour suivant — même garde qu'en prod
    // (voir postTamagotchi()) : rien à appliquer ici pour ce type d'événement.
    const gaugesProjetees = computeDayOpenGauges(closure.gaugesClosing, jourSuivant, event, config);
    console.log(`→ Jour ${jourSuivant}/${config.duree_jours} :`);
    if (event) {
      const effet = event.actions_modifiees
        ? formatActionOverrides(event.actions_modifiees, config.actions)
        : formatGaugeImpact(event.modificateur_jauges);
      console.log(`  📯 Événement : ${event.titre} — ${effet}`);
    }
    if (config.decroissance && jourSuivant >= config.decroissance.jour_min) {
      console.log(`  📉 Lilith s'essouffle : ${formatGaugeImpact(config.decroissance.modificateur_jauges)}`);
    }
    console.log(`  🍭 Estomac : ${renderGaugeBar(gaugesProjetees.estomac)} ${gaugesProjetees.estomac}%`);
    console.log(`  ⚡ Énergie : ${renderGaugeBar(gaugesProjetees.energie)} ${gaugesProjetees.energie}%`);
    console.log(`  🥨 Moral   : ${renderGaugeBar(gaugesProjetees.moral)} ${gaugesProjetees.moral}%`);
  }
})();
