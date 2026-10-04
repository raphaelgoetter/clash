#!/usr/bin/env node
// draftDuelStatus.js
// Affiche l'état de la partie de Draft (duel) en cours : manche, marché,
// mains, actions de la manche, score provisoire et ancienneté
// d'inactivité, pour décider à la main d'un `npm run draftduel:reset`.
//
// Usage : node scripts/draftDuelStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readState, readPlayers, readActions, scoreProvisoire, isStale, loadDraftDuelConfig } from "../backend/services/draftDuel.js";
import { loadCatalog } from "../backend/services/draftroyale.js";
import { resolveDisplayName } from "../backend/services/discordUsers.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Draft en cours.");
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
  console.log(`Marché : ${state.marche?.length ? state.marche.map((m) => `${nom(m.key)}${m.discordId ? "" : " (Marchand)"}`).join(", ") : "(vide)"}\n`);

  const rows = await Promise.all(
    Object.entries(players).map(async ([id, p]) => {
      const a = actions[id] || {};
      return {
        Joueur: id === "bot" ? "Bot" : await resolveDisplayName(id, p.username),
        Cartes: p.main.length,
        Score: scoreProvisoire(p, config, catalog).total,
        Popularité: p.popularite || 0,
        Tour: [a.pioche ? `pioche ${nom(a.pioche)}` : null, a.depot ? `dépôt ${nom(a.depot)}` : null, a.voeux?.some(Boolean) ? `vœux ${a.voeux.map((k) => (k ? nom(k) : "-")).join(" > ")}` : null, a.fini ? "fini" : "en cours"]
          .filter(Boolean)
          .join(", "),
      };
    }),
  );
  console.table(rows);
})();
