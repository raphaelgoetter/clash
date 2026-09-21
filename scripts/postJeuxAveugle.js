#!/usr/bin/env node
// postJeuxAveugle.js
// Point d'entrée UNIQUE en production pour les "Jeux à l'aveugle" (La Juste
// Carte / Blind Royale, en alternance une saison Clash Royale sur deux —
// voir backend/services/jeuxaveugle.js pour le détail de l'alternance).
// Remplace les deux crons dédiés (.github/workflows/lajustecarte.yml et
// blindroyale.yml, supprimés) :
//
//   1. Détecte un changement de saison depuis le dernier passage (suivi
//      PARTAGÉ, indépendant de l'état interne de chaque jeu — voir
//      getLastKnownSeasonId/setLastKnownSeasonId) et poste le récap de fin
//      de saison du jeu qui vient de se terminer, quel qu'il soit — sans ce
//      suivi partagé, le jeu qui reprend la main ne "verrait" la transition
//      que 2 saisons plus tard (la prochaine fois que LUI repostera).
//   2. Délègue la publication de la nouvelle manche au jeu actif de la
//      saison en cours, avec force:true (le gating jour a déjà été fait
//      ici) et skipSeasonRecap:true (sinon le mécanisme interne de récap de
//      chaque jeu, comparé à SON état à lui, redéclencherait à tort un
//      récap déjà posté à l'étape 1).
//
// Jour unique retenu : LUNDI 18h UTC (créneau déjà utilisé par Blind
// Royale) — La Juste Carte tournait jusqu'ici le dimanche, elle migrera sur
// ce créneau la première fois qu'elle reprendra la main (voir
// backend/services/jeuxaveugle.js pour le détail de la bascule).
//
// Usage :
//   node scripts/postJeuxAveugle.js               — poste sur le salon de test
//   node scripts/postJeuxAveugle.js --public       — poste sur le salon public
//   node scripts/postJeuxAveugle.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postJeuxAveugle.js --force        — ignore le gating jour/anti-double-post
//   node scripts/postJeuxAveugle.js --no-ping      — poste sans pinger @MINI JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  getCurrentSeasonId,
  getActiveBlindGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../backend/services/jeuxaveugle.js";
import { alreadyPostedThisWeek as justeCarteAlreadyPostedThisWeek } from "../backend/services/lajustecarte.js";
import { alreadyPostedThisWeek as blindRoyaleAlreadyPostedThisWeek } from "../backend/services/blindroyale.js";
import { postJusteCarte, postSeasonRecap as postJusteCarteSeasonRecap } from "../api/discord/_handlers/lajustecarte.js";
import { postBlindRoyale, postSeasonRecap as postBlindRoyaleSeasonRecap } from "../api/discord/_handlers/blindroyale.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { lajustecarte: justeCarteAlreadyPostedThisWeek, blindroyale: blindRoyaleAlreadyPostedThisWeek };
const POST_BY_GAME = { lajustecarte: postJusteCarte, blindroyale: postBlindRoyale };
const RECAP_BY_GAME = { lajustecarte: postJusteCarteSeasonRecap, blindroyale: postBlindRoyaleSeasonRecap };
const LABEL_BY_GAME = { lajustecarte: "La Juste Carte", blindroyale: "Blind Royale" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison Clash Royale en cours.");
    const activeGame = getActiveBlindGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveBlindGame(lastKnown);
        console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
        await RECAP_BY_GAME[endedGame](channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
      }
      await setLastKnownSeasonId(currentSeasonId);
    }

    if (!FORCE && !DRY_RUN) {
      const now = new Date();
      if (now.getUTCDay() !== 1) {
        console.log("Pas de publication cette fois-ci — raison : not-monday");
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
    console.error("Échec de la publication Jeux à l'aveugle :", err.message);
    process.exit(1);
  }
})();
