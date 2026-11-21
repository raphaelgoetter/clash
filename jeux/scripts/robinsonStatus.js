#!/usr/bin/env node
// robinsonStatus.js
// État courant de Robinson (météo, stocks, Radeau, votes du jour, joueurs à
// bord) et projection de la nuit avec les votes actuels, sans ouvrir
// Discord. ⚠️ La vraie météo de demain n'est affichée qu'avec --spoiler.
//
// Usage : node jeux/scripts/robinsonStatus.js [--spoiler]

import "../env.js";

import {
  RESSOURCES,
  loadRobinsonConfig,
  readState,
  listVotes,
  readABord,
  readJoursJoues,
  planchesRequises,
  radeauPret,
} from "../services/robinson.js";
import { postRobinson, outcomeLabel } from "../discord/handlers/robinson.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";

const SPOILER = process.argv.includes("--spoiler");
const EMOJI = { poisson: "🐟", eau: "💧", bois: "🪵" };

(async () => {
  const state = await readState();
  if (!state) return console.log("Aucune partie Robinson active pour le moment.");
  if (state.phase === "annonce") return console.log("Jour de présentation publié, la partie commence au prochain cron.");
  if (state.termine) return console.log(`Partie terminée : ${outcomeLabel(state.issue)}${state.cause ? ` (${state.cause})` : ""}.`);

  const config = await loadRobinsonConfig();
  const meteo = (id) => `${config.meteos[id].emoji} ${config.meteos[id].nom}`;
  console.log(`Jour ${state.jour}/${config.duree_jours} : ${meteo(state.meteo)}, prévision de demain ${meteo(state.prevision)}`);
  if (SPOILER) console.log(`🔒 Vraie météo de demain : ${meteo(state.meteoSuivante)}`);
  console.log(`Stocks : ${RESSOURCES.map((r) => `${EMOJI[r]} ${state.stocks[r]}`).join(" · ")} · 🛶 ${state.planches} planches\n`);

  const votes = await listVotes(state.jour);
  await Promise.all(votes.map(async (v) => (v.username = await resolveDisplayName(v.discordId, v.username || v.discordId))));
  for (const [id, action] of Object.entries(config.actions)) {
    const votants = votes.filter((v) => v.actionId === id);
    console.log(`${action.emoji} ${action.label} : ${votants.length}${votants.length ? ` (${votants.map((v) => v.username).join(", ")})` : ""}`);
  }
  const V = votes.length;
  const planchesSoir = state.planches + votes.filter((v) => v.actionId === "radeau").length;
  const aBord = Object.keys(await readABord()).length;
  console.log(`\n${V} joueur${V > 1 ? "s" : ""} aujourd'hui · Radeau ${planchesSoir}/${planchesRequises(V, config)}${radeauPret(planchesSoir, V, config) ? " (prêt)" : ""} · ${aBord} à bord`);
  console.log(`Joueurs de la partie : ${Object.keys(await readJoursJoues()).length}`);

  // Projection : postRobinson() en dry-run (aucune écriture, aucun appel Discord)
  const projection = await postRobinson(state.channelId, { dryRun: true, noPing: true, isPublic: false, force: true });
  console.log("\n🔮 Si la nuit avait lieu maintenant :");
  // Sans --spoiler, l'issue de l'aube trahirait la vraie météo de demain
  const dependDeLAube = projection.final && (projection.outcome === "victoire_radeau" || projection.cause === "pas_de_depart");
  if (dependDeLAube && !SPOILER) {
    console.log("→ Pas de famine. L'issue dépend de la météo réelle de demain (--spoiler pour la voir).");
  } else if (projection.final) {
    console.log(`→ Fin de partie : ${outcomeLabel(projection.outcome)}${projection.cause ? ` (${projection.cause})` : ""}`);
  } else if (projection.dryRun) {
    console.log(`→ Jour ${projection.jour} : ${RESSOURCES.map((r) => `${EMOJI[r]} ${projection.stocks[r]}`).join(" · ")} · 🛶 ${projection.planches} planches`);
  } else {
    console.log("→ Projection indisponible.");
  }
})();
