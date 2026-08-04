#!/usr/bin/env node
// postBossRaid.js
// Poste manuellement (ou via cron) le jour de Boss Raid (score attack
// communautaire contre un Boss Colossal). Clôture d'abord le jour actif
// (s'il y en a un) : calcule les dégâts, applique l'événement éventuel,
// vérifie la fin de partie, puis publie le jour suivant (ou le message de
// fin de Raid).
//
// Usage :
//   node scripts/postBossRaid.js                — poste sur le salon de test
//   node scripts/postBossRaid.js --public        — poste sur le salon public
//   node scripts/postBossRaid.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postBossRaid.js --public --dry-run
//   node scripts/postBossRaid.js --no-ping       — poste sans pinger @MINI JEUX (jour d'annonce uniquement)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postBossRaid } from "../api/discord/handlers/bossraid.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Ping @MINI JEUX réservé au vrai lancement public (jour d'annonce) — jamais
// sur le salon de test, même sans --no-ping explicite, pour ne pas déranger
// le serveur à chaque itération de test pendant le développement du jeu.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe qu'Anagram/Aventure/
// Tamagoshi/Robinson, voir CONTRIBUTING.md) plutôt que de provisionner de
// nouveaux salons Discord dédiés à Boss Raid.
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
    const result = await postBossRaid(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC });

    if (result.termine) {
      console.log("Raid déjà terminé, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log("  Fin du Raid.");
      } else if (result.phase === "annonce") {
        console.log("  Jour d'annonce.");
      } else {
        console.log(`  Jour ${result.jour}${result.event ? ` — événement : ${result.event.nom}` : ""}`);
      }
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Fin du Raid postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }

    console.log(`Jour ${result.jour ?? "d'annonce"} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
