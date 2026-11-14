#!/usr/bin/env node
// quiEstCeStatus.js
// Affiche l'état courant de Qui est-ce ? (phase, jour, cartes secrètes,
// cibles, actions du jour, scores) sans ouvrir Discord — vue organisateur,
// les cartes secrètes y sont donc visibles.
//
// Usage : node jeux/scripts/quiEstCeStatus.js

import "../env.js";

import { loadQuiEstCeConfig, readState, readPartie } from "../services/quiestce.js";
import { nomCarte, candidats, classement, texteJournal } from "../services/quiestceRules.js";

const plural = (n, mot) => `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Qui est-ce ? active pour le moment.");
    return;
  }
  const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readPartie()]);
  if (state.phase === "annonce") {
    const inscrits = Object.values(partie.joueurs).map((j) => j.username);
    console.log(`Phase : inscriptions, clôture le ${new Date(state.closingAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}. Inscrits (${inscrits.length}/${config.effectif_max}, minimum ${config.effectif_min}) : ${inscrits.join(", ") || "aucun"}`);
    return;
  }
  console.log(`Jour ${state.jour}/${config.duree_jours}${state.termine ? " (terminée)" : ""}\n`);
  // Une ligne par joueur (ordre du classement) : points, carte, cible, et
  // actions du jour comme Meow (√ fait, ✗ accusation ratée)
  const jour = partie.numeroJour ?? 1;
  for (const r of classement(partie)) {
    const j = partie.joueurs[r.discordId];
    const cible = j.cible ? `${partie.joueurs[j.cible].username} (${candidats(partie, r.discordId).length} possibles)` : "sans cible";
    const juste = partie.journal.some((e) => e.k === "demasque" && e.s === r.discordId && e.j === jour);
    const actions = [
      j.questionsJour ? `question ${"√".repeat(j.questionsJour)}` : null,
      j.accusationsJour ? `accusation ${juste ? "√" : "✗"}` : null,
      j.objetsJour ? `objet ${"√".repeat(j.objetsJour)}` : null,
    ].filter(Boolean);
    const etat = j.actifJour ? actions.join(" · ") || "cible choisie" : "pas encore joué";
    console.log(`${r.rang}. ${j.username} (${plural(r.score, "pt")}) · ${nomCarte(partie, j.carte)}${j.brouillard ? " 🌫️" : ""}${j.miroir ? " 🪞" : ""} → ${cible} · ${etat}`);
  }
  console.log("\nDerniers événements :");
  for (const e of partie.journal.filter((x) => !x.p).slice(-10)) console.log(`  J${e.j} ${texteJournal(partie, e).replace(/\*\*/g, "")}`);
})();
