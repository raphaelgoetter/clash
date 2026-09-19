#!/usr/bin/env node
// postPeleMele.js
// Poste manuellement une nouvelle manche du jeu "Pêle-mêle" — force le post
// de CE jeu précis, sans passer par l'alternance saisonnière (voir
// scripts/postJeuxDeLettres.js, le point d'entrée normal en production, qui
// décide lui-même si c'est Anagram ou Pêle-mêle qui doit poster). Utile pour
// tester ou rattraper un créneau manqué de Pêle-mêle spécifiquement, une
// fois que c'est bien sa saison. Réutilise DISCORD_CHANNEL_FRAME_PUBLIC/TEST
// (voir CONTRIBUTING.md) plutôt que de nouvelles variables dédiées.
//
// Usage :
//   node scripts/postPeleMele.js               — poste sur le salon de test
//   node scripts/postPeleMele.js --public       — poste sur le salon public
//   node scripts/postPeleMele.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postPeleMele.js --force        — ignore le garde-fou anti-double-post
//   node scripts/postPeleMele.js --no-ping      — poste sans pinger @MINI JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postPeleMele } from "../api/discord/_handlers/pelemele.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
// Jamais de ping sur le salon de test, même sans --no-ping explicite (voir
// postAnagram.js/postTamagotchi.js pour le même garde-fou).
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postPeleMele(channelId, { dryRun: DRY_RUN, force: FORCE, noPing: NO_PING });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) :`);
      console.log(`  Pool éligible : ${result.poolSize} cartes`);
      console.log(`  Ping @MINI JEUX : ${result.pingRoleId ? "oui" : "non"}`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée dans ${channelId} (message ${result.message.id}).`);
    console.log(`Lettres tirées : ${result.state.letters.join(" ")}`);
  } catch (err) {
    console.error("Échec de la publication :", err.message);
    process.exit(1);
  }
})();
