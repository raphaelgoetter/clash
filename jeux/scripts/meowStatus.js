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
import { BANDES, horloge, jourDe, rattraper, classementBandes, actionsDuJour, texteActions } from "../services/meowRules.js";

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

  BANDES.forEach((bd, b) => {
    console.log(`\n${bd.nom} :`);
    for (const a of actionsDuJour(partie, b, jour)) console.log(`- ${a.username} : ${texteActions(a)}`);
  });
})();
