#!/usr/bin/env node
// postJeuxClash.js
// Point d'entrée UNIQUE en production pour le groupe « Clash » (Trivia /
// Zoom carte, en alternance une saison sur deux à partir de la refonte —
// voir jeux/services/jeuxclash.js). Même déroulé que postJeuxAveugle.js :
//
//   1. Changement de saison détecté via le suivi partagé
//      (jeuxclash:last_season_id) → récap de fin de saison du jeu qui
//      vient de se terminer.
//   2. Délégation de la nouvelle manche au jeu actif, avec force:true (le
//      gating jour est fait ici) et skipSeasonRecap:true.
//
// Avant la saison de bascule (REFONTE_SEASON.clash), aucun jeu : le script
// sort sans rien poster ni écrire (Trivia et Zoom carte tournent encore dans
// leurs anciens groupes).
//
// Jour : MARDI 18h UTC.
//
// Usage :
//   node jeux/scripts/postJeuxClash.js               — poste sur le salon de test
//   node jeux/scripts/postJeuxClash.js --public       — poste sur le salon public
//   node jeux/scripts/postJeuxClash.js --dry-run      — simulation, sans écrire ni poster
//   node jeux/scripts/postJeuxClash.js --force        — ignore le gating jour/anti-double-post
//   node jeux/scripts/postJeuxClash.js --no-ping      — poste sans pinger @MINI-JEUX

import "../env.js";

import {
  CLASH_WEEKDAY,
  getCurrentSeasonId,
  getActiveClashGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../services/jeuxclash.js";
import { REFONTE_SEASON, getWiredGame } from "../services/refonte.js";
import { alreadyPostedThisWeek as triviaAlreadyPostedThisWeek } from "../services/trivia.js";
import { alreadyPostedThisWeek as zoomAlreadyPostedThisWeek } from "../services/zoom.js";
import { postTrivia, postSeasonRecap as postTriviaSeasonRecap } from "../discord/handlers/trivia.js";
import { postZoom, postSeasonRecap as postZoomSeasonRecap } from "../discord/handlers/zoom.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { trivia: triviaAlreadyPostedThisWeek, zoom: zoomAlreadyPostedThisWeek };
const POST_BY_GAME = { trivia: postTrivia, zoom: postZoom };
const RECAP_BY_GAME = { trivia: postTriviaSeasonRecap, zoom: postZoomSeasonRecap };
const LABEL_BY_GAME = { trivia: "Trivia", zoom: "Zoom carte" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison en cours.");
    const activeGame = getActiveClashGame(currentSeasonId);

    if (!activeGame) {
      console.log(`Pas de publication cette fois-ci — raison : groupe Clash ouvert à partir de la saison ${REFONTE_SEASON.clash} (saison en cours : ${currentSeasonId}).`);
      return;
    }

    // Récap de fin de saison — jamais en dry-run (aucune écriture Redis).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveClashGame(lastKnown);
        const recapFn = endedGame && getWiredGame("clash", lastKnown, endedGame) && RECAP_BY_GAME[endedGame];
        if (recapFn) {
          console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
          await recapFn(channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
        } else {
          console.warn(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — pas de récap : jeu « ${endedGame} » pas prêt.`);
        }
      }
      await setLastKnownSeasonId(currentSeasonId);
    }

    if (!getWiredGame("clash", currentSeasonId, activeGame) || !POST_BY_GAME[activeGame]) {
      throw new Error(`jeu « ${activeGame} » actif pour la saison ${currentSeasonId}, mais pas encore prêt.`);
    }

    if (!FORCE && !DRY_RUN) {
      const now = new Date();
      if (now.getUTCDay() !== CLASH_WEEKDAY) {
        console.log("Pas de publication cette fois-ci — raison : not-tuesday");
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
    console.error("Échec de la publication Jeux Clash :", err.message);
    process.exit(1);
  }
})();
