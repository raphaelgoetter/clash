#!/usr/bin/env node
// postBang.js
// Poste manuellement (ou via cron) le jour de Bang!. Clôture d'abord le
// jour actif (s'il y en a un) : pioches automatiques, Élixir du jour,
// classement final au dernier jour ou s'il ne reste qu'un Roi, puis
// publie le message officiel du jour suivant (ou le message de fin).
//
// Usage :
//   node scripts/postBang.js                — poste sur le salon de test
//   node scripts/postBang.js --public        — poste sur le salon public
//   node scripts/postBang.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postBang.js --public --dry-run
//   node scripts/postBang.js --no-ping       — poste sans pinger @MINI JEUX (présentation et fin)
//   node scripts/postBang.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node scripts/postBang.js --force          — ignore le garde-fou anti-double-avancée

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postBang } from "../api/discord/_handlers/bang.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
const FORCE = process.argv.includes("--force") || !PUBLIC;
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe que les autres jeux
// spéciaux, voir CONTRIBUTING.md) plutôt que de provisionner un salon dédié.
const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postBang(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE, force: FORCE });

    if (result.skipped) {
      if (result.reason === "tooSoonSinceLastClosure") {
        console.log(`Jour ouvert trop récemment (${result.publishedAt}) pour être re-clôturé. Rien n'est posté. Utilise --force si ce rattrapage est volontaire.`);
      } else {
        console.log("Aucune partie active, rien à poster (cron sans lancement manuel préalable).");
      }
      return;
    }
    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}) — rien n'est posté ici. ` +
          `Si c'était une partie de test oubliée, lance "npm run bang:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }
    if (result.termine) {
      console.log("Partie déjà terminée, rien à poster.");
      return;
    }
    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }
    console.log(`Jour ${result.jour ?? "de présentation"} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
