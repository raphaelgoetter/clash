#!/usr/bin/env node
// draftRoyaleStatus.js
// Affiche l'état courant du Draft Royale (phase, jour, cartes en jeu,
// marché, mains, échanges prévus du jour) sans ouvrir Discord — vue
// organisateur, les mains y sont donc visibles.
//
// Usage : node scripts/draftRoyaleStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadDraftRoyaleConfig, loadCatalog, readState, readJoueurs, readActions, readPartie } from "../backend/services/draftroyale.js";
import { compterCartes, pointsMain, echangeValide } from "../backend/services/draftRules.js";

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

  const [config, catalog, joueurs, actions, partie] = await Promise.all([
    loadDraftRoyaleConfig(),
    loadCatalog(),
    readJoueurs(),
    readActions(state.jour),
    readPartie(),
  ]);
  const nom = (k) => catalog.get(k)?.fr || k;
  const groupes = (keys) => [...compterCartes(keys)].map(([k, n]) => `${nom(k)} ×${n}`).join(", ");

  console.log(`Jour ${state.jour}/${config.duree_jours}`);
  console.log(`Cartes en jeu (${partie.familles.length}) : ${partie.familles.map(nom).join(", ")}`);
  console.log(`Marché (${partie.marche.length}) : ${groupes(partie.marche) || "(vide)"}`);
  console.log(`À l'écart (${partie.reserve?.length || 0}) : ${groupes(partie.reserve || []) || "(aucune)"}\n`);

  const ranking = Object.entries(joueurs).sort(([, a], [, b]) => (b.points || 0) - (a.points || 0) || a.username.localeCompare(b.username));
  if (!ranking.length) {
    console.log("Aucun joueur n'a encore rejoint le draft.");
  } else {
    console.log("Joueurs :");
    for (const [id, j] of ranking) {
      const a = actions[id] || {};
      const echange = echangeValide(a, j.main, partie.marche) ? `prend ${nom(a.prise)}, dépose ${nom(a.depot)}` : a.prise || a.depot ? "échange incomplet" : "pas d'échange";
      console.log(`  - ${j.username} — ${j.points || 0} pts, ${j.carres || 0} quadruplé(s), ${j.joker || 0} pt(s) Joker`);
      const joker = a.joker?.type ? ` · Joker ${a.joker.type}${a.joker.cible ? ` → ${joueurs[a.joker.cible]?.username || a.joker.cible}` : ""}` : "";
      console.log(`      main : ${groupes(j.main)} (${pointsMain(j.main, config)} pt(s) au décompte) · ${echange}${joker}`);
    }
  }
})();
