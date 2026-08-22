#!/usr/bin/env node
// postQuiz.js
// Poste manuellement (ou via cron) le jour du Quiz thématique. Clôture
// silencieusement le jour actif (s'il y en a un) et publie le jour suivant
// (ou l'embed de révélation finale au Jour 8).
//
// Usage :
//   node scripts/postQuiz.js                — poste sur le salon de test
//   node scripts/postQuiz.js --public        — poste sur le salon public
//   node scripts/postQuiz.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postQuiz.js --public --dry-run
//   node scripts/postQuiz.js --no-ping       — poste sans pinger @MINI-JEUX (Jour 1 uniquement)
//   node scripts/postQuiz.js --require-active — ne fait rien si aucune manche n'est déjà lancée (cron)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postQuiz } from "../api/discord/_handlers/quiz.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Réservé au cron quotidien (voir .github/workflows/quiz.yml) : le Jour 1
// doit toujours être déclenché manuellement (workflow_dispatch), le cron ne
// fait qu'avancer une manche déjà en cours.
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Ping @MINI-JEUX réservé au vrai lancement public (Jour 1) — jamais sur le
// salon de test, même sans --no-ping explicite.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe que Tamagoshi/Anagram)
// plutôt que de provisionner de nouveaux salons Discord dédiés au Quiz.
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
    const result = await postQuiz(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE });

    if (result.skipped) {
      console.log("Aucune manche active, rien à poster (cron sans lancement manuel préalable).");
      return;
    }

    // `result.termine` seul (sans `final`) signifie que la manche était déjà
    // close par un appel PRÉCÉDENT — rien à reposter. Quand cet appel-ci vient
    // de poster la révélation, le handler ajoute `final: true` en plus (voir
    // handlers/quiz.js), à vérifier AVANT ce check générique.
    if (result.termine && !result.final) {
      console.log("Quiz déjà terminé, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log("  Révélation finale");
      } else {
        console.log(`  Jour ${result.jour}${result.theme ? ` — ${result.theme}` : ""}`);
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
