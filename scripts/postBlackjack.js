#!/usr/bin/env node
// postBlackjack.js
// Poste manuellement (ou via cron) le jour de Blackjack. Clôture d'abord le
// jour actif (s'il y en a un) : résout toutes les mains face au Croupier,
// attribue les points, puis publie le jour suivant (ou la révélation finale).
//
// Usage :
//   node scripts/postBlackjack.js                — poste sur le salon de test
//   node scripts/postBlackjack.js --public        — poste sur le salon public
//   node scripts/postBlackjack.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postBlackjack.js --public --dry-run
//   node scripts/postBlackjack.js --no-ping       — poste sans pinger @MINI JEUX
//   node scripts/postBlackjack.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node scripts/postBlackjack.js --force          — ignore le garde-fou anti-double-avancée

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postBlackjack } from "../api/discord/_handlers/blackjack.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Réservé au cron quotidien (voir .github/workflows/blackjack.yml) : le
// Jour 1 doit toujours être déclenché manuellement (workflow_dispatch), le
// cron ne fait qu'avancer une partie déjà en cours.
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Contourne le garde-fou anti-double-avancée (voir backend/services/blackjack.js,
// isTooSoonSinceLastClosure) — protège uniquement le salon public contre un
// cron en retard après une relance manuelle (voir .github/workflows/blackjack.yml,
// le cron ne cible jamais le salon de test). Sur le salon de test, aucun cron
// ne peut jamais entrer en conflit : le garde-fou n'y sert à rien d'autre
// qu'à ralentir l'itération manuelle, donc contourné automatiquement.
const FORCE = process.argv.includes("--force") || !PUBLIC;
// Jamais de ping sur le salon de test, même sans --no-ping explicite (voir
// CONTRIBUTING.md) — seul le salon public ping réellement @MINI JEUX.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe que les autres mini-jeux,
// voir CONTRIBUTING.md) plutôt que de provisionner de nouveaux salons Discord.
const channelId = PUBLIC
  ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC
  : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(
    `Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`,
  );
  process.exit(1);
}

(async () => {
  try {
    const result = await postBlackjack(channelId, {
      dryRun: DRY_RUN,
      noPing: NO_PING,
      isPublic: PUBLIC,
      requireActiveState: REQUIRE_ACTIVE,
      force: FORCE,
    });

    if (result.skipped) {
      if (result.reason === "tooSoonSinceLastClosure") {
        console.log(
          `Jour ouvert trop récemment (${result.publishedAt}) pour être re-clôturé — probable double déclenchement ` +
            `(cron en retard + relance manuelle, ou double cron). Rien n'est posté. Utilise --force si ce rattrapage est volontaire.`,
        );
      } else {
        console.log("Aucune partie active, rien à poster (cron sans lancement manuel préalable).");
      }
      return;
    }

    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}) — rien n'est posté ici pour éviter tout mélange. ` +
          `Si c'était une partie de test oubliée, lance "npm run blackjack:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }

    if (result.termine) {
      console.log("Partie déjà terminée, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log("  Révélation finale.");
      } else {
        console.log(`  Jour ${result.jour}`);
      }
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Révélation finale postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }

    console.log(`Jour ${result.jour} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
