#!/usr/bin/env node
// meowStatus.js
// Résumé organisateur de Meow sans ouvrir Discord : jour, points des bandes,
// chats en jeu et perdus au combat de chaque bande, actions du jour de
// chaque joueur (un √ par appel, squat ou déplacement), puis le Caïd des
// coussins (secret pour les joueurs). Les événements horaires en retard sont rattrapés en
// mémoire seulement (rien n'est réécrit).
//
// Usage : node jeux/scripts/meowStatus.js

import "../env.js";

import { loadMeowConfig, readState, readPartie } from "../services/meow.js";
import { BANDES, horloge, jourDe, rattraper, classementBandes, classementCaid, coinsDe, chatsPerdus, actionsDuJour, texteActions } from "../services/meowRules.js";

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

  const pertes = chatsPerdus(partie);
  BANDES.forEach((bd, b) => {
    // Chats en jeu : sur la carte, plus ceux engagés dans un squat en cours
    // (réserves exclues)
    const surCarte = coinsDe(partie, b).reduce((s, c) => s + partie.coins[c].n, 0);
    const enCombat = Object.entries(partie.combats).filter(([id]) => partie.joueurs[id]?.bande === b).reduce((s, [, c]) => s + c.a, 0);
    console.log(`\n${bd.nom} (${surCarte + enCombat} chats / ${pertes[b]} perdus) :`);
    for (const a of actionsDuJour(partie, b, jour)) console.log(`- ${a.username} : ${texteActions(a)}`);
  });

  // Podium du classement individuel (comme le message de fin), secret pour
  // les joueurs jusqu'à la fin
  console.log("\nCaïd des coussins (🚩 territoires pris · 💨 chats délogés) :");
  classementCaid(partie, config).slice(0, 3).forEach((r, i) => console.log(`${i + 1}. ${r.username} ${BANDES[r.bande].emoji} : ${r.score} pt(s) (🚩 ${r.coinsPris ?? 0} · 💨 ${r.chatsDeloges ?? 0})`));
})();
