#!/usr/bin/env node
// quiEstCeStatus.js
// Affiche l'état courant de Qui est-ce ? (phase, jour, cartes secrètes,
// cibles, indices, scores) sans ouvrir Discord — vue organisateur, les
// cartes secrètes y sont donc visibles.
//
// Usage : node scripts/quiEstCeStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadQuiEstCeConfig, readState, readPartie } from "../backend/services/quiestce.js";
import { nomCarte, candidats, classement, texteJournal } from "../backend/services/quiestceRules.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Qui est-ce ? active pour le moment.");
    return;
  }
  const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readPartie()]);
  if (state.phase === "annonce") {
    const inscrits = Object.values(partie.joueurs).map((j) => j.username);
    console.log(`Phase : présentation (la partie commence au prochain post). Inscrits (${inscrits.length}) : ${inscrits.join(", ") || "aucun"}`);
    return;
  }
  console.log(`Jour ${state.jour}/${config.duree_jours}${state.termine ? " (terminée)" : ""} · questions du jour : ${(config.pool[String(partie.numeroJour)] ?? []).join(", ")}`);
  console.log(`Grille (${partie.grille.length} cartes) : ${partie.grille.map((k) => nomCarte(partie, k)).join(", ")}\n`);
  console.log("Classement :");
  for (const r of classement(partie)) {
    const j = partie.joueurs[r.discordId];
    const cible = j.cible ? `${partie.joueurs[j.cible].username} (${candidats(partie, r.discordId).length} cartes possibles, ${j.enquete.ordre.join("/") || "aucun indice"})` : "aucune";
    console.log(`  ${r.rang}. ${j.username} — ${r.score} pts · prime ${j.prime} · ${j.or} Or · carte ${nomCarte(partie, j.carte)} · cible ${cible}${j.actifJour ? "" : " · pas encore joué"}`);
  }
  console.log("\nDerniers événements :");
  for (const e of partie.journal.filter((x) => !x.p).slice(-10)) console.log(`  J${e.j} ${texteJournal(partie, e).replace(/\*\*/g, "")}`);
})();
