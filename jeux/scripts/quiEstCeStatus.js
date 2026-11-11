#!/usr/bin/env node
// quiEstCeStatus.js
// Affiche l'état courant de Qui est-ce ? (phase, jour, cartes secrètes,
// cibles, indices, scores) sans ouvrir Discord — vue organisateur, les
// cartes secrètes y sont donc visibles.
//
// Usage : node jeux/scripts/quiEstCeStatus.js

import "../env.js";

import { loadQuiEstCeConfig, readState, readPartie } from "../services/quiestce.js";
import { nomCarte, candidats, classement, texteJournal, compteRendu, stats, OBJETS } from "../services/quiestceRules.js";

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
  console.log(`Jour ${state.jour}/${config.duree_jours}${state.termine ? " (terminée)" : ""} · questions du jour : ${(config.pool[String(partie.numeroJour)] ?? []).join(", ")}`);
  console.log(`Grille (${partie.grille.length} cartes) : ${partie.grille.map((k) => nomCarte(partie, k)).join(", ")}\n`);
  console.log("Classement :");
  for (const r of classement(partie)) {
    const j = partie.joueurs[r.discordId];
    const cible = j.cible ? `${partie.joueurs[j.cible].username} (${candidats(partie, r.discordId).length} cartes possibles, ${j.enquete.ordre.join("/") || "aucun indice"})` : "aucune";
    console.log(`  ${r.rang}. ${j.username} — ${r.score} pt(s) · ${r.decouvertes} découverte(s) · ${j.nbDemasque}× démasqué · ${j.erreurs} ratée(s) · carte ${nomCarte(partie, j.carte)} · objets [${j.objets.join(", ")}]${j.brouillard ? " · 🌫️" : ""}${j.miroir ? " · 🪞" : ""} · cible ${cible}${j.objetRecuJour ? "" : " · pas encore joué"}`);
  }
  // Statistiques du compte-rendu (objets reçus/utilisés, pile ou face, Brouillard)
  console.log("\nStatistiques :");
  const objets = (t) => Object.entries(t).map(([o, n]) => `${OBJETS[o]?.emoji ?? o}×${n}`).join(" ") || "aucun";
  for (const r of classement(partie)) {
    const s = stats(partie.joueurs[r.discordId]);
    console.log(`  ${r.username} — reçus ${objets(s.recus)} · utilisés ${objets(s.utilises)} · pile ou face ${s.pileFaceGagnes} gagné(s) / ${s.pileFacePerdus} perdu(s) · ${s.brouillees} question(s) brouillée(s)`);
  }
  console.log("\nLa partie en bref (message de fin) :");
  for (const p of compteRendu(partie)) console.log(`  - ${p.replace(/\*\*/g, "")}`);
  console.log("\nDerniers événements :");
  for (const e of partie.journal.filter((x) => !x.p).slice(-10)) console.log(`  J${e.j} ${texteJournal(partie, e).replace(/\*\*/g, "")}`);
})();
