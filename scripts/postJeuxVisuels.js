#!/usr/bin/env node
// postJeuxVisuels.js
// Point d'entrée UNIQUE en production pour les "Jeux visuels" (Zoom carte /
// Palette, en alternance une saison Clash Royale sur deux — voir
// backend/services/jeuxvisuels.js pour le détail de l'alternance). Remplace
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
//   node scripts/postJeuxVisuels.js               — poste sur le salon de test
//   node scripts/postJeuxVisuels.js --public       — poste sur le salon public
//   node scripts/postJeuxVisuels.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postJeuxVisuels.js --force        — ignore le gating jour/anti-double-post
//   node scripts/postJeuxVisuels.js --no-ping      — poste sans pinger @MINI-JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  getCurrentSeasonId,
  getActiveVisualGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../backend/services/jeuxvisuels.js";
import { alreadyPostedThisWeek as zoomAlreadyPostedThisWeek } from "../backend/services/zoom.js";
import { alreadyPostedThisWeek as paletteAlreadyPostedThisWeek } from "../backend/services/palette.js";
import { postZoom, postSeasonRecap as postZoomSeasonRecap } from "../api/discord/_handlers/zoom.js";
import { postPalette, postSeasonRecap as postPaletteSeasonRecap } from "../api/discord/_handlers/palette.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { zoom: zoomAlreadyPostedThisWeek, palette: paletteAlreadyPostedThisWeek };
const POST_BY_GAME = { zoom: postZoom, palette: postPalette };
const RECAP_BY_GAME = { zoom: postZoomSeasonRecap, palette: postPaletteSeasonRecap };
const LABEL_BY_GAME = { zoom: "Zoom carte", palette: "Palette" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison Clash Royale en cours.");
    const activeGame = getActiveVisualGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveVisualGame(lastKnown);
        console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
        await RECAP_BY_GAME[endedGame](channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
      }
      await setLastKnownSeasonId(currentSeasonId);
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
