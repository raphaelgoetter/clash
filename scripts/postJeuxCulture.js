#!/usr/bin/env node
// postJeuxCulture.js
// Point d'entrée UNIQUE en production pour les "Mini-jeux de Culture" (Frame
// / Trivia, en alternance une saison Clash Royale sur deux — voir
// backend/services/jeuxculture.js pour le détail de l'alternance). Remplace
// l'ancien cron dédié à Frame seul (.github/workflows/frames.yml) :
//
//   1. Détecte un changement de saison depuis le dernier passage (suivi
//      PARTAGÉ, indépendant de l'état interne de chaque jeu — voir
//      getLastKnownSeasonId/setLastKnownSeasonId) et poste le récap de fin
//      de saison du jeu qui vient de se terminer, quel qu'il soit — sans ce
//      suivi partagé, le jeu qui reprend la main ne "verrait" la transition
//      que 2 saisons plus tard (la prochaine fois que LUI repostera).
//   2. Délègue la publication de la nouvelle manche au jeu actif de la
//      saison en cours, avec force:true (le gating jour a déjà été fait
//      ici) et skipSeasonRecap:true pour Frame (sinon son propre mécanisme
//      interne de récap, comparé à SON état à lui, redéclencherait à tort
//      un récap déjà posté à l'étape 1 — sans effet pour Trivia, qui n'a
//      aucune logique de récap interne).
//
// Contrairement à postJeuxDeLettres.js (Anagram/Pêle-mêle, samedi, 2
// créneaux aléatoires), pas de planification multi-créneaux ici : Frame a
// toujours eu un créneau fixe unique (mercredi 08h UTC), simple gating jour.
//
// Usage :
//   node scripts/postJeuxCulture.js               — poste sur le salon de test
//   node scripts/postJeuxCulture.js --public       — poste sur le salon public
//   node scripts/postJeuxCulture.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postJeuxCulture.js --force        — ignore le gating jour/anti-double-post
//   node scripts/postJeuxCulture.js --no-ping      — poste sans pinger @MINI-JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  getCurrentSeasonId,
  getActiveCultureGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../backend/services/jeuxculture.js";
import { alreadyPostedThisWeek as frameAlreadyPostedThisWeek } from "../backend/services/frames.js";
import { alreadyPostedThisWeek as triviaAlreadyPostedThisWeek } from "../backend/services/trivia.js";
import { postFrame, postSeasonRecap as postFrameSeasonRecap } from "../api/discord/_handlers/frames.js";
import { postTrivia, postSeasonRecap as postTriviaSeasonRecap } from "../api/discord/_handlers/trivia.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { frame: frameAlreadyPostedThisWeek, trivia: triviaAlreadyPostedThisWeek };
const POST_BY_GAME = { frame: postFrame, trivia: postTrivia };
const RECAP_BY_GAME = { frame: postFrameSeasonRecap, trivia: postTriviaSeasonRecap };
const LABEL_BY_GAME = { frame: "Frame", trivia: "Trivia" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison Clash Royale en cours.");
    const activeGame = getActiveCultureGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveCultureGame(lastKnown);
        console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
        await RECAP_BY_GAME[endedGame](channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
      }
      await setLastKnownSeasonId(currentSeasonId);
    }

    if (!FORCE && !DRY_RUN) {
      const now = new Date();
      if (now.getUTCDay() !== 3) {
        console.log("Pas de publication cette fois-ci — raison : not-wednesday");
        return;
      }
      if (await ALREADY_POSTED_BY_GAME[activeGame](now)) {
        console.log("Pas de publication cette fois-ci — raison : already-posted-this-week");
        return;
      }
    }

    console.log(`Jeu actif pour la saison ${currentSeasonId} : ${LABEL_BY_GAME[activeGame]}.`);
    const postFn = POST_BY_GAME[activeGame];
    const result = await postFn(channelId, { dryRun: DRY_RUN, force: true, noPing: NO_PING, skipSeasonRecap: true });

    if (DRY_RUN) {
      console.log(`DRY-RUN — prochaine manche (${LABEL_BY_GAME[activeGame]}, salon ${channelId}) :`);
      console.log(JSON.stringify({ embeds: [result.embed], components: result.components }, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`Pas de publication cette fois-ci — raison : ${result.reason}`);
      return;
    }

    console.log(`Manche ${LABEL_BY_GAME[activeGame]} postée dans ${channelId} (message ${result.message.id}).`);
  } catch (err) {
    console.error("Échec de la publication Jeux de culture :", err.message);
    process.exit(1);
  }
})();
