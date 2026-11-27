#!/usr/bin/env node
// postCoffre.js
// Publie (à la main ou par le cron, vers 8h30) le jour suivant du Coffre.
// Sans partie en cours : jour d'annonce (jamais le Jour 1 directement).
// Ensuite : résultat de la veille (code révélé) et nouveau coffre, ou
// classement final après le Jour 7.
//
// Usage :
//   node jeux/scripts/postCoffre.js                  — salon de test
//   node jeux/scripts/postCoffre.js --public         — salon public
//   node jeux/scripts/postCoffre.js --dry-run        — aperçu, sans écrire ni publier
//   node jeux/scripts/postCoffre.js --no-ping        — sans ping @MINI-JEUX
//   node jeux/scripts/postCoffre.js --require-active — rien sans partie lancée (cron)
//   node jeux/scripts/postCoffre.js --force          — avance même si le jour n'est pas fini
//   node jeux/scripts/postCoffre.js --sans-pnj       — salon de test sans les 5 joueurs fictifs (PNJ)

import "../env.js";

import { postCoffre } from "../discord/handlers/coffre.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Garde-fou utile seulement sur le salon public (seule cible du cron)
const FORCE = process.argv.includes("--force") || !PUBLIC;
// Jamais de ping hors salon public (verrouillé aussi dans postCoffre)
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
// Salon de test : 5 PNJ jouent chaque coffre (jamais sur le salon public)
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postCoffre(channelId, {
      dryRun: DRY_RUN,
      noPing: NO_PING,
      isPublic: PUBLIC,
      requireActiveState: REQUIRE_ACTIVE,
      force: FORCE,
      pnj: PNJ,
    });

    if (result.skipped) {
      console.log(
        result.reason === "pasEncore"
          ? `Rien à faire pour l'instant (« ${result.phase} » publié le ${result.publishedAt}). --force si l'avancée est volontaire.`
          : "Aucune partie active, rien à publier (cron sans lancement manuel préalable).",
      );
      return;
    }
    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}), rien n'est publié ici. ` +
          `Partie de test oubliée ? "npm run coffre:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }
    if (result.termine) {
      console.log("Partie déjà terminée, rien à publier.");
      return;
    }
    if (DRY_RUN) {
      const quoi = result.phase === "annonce" ? "Jour d'annonce" : result.final ? "Classement final" : `Jour ${result.jour}`;
      console.log(`DRY-RUN (salon ${channelId}) : ${quoi}`);
      console.log(JSON.stringify({ embeds: result.embeds, components: result.components || [] }, null, 2));
      return;
    }
    const quoi = result.final ? "Classement final" : result.jour == null ? "Jour d'annonce" : `Jour ${result.jour}`;
    console.log(`${quoi} publié dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
