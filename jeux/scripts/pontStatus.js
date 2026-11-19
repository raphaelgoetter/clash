#!/usr/bin/env node
// pontStatus.js
// État courant du Pont du Troll sans Discord : jour, multiplicateurs,
// événement, répartition SECRÈTE du jour, Rumeurs et Indices, projection du
// résultat au décompte, classement projeté.
//
// Usage : node jeux/scripts/pontStatus.js

import "../env.js";

import { loadPontConfig, readState, readUsernames, compterIndices, formatPieces, jourOuvert, memeRang, estPnj } from "../services/pont.js";
import { projeterJour } from "../discord/handlers/pont.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

(async () => {
  try {
    const config = await loadPontConfig();
    const state = await readState();
    if (!state) {
      console.log("Aucune partie en cours.");
      return;
    }
    console.log(`Salon ${state.channelId} · message ${state.messageId} · publié le ${state.publishedAt}`);
    if (state.termine) {
      console.log("Partie terminée.");
      return;
    }
    if (state.phase === "annonce") {
      console.log("Jour d'annonce : le Jour 1 arrive au prochain passage du cron.");
      return;
    }

    const usernames = await readUsernames();
    const nom = (id) => (estPnj(id) ? `${usernames[id]} (PNJ)` : resolveDisplayName(id, usernames[id]));
    const { cfg, res, entry, ranking } = await projeterJour(state, config);
    console.log(`\nJour ${state.jour}/${config.duree_jours} (${jourOuvert(state.publishedAt) ? "ouvert" : "décompte passé, en attente du cron"})`);
    console.log(`Pierre ×${cfg.pierre} · Cordes ×${cfg.cordes}${cfg.evenement ? ` · événement : ${cfg.evenement}` : ""}`);
    console.log(`\nRépartition (secrète) : Pierre ${res.pierre} · Cordes ${res.cordes}`);
    for (const cote of ["pierre", "cordes"]) {
      const noms = await Promise.all(res.passants[cote].map(nom));
      if (noms.length) console.log(`  ${cote} : ${noms.join(", ")}`);
    }
    if (config.jours_rumeurs.includes(state.jour)) {
      const verite = await Promise.all(entry.rumeurs.verite.map(nom));
      const mensonge = await Promise.all(entry.rumeurs.mensonge.map(nom));
      console.log(`Rumeurs : vérité ${verite.length ? verite.join(", ") : "aucune"} · mensonge ${mensonge.length ? mensonge.join(", ") : "aucun"}`);
    }
    if (config.jours_indice.includes(state.jour)) console.log(`Indices consultés : ${await compterIndices(state.jour)}`);

    console.log("\nProjection au décompte :");
    if (res.personneAttrape) console.log(`  Personne n'est attrapé : pierre +${formatPieces(res.gainParCote.pierre)}, cordes +${formatPieces(res.gainParCote.cordes)} par passant.`);
    else console.log(`  Le troll attrape ${res.attrape} (${res[res.attrape]}), ${res.gagnant} gagne +${formatPieces(res.gainBase)} par passant.`);

    console.log("\nClassement projeté :");
    if (!ranking.length) console.log("  (vide)");
    const lignes = await Promise.all(ranking.map(async (r) => ({ ...r, nom: await nom(r.discordId) })));
    lignes.forEach((r, i, l) => console.log(`  ${rangExAequo(l, i, memeRang)}. ${r.nom} : ${formatPieces(r.centiemes)} pièces, ${r.passes} jour(s) passé(s)`));
  } catch (err) {
    console.error("Échec de la lecture de l'état :", err.message);
    process.exit(1);
  }
})();
