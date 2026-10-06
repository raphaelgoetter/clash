#!/usr/bin/env node
// draftDuelStatus.js
// Affiche l'état de la partie de Draft (duel) en cours : manche, marché,
// mains, échanges de la manche, points et ancienneté d'inactivité, pour
// décider à la main d'un `npm run draftduel:reset`.
//
// Usage : node scripts/draftDuelStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, readPlayers, readActions, isStale, loadDraftDuelConfig, BOTS, isBot } from "../backend/services/draftDuel.js";
import { loadCatalog } from "../backend/services/draftroyale.js";
import { compterCartes, pointsMain } from "../backend/services/draftRules.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Draft en cours (ou partie d'un ancien format, effacée au prochain lancement).");
    return;
  }
  if (state.termine) {
    console.log(`Partie terminée${state.expired ? " (expirée)" : ""}, sera effacée au prochain lancement.`);
    return;
  }

  const hoursSince = (Date.now() - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  const staleWarning = isStale(state) ? " ⚠️ partie inactive, envisage `npm run draftduel:reset`" : "";
  console.log(`Manche ${state.manche}/${state.totalManches} · ${state.players.length}/${state.maxPlayers} joueur(s)${state.rosterLocked ? " (inscriptions closes)" : ""}`);
  console.log(`Dernière activité il y a ${hoursSince.toFixed(1)}h${staleWarning}\n`);

  const [config, catalog, players, actions] = await Promise.all([loadDraftDuelConfig(), loadCatalog(), readPlayers(), readActions(state.manche)]);
  const nom = (k) => catalog.get(k)?.fr || k;
  const groupes = (keys) => [...compterCartes(keys)].map(([k, n]) => `${nom(k)} ×${n}`).join(", ");
  console.log(`Marché : ${groupes(state.marche) || "(vide)"} · à l'écart : ${groupes(state.reserve || []) || "(aucune)"}\n`);

  const rows = await Promise.all(
    Object.entries(players).map(async ([id, p]) => {
      const a = actions[id] || {};
      return {
        Joueur: isBot(id) ? BOTS.find((b) => b.id === id).name : await resolveDisplayName(id, p.username),
        Main: groupes(p.main),
        Points: `${p.points || 0} (+${pointsMain(p.main, config, state.vedettes || [], catalog)})`,
        Quadruplés: p.carres || 0,
        Joker: p.joker || 0,
        Tour: [a.prise ? `prend ${nom(a.prise)}` : null, a.depot ? `dépose ${nom(a.depot)}` : null, a.joker?.type ? `Joker ${a.joker.type}` : null, a.fini ? "fini" : "en cours"].filter(Boolean).join(", "),
      };
    }),
  );
  console.table(rows);
})();
