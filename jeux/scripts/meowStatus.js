#!/usr/bin/env node
// meowStatus.js
// Résumé organisateur de Meow sans ouvrir Discord : jour, points des bandes
// et actions du jour de chaque joueur (un √ par appel, squat ou
// déplacement). Les événements horaires en retard sont rattrapés en
// mémoire seulement (rien n'est réécrit).
//
// Usage : node jeux/scripts/meowStatus.js

import "../env.js";

import { loadMeowConfig, readState, readPartie } from "../services/meow.js";
import { BANDES, horloge, jourDe, rattraper, classementBandes } from "../services/meowRules.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Meow active pour le moment.");
    return;
  }
  const [config, partie] = await Promise.all([loadMeowConfig(), readPartie()]);

  if (!partie.demarree) {
    const inscrits = Object.values(partie.joueurs).sort((a, b) => a.arrivee - b.arrivee).map((j) => j.username);
    console.log(`Inscriptions (${inscrits.length}/${config.effectif_max}, minimum ${config.effectif_min}) : ${inscrits.join(", ") || "aucun"}`);
    return;
  }

  rattraper(partie, { config });
  const jour = jourDe(partie, horloge(partie));
  const points = classementBandes(partie).map((r) => `${BANDES[r.b].nom} ${r.points}`).join(" · ");
  console.log(`Salon ${state.isPublic ? "public" : "de test"} · Jour ${Math.min(jour, config.duree_jours)}/${config.duree_jours}${partie.termine ? " (terminée)" : ""} · ${points}`);

  // Appels et squats du jour d'après le journal ; un squat en plein combat
  // n'y est pas encore, il compte quand même.
  const compte = (id, k) => partie.journal.filter((e) => e.p === id && e.k === k && e.j === jour).length;
  // Déplacements faits avant l'ajout de `deplacementsJour` : repli sur le
  // compteur depuis la distribution, s'il date d'aujourd'hui.
  const deplacementsDuJour = (j) => {
    if (j.deplacementsJour) return j.deplacementsJour.jour === jour ? j.deplacementsJour.n : 0;
    return j.jourActif === jour ? (j.deplacements ?? 0) : 0;
  };

  BANDES.forEach((bd, b) => {
    console.log(`\n${bd.nom} :`);
    const joueurs = Object.entries(partie.joueurs)
      .filter(([, j]) => j.bande === b)
      .sort(([, x], [, y]) => x.username.localeCompare(y.username));
    for (const [id, j] of joueurs) {
      const faites = [
        ["appel", compte(id, "appel")],
        ["squat", compte(id, "squat") + (partie.combats[id] ? 1 : 0)],
        ["déplacement", deplacementsDuJour(j)],
      ].filter(([, n]) => n > 0);
      console.log(`- ${j.username} : ${faites.map(([nom, n]) => `${nom} ${"√".repeat(n)}`).join(" ") || "aucune action"}`);
    }
  });
})();
