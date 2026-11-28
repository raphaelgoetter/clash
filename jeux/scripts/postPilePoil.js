#!/usr/bin/env node
// postPilePoil.js
// Publie (à la main ou par le cron, vers 9 h) le jour suivant de Pile Poil.
// Premier lancement : présentation et première égalité. Ensuite : récap de
// la veille et égalité du jour (+ classement final du mois écoulé le 1er).
// Jeu sans fin : --pause suspend le cron sans rien effacer, un lancement
// manuel le relance.
//
// Usage :
//   node jeux/scripts/postPilePoil.js                  — salon de test (clés pilepoil:test:*)
//   node jeux/scripts/postPilePoil.js --public         — salon public
//   node jeux/scripts/postPilePoil.js --dry-run        — aperçu, sans écrire ni publier
//   node jeux/scripts/postPilePoil.js --no-ping        — sans ping @MINI-JEUX (lancement)
//   node jeux/scripts/postPilePoil.js --require-active — rien sans jeu lancé ou en pause (cron)
//   node jeux/scripts/postPilePoil.js --force          — publie même moins de 8 h après la veille
//   node jeux/scripts/postPilePoil.js --sans-pnj       — salon de test sans les 5 joueurs fictifs (PNJ)
//   node jeux/scripts/postPilePoil.js --public --pause — met le jeu public en pause

import "../env.js";

import { postPilePoil, mettreEnPause } from "../discord/handlers/pilepoil.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const PAUSE = process.argv.includes("--pause");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Garde-fou utile seulement sur le salon public (seule cible du cron)
const FORCE = process.argv.includes("--force") || !PUBLIC;
// Jamais de ping hors salon public (verrouillé aussi dans postPilePoil)
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
// Salon de test : 5 PNJ jouent chaque égalité (jamais sur le salon public)
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");

(async () => {
  try {
    if (PAUSE) {
      const ok = await mettreEnPause(PUBLIC ? "public" : "test");
      console.log(ok ? "Pile Poil en pause : le cron ne publie plus. Relance par workflow_dispatch." : "Aucun jeu lancé, rien à mettre en pause.");
      return;
    }

    const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_JEUX_PUBLIC : process.env.DISCORD_CHANNEL_JEUX_TEST;
    if (!channelId) {
      console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_JEUX_PUBLIC" : "DISCORD_CHANNEL_JEUX_TEST"}`);
      process.exit(1);
    }

    const result = await postPilePoil(channelId, {
      dryRun: DRY_RUN,
      noPing: NO_PING,
      isPublic: PUBLIC,
      requireActiveState: REQUIRE_ACTIVE,
      force: FORCE,
      pnj: PNJ,
    });

    if (result.skipped) {
      const raisons = {
        pasEncore: `Rien à faire pour l'instant (jour publié le ${result.publishedAt}). --force si la publication est volontaire.`,
        pause: "Jeu en pause, rien à publier (relance par workflow_dispatch).",
      };
      console.log(raisons[result.reason] ?? "Aucun jeu lancé, rien à publier (cron sans lancement manuel préalable).");
      return;
    }
    if (result.wrongChannel) {
      console.error(`Le jeu tourne sur un AUTRE salon (${result.activeChannelId}), rien n'est publié ici.`);
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log(`DRY-RUN (salon ${channelId}) : Pile Poil n°${result.jour}`);
      console.log(JSON.stringify({ embeds: result.embeds, components: result.components || [] }, null, 2));
      return;
    }
    console.log(`Pile Poil n°${result.jour} publié dans ${channelId} (message ${result.message.id})${result.finDeMois ? ", avec le classement final du mois" : ""}.`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
