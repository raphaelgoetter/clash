#!/usr/bin/env node
// postPont.js
// Publie (à la main ou par le cron) le jour du Pont du Troll. Sans partie
// en cours : jour d'annonce (jamais le Jour 1 directement). Sinon résout
// d'abord le jour actif (troll, butin, Jokers), puis publie le jour suivant
// ou le classement final.
//
// Usage :
//   node jeux/scripts/postPont.js                  — salon de test
//   node jeux/scripts/postPont.js --public         — salon public
//   node jeux/scripts/postPont.js --dry-run        — aperçu, sans écrire ni publier
//   node jeux/scripts/postPont.js --no-ping        — sans ping @MINI-JEUX
//   node jeux/scripts/postPont.js --require-active — rien sans partie lancée (cron)
//   node jeux/scripts/postPont.js --force          — ignore le garde-fou anti-double-avancée
//   node jeux/scripts/postPont.js --sans-pnj       — salon de test sans les 5 joueurs fictifs (PNJ)

import "../env.js";

import { postPont } from "../discord/handlers/pont.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Garde-fou utile seulement sur le salon public (seule cible du cron)
const FORCE = process.argv.includes("--force") || !PUBLIC;
// Jamais de ping hors salon public (verrouillé aussi dans postPont)
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
// Salon de test : 5 PNJ traversent chaque jour (jamais sur le salon public)
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postPont(channelId, {
      dryRun: DRY_RUN,
      noPing: NO_PING,
      isPublic: PUBLIC,
      requireActiveState: REQUIRE_ACTIVE,
      force: FORCE,
      pnj: PNJ,
    });

    if (result.skipped) {
      console.log(
        result.reason === "tooSoonSinceLastClosure"
          ? `Jour ouvert trop récemment (${result.publishedAt}) pour être résolu : probable double déclenchement. Rien n'est publié. --force si le rattrapage est volontaire.`
          : "Aucune partie active, rien à publier (cron sans lancement manuel préalable).",
      );
      return;
    }
    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}), rien n'est publié ici. ` +
          `Partie de test oubliée ? "npm run pont:reset" puis relance sur le bon salon.`,
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
