#!/usr/bin/env node
// postRobinson.js
// Poste manuellement (ou via cron) le jour de Robinson (survie insulaire
// communautaire). Clôture d'abord le jour actif (s'il y en a un) : consomme
// les ressources, applique l'événement éventuel, vérifie victoire/défaite,
// puis publie le jour suivant (ou le message de fin de partie).
//
// Usage :
//   node scripts/postRobinson.js                — poste sur le salon de test
//   node scripts/postRobinson.js --public        — poste sur le salon public
//   node scripts/postRobinson.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postRobinson.js --public --dry-run
//   node scripts/postRobinson.js --no-ping       — poste sans pinger @MINI JEUX (Jour 1 uniquement)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postRobinson } from "../api/discord/handlers/robinson.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Ping @MINI JEUX réservé au vrai lancement public (Jour 1) — jamais sur le
// salon de test, même sans --no-ping explicite, pour ne pas déranger le
// serveur à chaque itération de test pendant le développement du jeu.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe qu'Anagram/Aventure/
// Tamagoshi, voir CONTRIBUTING.md) plutôt que de provisionner de nouveaux
// salons Discord dédiés à Robinson.
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
    const result = await postRobinson(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC });

    if (result.termine) {
      console.log("Partie déjà terminée, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log(`  Fin de partie — issue : ${result.outcome}`);
      } else {
        console.log(`  Jour ${result.jour}${result.event ? ` — événement : ${result.event.nom}` : ""}`);
      }
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }

    console.log(`Jour ${result.jour} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
