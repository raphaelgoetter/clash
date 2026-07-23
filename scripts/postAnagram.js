#!/usr/bin/env node
// postAnagram.js
// Poste manuellement (ou via cron) une nouvelle partie du jeu Anagram.
// Aucune commande Discord associée : c'est l'unique déclencheur de
// publication, en phase de test comme en production.
//
// Usage :
//   node scripts/postAnagram.js                — poste sur le salon de test
//   node scripts/postAnagram.js --public        — poste sur le salon public
//   node scripts/postAnagram.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postAnagram.js --force         — ignore le gating hebdomadaire
//                                                  (jour + tirage aléatoire),
//                                                  utile pour tester ou rattraper
//                                                  un créneau manqué
//   node scripts/postAnagram.js --public --dry-run

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postAnagram } from "../api/discord/handlers/anagrams.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");

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
    const result = await postAnagram(channelId, { dryRun: DRY_RUN, force: FORCE });

    if (DRY_RUN) {
      if (result.seasonRecapEmbed) {
        console.log("DRY-RUN — récap de fin de saison qui serait posté AVANT la manche :");
        console.log(JSON.stringify({ embeds: [result.seasonRecapEmbed] }, null, 2));
        console.log("");
      }
      console.log(`DRY-RUN — prochaine partie (salon ${channelId}) :`);
      console.log(`  Anagramme : ${result.entry.anagram} (réponse : ${result.entry.answer})`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(
      `Partie postée dans ${channelId} — anagramme "${result.entry.anagram}" (message ${result.message.id})`,
    );
  } catch (err) {
    console.error("Échec de la publication Anagram :", err.message);
    process.exit(1);
  }
})();
