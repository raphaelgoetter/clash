#!/usr/bin/env node
// postPeleMele.js
// Poste manuellement une nouvelle manche du jeu "Pêle-mêle", sur
// le salon de TEST uniquement — voir api/discord/_handlers/pelemele.js
// pour le détail. Pas d'option --public : ce jeu doit encore remplacer un
// mini-jeu existant dont le choix n'est pas arrêté, et il n'y a pas de cron
// GitHub Actions tant que cette décision n'est pas prise. Réutilise le salon
// de test partagé DISCORD_CHANNEL_FRAME_TEST (voir CONTRIBUTING.md) plutôt
// qu'une nouvelle variable dédiée.
//
// Usage :
//   node scripts/postPeleMele.js               — poste sur le salon de test
//   node scripts/postPeleMele.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postPeleMele.js --force        — ignore le garde-fou anti-double-post

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postPeleMele } from "../api/discord/_handlers/pelemele.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const channelId = process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error("Variable d'environnement manquante : DISCORD_CHANNEL_FRAME_TEST");
  process.exit(1);
}

(async () => {
  try {
    const result = await postPeleMele(channelId, { dryRun: DRY_RUN, force: FORCE });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (salon ${channelId}) :`);
      console.log(`  Pool éligible : ${result.poolSize} cartes`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche postée sur le salon de test (message ${result.message.id}).`);
    console.log(`Lettres tirées : ${result.state.letters.join(" ")}`);
  } catch (err) {
    console.error("Échec de la publication :", err.message);
    process.exit(1);
  }
})();
