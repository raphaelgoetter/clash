#!/usr/bin/env node
// pontStatus.js
// État courant du Pont du Troll sans Discord : jour et phase, Vrai/Faux du
// matin (participants), multiplicateurs, événement, répartition SECRÈTE du jour, Rumeurs et Indices, projection du
// résultat au décompte, classement projeté.
//
// Usage : node jeux/scripts/pontStatus.js

import "../env.js";

import { loadPontConfig, readState, readUsernames, compterIndices, formatPieces, jourOuvert, memeRang, estPnj, MATIN, porteursBonus, listVraiFaux } from "../services/pont.js";
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
      console.log("Jour d'annonce.");
      return;
    }

    const usernames = await readUsernames();
    const nom = (id) => (estPnj(id) ? `${usernames[id]} (PNJ)` : resolveDisplayName(id, usernames[id]));
    // Participants du Vrai/Faux, par ordre de réponse
    const vf = Object.entries(await listVraiFaux(state.jour)).sort(([, a], [, b]) => String(a?.at).localeCompare(String(b?.at)));
    const porteurs = await porteursBonus(state.jour);
    const afficherVraiFaux = async () => {
      console.log(`Vrai/Faux du matin : ${vf.length} réponse(s), ${porteurs.length} bonne(s)`);
      for (const [label, correct] of [["✅", true], ["❌", false]]) {
        const noms = await Promise.all(vf.filter(([, r]) => Boolean(r?.correct) === correct).map(([id]) => nom(id)));
        if (noms.length) console.log(`  ${label} ${noms.join(", ")}`);
      }
    };
    if (state.phase === MATIN) {
      console.log(`\nJour ${state.jour}/${config.duree_jours}, matin`);
      await afficherVraiFaux();
      return;
    }
    const { cfg, res, entry, ranking } = await projeterJour(state, config);
    console.log(`\nJour ${state.jour}/${config.duree_jours}, après-midi (${jourOuvert(state.publishedAt) ? "ponts ouverts" : "ponts fermés, en attente du cron"})`);
    await afficherVraiFaux();
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
    else console.log(`  Le troll attrape ${res.attrape} (${res[res.attrape]}, ${res.bonusPerdus} pièce(s) bonus), ${res.gagnant} gagne +${formatPieces(res.gainBase)} par passant.`);

    console.log("\nClassement projeté :");
    if (!ranking.length) console.log("  (vide)");
    const lignes = await Promise.all(ranking.map(async (r) => ({ ...r, nom: await nom(r.discordId) })));
    lignes.forEach((r, i, l) => console.log(`  ${rangExAequo(l, i, memeRang)}. ${r.nom} : ${formatPieces(r.centiemes)} pièces, ${r.passes} jour(s) passé(s)`));
  } catch (err) {
    console.error("Échec de la lecture de l'état :", err.message);
    process.exit(1);
  }
})();
