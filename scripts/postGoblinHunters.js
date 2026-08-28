#!/usr/bin/env node
// postGoblinHunters.js
// Poste manuellement (ou via cron) l'étape courante de Goblin Hunters (jeu à
// identité secrète/camps cachés). Selon la phase : ouvre/rappelle la
// fenêtre d'inscription, lance la partie (attribution des camps/rôles),
// clôture le jour actif (résout combat/vote/enquêtes) puis publie le jour
// suivant ou le message de fin de partie.
//
// Usage :
//   node scripts/postGoblinHunters.js                — poste sur le salon de test
//   node scripts/postGoblinHunters.js --public        — poste sur le salon public
//   node scripts/postGoblinHunters.js --dry-run       — simulation, sans écrire ni poster
//   node scripts/postGoblinHunters.js --public --dry-run
//   node scripts/postGoblinHunters.js --no-ping       — poste sans pinger @MINI JEUX (inscription/lancement/fin uniquement)
//   node scripts/postGoblinHunters.js --require-active — ne fait rien si aucune partie n'est déjà lancée (cron)
//   node scripts/postGoblinHunters.js --force-close   — TESTS UNIQUEMENT : ignore l'échéance réelle de la fenêtre
//                                                        d'inscription (3 jours) pour déclencher le lancement immédiatement
//   node scripts/postGoblinHunters.js --force         — ignore le garde-fou anti-double-avancée (jour tout juste ouvert)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { postGoblinHunters } from "../api/discord/_handlers/goblinhunters.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
// Réservé au cron quotidien (voir .github/workflows/goblinhunters.yml) : la
// fenêtre d'inscription doit toujours être ouverte manuellement
// (workflow_dispatch), le cron ne fait qu'avancer une partie déjà en cours.
const REQUIRE_ACTIVE = process.argv.includes("--require-active");
const FORCE_CLOSE = process.argv.includes("--force-close");
// Contourne le garde-fou anti-double-avancée (voir backend/services/goblinhunters.js,
// isTooSoonSinceLastClosure) — utile en test pour clôturer plusieurs jours
// d'affilée sans attendre MIN_HOURS_BETWEEN_CLOSURES entre chaque appel.
// Distinct de --force-close (qui ignore la date limite d'inscription).
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

// Réutilise les salons du jeu Frame (même principe qu'Anagram/Boss Raid/
// Robinson) plutôt que de provisionner de nouveaux salons dédiés.
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
    const result = await postGoblinHunters(channelId, {
      dryRun: DRY_RUN,
      noPing: NO_PING,
      isPublic: PUBLIC,
      requireActiveState: REQUIRE_ACTIVE,
      forceClose: FORCE_CLOSE,
      force: FORCE,
    });

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
          `Si c'était une partie de test oubliée, lance "npm run goblinhunters:reset" puis relance sur le bon salon.`,
      );
      process.exit(1);
    }

    if (result.termine) {
      console.log("Partie déjà terminée, rien à poster.");
      return;
    }

    if (DRY_RUN) {
      console.log(`DRY-RUN — (salon ${channelId}) :`);
      if (result.final) {
        console.log("  Fin de partie.");
      } else if (result.phase === "inscription") {
        console.log(result.report ? "  Fenêtre d'inscription prolongée." : "  Fenêtre d'inscription.");
      } else if (result.phase === "lancement") {
        console.log(`  Lancement de la partie (${result.joueursCount} inscrits) :`);
        for (const j of result.joueurs || []) {
          console.log(`    ${j.username} — ${j.camp}${j.role ? ` (${j.role})` : ""}`);
        }
      } else {
        console.log(`  Jour ${result.jour}.`);
      }
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components || [] }, null, 2));
      return;
    }

    if (result.final) {
      console.log(`Fin de partie postée dans ${channelId} (message ${result.message.id}).`);
      return;
    }

    console.log(`Étape postée dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication :", err.message);
    process.exit(1);
  }
})();
