#!/usr/bin/env node
// coffreStatus.js
// État courant du Coffre sans Discord : jour, code SECRET du jour, joueurs
// (essais, coffre ouvert ou non, indice), classement.
//
// Usage : node jeux/scripts/coffreStatus.js

import "../env.js";

import {
  loadCoffreConfig,
  readState,
  readCode,
  listParties,
  readUsernames,
  readPoints,
  readEssaisTotal,
  buildRanking,
  memeRang,
  indiceDuJoueur,
  texteIndice,
  symbole,
  estPnj,
  jourOuvert,
} from "../services/coffre.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

const emojis = (code) => (code ?? []).map((s) => symbole(s)?.emoji ?? "?").join(" ");

(async () => {
  try {
    const config = await loadCoffreConfig();
    const state = await readState();
    if (!state) {
      console.log("Aucune partie en cours.");
      return;
    }
    console.log(`Salon ${state.channelId} · message ${state.messageId} · publié le ${state.publishedAt}`);
    if (state.termine) {
      console.log("Partie terminée.");
      return;
    }
    if (state.phase === "annonce") {
      console.log("Jour d'annonce.");
      return;
    }
    const code = await readCode(state.jour);
    console.log(`Jour ${state.jour}/${config.duree_jours} · ${jourOuvert(state.publishedAt) ? "coffre ouvert aux essais" : "coffre fermé (minuit passé)"}`);
    console.log(`Code SECRET du jour : ${emojis(code)}`);

    const usernames = await readUsernames();
    const nom = async (id) => (estPnj(id) ? `${usernames[id]} (PNJ)` : resolveDisplayName(id, usernames[id]));
    const parties = Object.entries(await listParties(state.jour));
    console.log(`\n${parties.length} joueur(s) aujourd'hui :`);
    for (const [id, p] of parties) {
      const etat = p.ouvert ? `ouvert en ${p.essais.length} (+${p.points})` : `${p.essais.length}/${config.essais_par_jour} essais`;
      console.log(`- ${await nom(id)} : ${etat} · indice « ${texteIndice(indiceDuJoueur(code, state.partieId, state.jour, id))} »`);
    }

    const ranking = buildRanking(await readPoints(), await readEssaisTotal());
    console.log("\nClassement :");
    if (!ranking.length) console.log("(vide)");
    for (const [i, r] of ranking.entries()) {
      console.log(`${rangExAequo(ranking, i, memeRang)}. ${await nom(r.discordId)} : ${r.points} pts, ${r.essais} essais`);
    }
  } catch (err) {
    console.error("Échec :", err.message);
    process.exit(1);
  }
})();
