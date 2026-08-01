#!/usr/bin/env node
// postTamagotchi.js
// Poste manuellement (ou via cron) le jour du Tamagoshi (Bébé Dragon
// "Lilith"). Clôture d'abord le jour actif (s'il y en a un) : tallie les
// votes, applique l'impact et l'événement éventuel, note la journée, puis
// publie le jour suivant (ou le message de fin de partie au Jour 10).
//
// Usage :
//   node scripts/postTamagotchi.js                — poste sur le salon de test
//   node scripts/postTamagotchi.js --public        — poste sur le salon public
//   node scripts/postTamagotchi.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postTamagotchi.js --public --dry-run
//   node scripts/postTamagotchi.js --no-ping       — poste sans pinger @MINI JEUX (Jour 1 uniquement)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postTamagotchi } from "../api/discord/handlers/tamagotchi.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const NO_PING = process.argv.includes("--no-ping");

// Réutilise les salons du jeu Frame (même principe qu'Anagram et Aventure,
// voir CONTRIBUTING.md) plutôt que de provisionner de nouveaux salons
// Discord dédiés au Tamagoshi.
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
    const result = await postTamagotchi(channelId, { dryRun: DRY_RUN, noPing: NO_PING });

    if (result.termine) {
      console.log("Défi déjà terminé, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log(`  Fin de partie — palier ${result.tier} (${result.starTotal} étoiles)`);
      } else {
        console.log(`  Jour ${result.jour}`);
      }
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}) — palier ${result.tier}, ${result.starTotal} étoiles.`);
      return;
    }

    console.log(`Jour ${result.jour} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
