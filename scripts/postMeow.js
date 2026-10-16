#!/usr/bin/env node
// postMeow.js
// Poste manuellement (ou via cron) l'étape suivante de Meow : ouverture des
// inscriptions, rappel quotidien, prolongation (effectif minimum non
// atteint) ou Jour 1 ; puis chaque matin, rattrapage des événements de la
// nuit (décompte compris) et message du jour (ou message de fin après le
// décompte du dernier jour).
//
// Usage :
//   node scripts/postMeow.js                  — poste sur le salon de test
//   node scripts/postMeow.js --public         — poste sur le salon public
//   node scripts/postMeow.js --dry-run        — simulation, sans écrire ni poster
//   node scripts/postMeow.js --public --dry-run
//   node scripts/postMeow.js --no-ping        — poste sans pinger @MINI JEUX (présentation et fin)
//   node scripts/postMeow.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node scripts/postMeow.js --force          — republie le message du jour même s'il l'a déjà été
//   node scripts/postMeow.js --sans-pnj       — salon de test sans les joueurs fictifs (PNJ) inscrits au J1
//   node scripts/postMeow.js --force-close    — ignore la date de clôture des inscriptions (lance la partie si
//                                               l'effectif minimum est atteint) ; implicite sur le salon de test
//   node scripts/postMeow.js --distribution   — salon de test : avance jusqu'à la prochaine distribution (8h, 13h,
//                                               21h) au lieu du lendemain 8h22 (par défaut, un jour par lancement)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postMeow } from "../api/discord/_handlers/meow.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Salon de test : clôture des inscriptions forcée et PNJ pour atteindre
// l'effectif minimum (voir tirerPnj).
const FORCE_CLOSE = process.argv.includes("--force-close") || !PUBLIC;
const FORCE = process.argv.includes("--force") || !PUBLIC;
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");
// Salon de test : la partie suit son horloge propre, avancée à chaque
// lancement (un jour, ou une distribution avec --distribution).
const AVANCER = PUBLIC ? null : process.argv.includes("--distribution") ? "distribution" : "jour";

// Réutilise les salons du jeu Frame (même principe que les autres jeux
// spéciaux, voir CONTRIBUTING.md) plutôt que de provisionner un salon dédié.
const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postMeow(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE, force: FORCE, forceClose: FORCE_CLOSE, pnj: PNJ, avancer: AVANCER });

    if (result.skipped) {
      if (result.reason === "dejaPublie") {
        console.log(`Message du jour ${result.jour} déjà publié. Rien n'est posté. Utilise --force pour le republier.`);
      } else {
        console.log("Aucune partie active, rien à poster (cron sans lancement manuel préalable).");
      }
      return;
    }
    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}) — rien n'est posté ici. ` +
          `Si c'était une partie de test oubliée, lance "npm run meow:reset" puis relance sur le bon salon.`,
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
    if (result.prolongation) {
      console.log(`Effectif minimum non atteint : inscriptions prolongées dans ${channelId} (message ${result.message.id}).`);
      return;
    }
    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }
    console.log(`${result.jour ? `Jour ${result.jour}` : "Message d'inscription"} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
