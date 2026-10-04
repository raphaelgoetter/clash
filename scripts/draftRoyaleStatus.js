#!/usr/bin/env node
// draftRoyaleStatus.js
// Affiche l'état courant du Draft Royale (phase, jour, mains, contrats,
// dépôts, vœux du jour) sans ouvrir Discord — vue organisateur, les mains
// et contrats y sont donc visibles.
//
// Usage : node scripts/draftRoyaleStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadDraftRoyaleConfig,
  loadCatalog,
  readState,
  readJoueurs,
  readActions,
  readMarche,
  scoreDeck,
  popularitePoints,
  cardsFromKeys,
} from "../backend/services/draftroyale.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucun Draft Royale actif pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("Draft déjà terminé.");
    return;
  }
  if (state.phase === "annonce") {
    console.log("Phase : présentation (le draft commence au prochain post).\n");
    return;
  }

  const [config, catalog, joueurs, actions, marche] = await Promise.all([
    loadDraftRoyaleConfig(),
    loadCatalog(),
    readJoueurs(),
    readActions(state.jour),
    readMarche(state.jour - 1),
  ]);
  const nom = (k) => catalog.get(k)?.fr || k;

  console.log(`Jour ${state.jour}/${config.duree_jours}`);
  console.log(`Marché ouvert aux vœux : ${marche.length ? marche.map((m) => nom(m.key)).join(", ") : "(vide)"}\n`);

  const ranking = Object.entries(joueurs)
    .map(([discordId, j]) => {
      const { total } = scoreDeck(cardsFromKeys(j.main, catalog), j.contrat, config);
      return { discordId, ...j, provisoire: total + popularitePoints(j, config) };
    })
    .sort((a, b) => b.provisoire - a.provisoire || a.username.localeCompare(b.username));

  if (!ranking.length) {
    console.log("Aucun joueur n'a encore rejoint le draft.");
  } else {
    console.log("Joueurs (score provisoire hors majorités) :");
    for (const j of ranking) {
      const contrat = j.contrat ? ` · contrat ${j.contrat.label} ×${j.contrat.multiplicateur}` : "";
      console.log(`  - ${j.username} — ${j.provisoire} pts, popularité ${j.popularite || 0}${contrat}`);
      console.log(`      main (${j.main.length}) : ${j.main.map(nom).join(", ")}`);
      if (j.depots?.length) console.log(`      au marché : ${j.depots.map((d) => `${nom(d.key)} (J${d.jour})`).join(", ")}`);
    }
  }

  console.log(`\nActions enregistrées aujourd'hui : ${Object.keys(actions).length} joueur(s).`);
  for (const [discordId, action] of Object.entries(actions)) {
    const parts = [];
    if (action.pioche) parts.push(`👆 ${nom(action.pioche)}`);
    if (action.depot) parts.push(`dépôt ${nom(action.depot)}`);
    if (action.voeux?.some(Boolean)) parts.push(`vœux ${action.voeux.map((k) => (k ? nom(k) : "-")).join(" > ")}`);
    if (action.contrat) parts.push("✍️ contrat signé");
    console.log(`  - ${joueurs[discordId]?.username || discordId} : ${parts.join(", ") || "(aucune)"}`);
  }
})();
