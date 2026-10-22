#!/usr/bin/env node
// postQuiEstCe.js
// Poste manuellement (ou via cron) l'étape suivante de Qui est-ce ? :
// ouverture des inscriptions, rappel quotidien, annulation (effectif
// minimum non atteint) ou Jour 1 ; puis chaque jour, clôture du jour actif
// (primes, classement final au dernier jour) et message du jour suivant (ou
// message de fin).
//
// Usage :
//   node scripts/postQuiEstCe.js                — poste sur le salon de test
//   node scripts/postQuiEstCe.js --public        — poste sur le salon public
//   node scripts/postQuiEstCe.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postQuiEstCe.js --public --dry-run
//   node scripts/postQuiEstCe.js --no-ping       — poste sans pinger @MINI JEUX (présentation et fin)
//   node scripts/postQuiEstCe.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node scripts/postQuiEstCe.js --force          — ignore le garde-fou anti-double-avancée
//   node scripts/postQuiEstCe.js --sans-pnj       — salon de test sans les 6-7 joueurs fictifs (PNJ) inscrits au J1
//   node scripts/postQuiEstCe.js --force-close    — ignore la date de clôture des inscriptions (lance la partie si
//                                                  l'effectif minimum est atteint) ; implicite sur le salon de test

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postQuiEstCe } from "../api/discord/_handlers/quiestce.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Salon de test : la clôture des inscriptions est forcée (comme --force),
// pour passer au Jour 1 sans attendre les 3 jours ; des PNJ complètent
// l'effectif minimum (voir tirerPnj).
const FORCE_CLOSE = process.argv.includes("--force-close") || !PUBLIC;
const FORCE = process.argv.includes("--force") || !PUBLIC;
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
// Salon de test : 6-7 joueurs fictifs inscrits au J1 (jamais en public)
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");

// Réutilise les salons du jeu Frame (même principe que les autres jeux
// spéciaux, voir CONTRIBUTING.md) plutôt que de provisionner un salon dédié.
const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;

if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

(async () => {
  try {
    const result = await postQuiEstCe(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE, force: FORCE, forceClose: FORCE_CLOSE, pnj: PNJ });

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
          `Si c'était une partie de test oubliée, lance "npm run quiestce:reset" puis relance sur le bon salon.`,
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
    if (result.annulation) {
      console.log(`Effectif minimum non atteint : partie annulée dans ${channelId} (message ${result.message.id}).`);
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
