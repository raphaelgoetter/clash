#!/usr/bin/env node
// postAventure.js
// Poste manuellement (ou via cron) le chapitre du jour de l'Aventure
// interactive. Résout d'abord les votes du chapitre actif (s'il y en a
// un), supprime son message, puis publie le chapitre suivant.
//
// Usage :
//   node scripts/postAventure.js                — poste sur le salon de test
//   node scripts/postAventure.js --public        — poste sur le salon public
//   node scripts/postAventure.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postAventure.js --public --dry-run
//   node scripts/postAventure.js --no-ping       — poste sans pinger @MINI JEUX (Jour 1 uniquement)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postChapter } from "../api/discord/handlers/aventure.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const NO_PING = process.argv.includes("--no-ping");

// Réutilise les salons du jeu Frame (même principe que le jeu Anagram,
// voir CONTRIBUTING.md) plutôt que de provisionner de nouveaux salons
// Discord dédiés à l'Aventure.
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
    const result = await postChapter(channelId, { dryRun: DRY_RUN, noPing: NO_PING });

    if (result.termine) {
      console.log("Histoire déjà terminée, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochain chapitre (salon ${channelId}) :`);
      console.log(`  Chapitre : ${result.chapitreId} — ${result.chapitreEntry.titre}`);
      console.log(`  Ping @MINI JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    console.log(
      `Chapitre "${result.chapitreId}" posté dans ${channelId} (message ${result.message.id})${result.estFinal ? " — fin de l'histoire." : ""}`,
    );
  } catch (err) {
    console.error("Échec de la publication du chapitre :", err.message);
    process.exit(1);
  }
})();
