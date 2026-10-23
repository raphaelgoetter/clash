#!/usr/bin/env node
// postJeuxVisuels.js
// Point d'entrée UNIQUE en production pour les "Jeux visuels" (Zoom carte /
// Palette, en alternance une saison sur deux — voir
// jeux/services/jeuxvisuels.js pour le détail de l'alternance). Remplace
// l'ancien cron dédié à Zoom seul (.github/workflows/zoom.yml) :
//
//   1. Détecte un changement de saison depuis le dernier passage (suivi
//      PARTAGÉ, indépendant de l'état interne de chaque jeu — voir
//      getLastKnownSeasonId/setLastKnownSeasonId) et poste le récap de fin
//      de saison du jeu qui vient de se terminer, quel qu'il soit — sans ce
//      suivi partagé, le jeu qui reprend la main ne "verrait" la transition
//      que 2 saisons plus tard (la prochaine fois que LUI repostera).
//   2. Délègue la publication de la nouvelle manche au jeu actif de la
//      saison en cours, avec force:true (le gating jour a déjà été fait
//      ici) et skipSeasonRecap:true pour Zoom (sinon son propre mécanisme
//      interne de récap, comparé à SON état à lui, redéclencherait à tort
//      un récap déjà posté à l'étape 1 — sans effet pour Palette, qui n'a
//      aucune logique de récap interne).
//
// Contrairement à postJeuxDeLettres.js (Anagram/Pêle-mêle, samedi, 2
// créneaux aléatoires), pas de planification multi-créneaux ici : Zoom a
// toujours eu un créneau fixe unique (vendredi 18h UTC), simple gating jour.
//
// Usage :
//   node jeux/scripts/postJeuxVisuels.js               — poste sur le salon de test
//   node jeux/scripts/postJeuxVisuels.js --public       — poste sur le salon public
//   node jeux/scripts/postJeuxVisuels.js --dry-run      — simulation, sans écrire ni poster
//   node jeux/scripts/postJeuxVisuels.js --force        — ignore le gating jour/anti-double-post
//   node jeux/scripts/postJeuxVisuels.js --no-ping      — poste sans pinger @MINI-JEUX

import "../env.js";

import {
  getCurrentSeasonId,
  getActiveVisualGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../services/jeuxvisuels.js";
import { getWiredGame } from "../services/refonte.js";
import { alreadyPostedThisWeek as zoomAlreadyPostedThisWeek } from "../services/zoom.js";
import { alreadyPostedThisWeek as paletteAlreadyPostedThisWeek } from "../services/palette.js";
import { postZoom, postSeasonRecap as postZoomSeasonRecap } from "../discord/handlers/zoom.js";
import { postPalette, postSeasonRecap as postPaletteSeasonRecap } from "../discord/handlers/palette.js";
import { alreadyPostedThisWeek as zoom2AlreadyPostedThisWeek } from "../services/zoom2.js";
import { postZoom2, postSeasonRecap as postZoom2SeasonRecap } from "../discord/handlers/zoom2.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { zoom: zoomAlreadyPostedThisWeek, palette: paletteAlreadyPostedThisWeek, zoom2: zoom2AlreadyPostedThisWeek };
const POST_BY_GAME = { zoom: postZoom, palette: postPalette, zoom2: postZoom2 };
const RECAP_BY_GAME = { zoom: postZoomSeasonRecap, palette: postPaletteSeasonRecap, zoom2: postZoom2SeasonRecap };
const LABEL_BY_GAME = { zoom: "Zoom carte", palette: "Palette", zoom2: "Zoom logo" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison en cours.");
    const activeGame = getActiveVisualGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveVisualGame(lastKnown);
        const recapFn = getWiredGame("visuels", lastKnown, endedGame) && RECAP_BY_GAME[endedGame];
        if (recapFn) {
          console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
          await recapFn(channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
        } else {
          console.warn(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — pas de récap : jeu « ${endedGame} » pas prêt.`);
        }
      }
      await setLastKnownSeasonId(currentSeasonId);
    }

    // Refonte : un jeu de la nouvelle paire pas encore prêt n'est jamais
    // lancé (voir REFONTE_PRETS, jeux/services/refonte.js) ; le récap
    // ci-dessus reste posté.
    if (!getWiredGame("visuels", currentSeasonId, activeGame) || !POST_BY_GAME[activeGame]) {
      throw new Error(`jeu « ${activeGame} » actif pour la saison ${currentSeasonId}, mais pas encore prêt.`);
    }

    if (!FORCE && !DRY_RUN) {
      const now = new Date();
      if (now.getUTCDay() !== 5) {
        console.log("Pas de publication cette fois-ci — raison : not-friday");
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
    console.error("Échec de la publication Jeux visuels :", err.message);
    process.exit(1);
  }
})();
