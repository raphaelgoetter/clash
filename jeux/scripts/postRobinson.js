#!/usr/bin/env node
// postRobinson.js
// Poste manuellement (ou via cron) le jour de Robinson (survie
// collaborative). Sans partie en cours : publie le jour de présentation
// (jamais le Jour 1 directement). Sinon résout la nuit du jour actif
// (récoltes, repas, départ du Radeau à l'aube), puis publie le jour suivant
// ou le message de fin de partie.
//
// Usage :
//   node jeux/scripts/postRobinson.js                — poste sur le salon de test
//   node jeux/scripts/postRobinson.js --public        — poste sur le salon public
//   node jeux/scripts/postRobinson.js --dry-run       — simulation, sans écrire ni poster
//   node jeux/scripts/postRobinson.js --public --dry-run
//   node jeux/scripts/postRobinson.js --no-ping       — poste sans pinger @MINI JEUX
//   node jeux/scripts/postRobinson.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node jeux/scripts/postRobinson.js --force          — ignore le garde-fou anti-double-avancée (jour tout juste ouvert)
//   node jeux/scripts/postRobinson.js --sans-pnj       — salon de test sans les 5 joueurs fictifs (PNJ)

import "../env.js";

import { postRobinson } from "../discord/handlers/robinson.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Réservé au cron quotidien (voir .github/workflows/robinson.yml) : le
// lancement (jour de présentation, la veille du Jour 1) doit toujours être
// déclenché manuellement (workflow_dispatch), le cron ne fait qu'avancer une
// partie déjà lancée (annonce comprise).
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
// Contourne le garde-fou anti-double-avancée (voir jeux/services/robinson.js,
// isTooSoonSinceLastClosure) — protège uniquement le salon public contre un
// cron en retard après une relance manuelle (le cron ne cible jamais le
// salon de test). Sur le salon de test, aucun cron ne peut jamais entrer en
// conflit : le garde-fou n'y sert à rien d'autre qu'à ralentir l'itération
// manuelle, donc contourné automatiquement.
const FORCE = process.argv.includes("--force") || !PUBLIC;
// Ping @MINI JEUX réservé au vrai lancement public (annonce) et à la fin —
// jamais sur le salon de test, même sans --no-ping explicite, pour ne pas déranger le
// serveur à chaque itération de test pendant le développement du jeu.
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;
// Salon de test : 5 PNJ jouent chaque jour (jamais sur le salon public)
const PNJ = !PUBLIC && !process.argv.includes("--sans-pnj");

// Réutilise les salons du jeu Frame (même principe qu'Anagram/Tamagoshi,
// voir jeux/CONTRIBUTING.md) plutôt que de provisionner de nouveaux salons
// Discord dédiés à Robinson.
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
    const result = await postRobinson(channelId, { dryRun: DRY_RUN, noPing: NO_PING, isPublic: PUBLIC, requireActiveState: REQUIRE_ACTIVE, force: FORCE, pnj: PNJ });

    if (result.skipped) {
      if (result.reason === "tooSoonSinceLastClosure") {
        console.log(
          `Jour ouvert trop récemment (${result.publishedAt}) pour être re-clôturé — probable double déclenchement ` +
            `(cron en retard + relance manuelle, ou double cron). Rien n'est posté. Utilise --force si ce rattrapage est volontaire.`,
        );
      } else {
        console.log("Aucune partie active, rien à poster (cron sans lancement manuel préalable).");
      }
      return;
    }

    if (result.wrongChannel) {
      console.error(
        `Une partie est déjà active sur un AUTRE salon (${result.activeChannelId}) — rien n'est posté ici pour éviter tout mélange. ` +
          `Si c'était une partie de test oubliée, lance "npm run robinson:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }

    if (result.termine) {
      console.log("Partie déjà terminée, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.phase === "annonce") {
        console.log("  Jour de présentation (annonce, veille du Jour 1)");
      } else if (result.final) {
        console.log(`  Fin de partie : ${result.outcome}${result.cause ? ` (${result.cause})` : ""}`);
      } else {
        console.log(`  Jour ${result.jour}`);
      }
      console.log(JSON.stringify({ embeds: result.embeds, components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }

    console.log(`${result.jour == null ? "Jour de présentation" : `Jour ${result.jour}`} posté dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication du jour :", err.message);
    process.exit(1);
  }
})();
