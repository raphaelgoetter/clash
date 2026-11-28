#!/usr/bin/env node
// pilepoilStatus.js
// État courant de Pile Poil sans Discord : jour, égalité SECRÈTE du jour,
// joueurs (essais et retours), classement du mois.
//
// Usage :
//   node jeux/scripts/pilepoilStatus.js           — jeu public
//   node jeux/scripts/pilepoilStatus.js --test    — salon de test (clés pilepoil:test:*)

import "../env.js";

import { loadPilePoilConfig, readState, readSolution, listParties, readUsernames, readPointsMois, readJoursMois, estPnj } from "../services/pilepoil.js";
import { classementMois, memeRangMois, egaliteLisible, signeDe, chiffresDe } from "../services/pilepoilRules.js";
import { ligneRetour } from "../discord/handlers/pilepoil.js";
import { rangExAequo } from "@clash/commun/classement.js";

const espace = process.argv.includes("--test") ? "test" : "public";

(async () => {
  try {
    const config = await loadPilePoilConfig();
    const state = await readState(espace);
    if (!state) {
      console.log(`Aucun jeu lancé (${espace}).`);
      return;
    }
    console.log(`[${espace}] Salon ${state.channelId} · message ${state.messageId} · publié le ${state.publishedAt}${state.pause ? " · EN PAUSE" : ""}`);
    const solution = await readSolution(espace, state.jour);
    console.log(`Pile Poil n°${state.jour} · égalité SECRÈTE : ${solution ? egaliteLisible(signeDe(solution), chiffresDe(solution)) : "?"}`);

    const usernames = await readUsernames(espace);
    const nom = (id) => `${usernames[id] ?? id}${estPnj(id) ? " (PNJ)" : ""}`;
    const parties = Object.entries(await listParties(espace, state.jour));
    console.log(`\n${parties.length} joueur(s) aujourd'hui :`);
    for (const [id, p] of parties) {
      const etat = p.trouve ? `trouvé en ${p.essais.length} (+${p.points})` : `${p.essais.length}/${config.essais} essais`;
      console.log(`- ${nom(id)} : ${etat} · ${p.essais.map((e) => ligneRetour(e.retour)).join(" ")}`);
    }

    const ranking = classementMois(await readPointsMois(espace, state.seasonId), await readJoursMois(espace, state.seasonId));
    console.log("\nClassement du mois :");
    if (!ranking.length) console.log("(vide)");
    ranking.forEach((r, i) => console.log(`${rangExAequo(ranking, i, memeRangMois)}. ${nom(r.discordId)} : ${r.points} pts, ${r.jours} jours`));
  } catch (err) {
    console.error("Échec :", err.message);
    process.exit(1);
  }
})();
