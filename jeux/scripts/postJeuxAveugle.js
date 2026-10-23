#!/usr/bin/env node
// postJeuxAveugle.js
// Point d'entrée UNIQUE en production pour les "Jeux à l'aveugle" (La Juste
// Carte / Blind Royale, en alternance une saison sur deux —
// voir jeux/services/jeuxaveugle.js pour le détail de l'alternance).
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
// jeux/services/jeuxaveugle.js pour le détail de la bascule).
//
// Usage :
//   node jeux/scripts/postJeuxAveugle.js               — poste sur le salon de test
//   node jeux/scripts/postJeuxAveugle.js --public       — poste sur le salon public
//   node jeux/scripts/postJeuxAveugle.js --dry-run      — simulation, sans écrire ni poster
//   node jeux/scripts/postJeuxAveugle.js --force        — ignore le gating jour/anti-double-post
//   node jeux/scripts/postJeuxAveugle.js --no-ping      — poste sans pinger @MINI JEUX

import "../env.js";

import {
  getCurrentSeasonId,
  getActiveBlindGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../services/jeuxaveugle.js";
import { getWiredGame } from "../services/refonte.js";
import { alreadyPostedThisWeek as justeCarteAlreadyPostedThisWeek } from "../services/lajustecarte.js";
import { alreadyPostedThisWeek as blindRoyaleAlreadyPostedThisWeek } from "../services/blindroyale.js";
import { postJusteCarte, postSeasonRecap as postJusteCarteSeasonRecap } from "../discord/handlers/lajustecarte.js";
import { postBlindRoyale, postSeasonRecap as postBlindRoyaleSeasonRecap } from "../discord/handlers/blindroyale.js";
import { alreadyPostedThisWeek as triviaGeekAlreadyPostedThisWeek } from "../services/triviageek.js";
import { postTriviaGeek, postSeasonRecap as postTriviaGeekSeasonRecap } from "../discord/handlers/triviageek.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = {
  lajustecarte: justeCarteAlreadyPostedThisWeek,
  blindroyale: blindRoyaleAlreadyPostedThisWeek,
  triviageek: triviaGeekAlreadyPostedThisWeek,
};
const POST_BY_GAME = { lajustecarte: postJusteCarte, blindroyale: postBlindRoyale, triviageek: postTriviaGeek };
const RECAP_BY_GAME = {
  lajustecarte: postJusteCarteSeasonRecap,
  blindroyale: postBlindRoyaleSeasonRecap,
  triviageek: postTriviaGeekSeasonRecap,
};
const LABEL_BY_GAME = { lajustecarte: "La Juste Carte", blindroyale: "Blind Royale", triviageek: "Trivia Geek" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison en cours.");
    const activeGame = getActiveBlindGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveBlindGame(lastKnown);
        const recapFn = getWiredGame("aveugle", lastKnown, endedGame) && RECAP_BY_GAME[endedGame];
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
    if (!getWiredGame("aveugle", currentSeasonId, activeGame) || !POST_BY_GAME[activeGame]) {
      throw new Error(`jeu « ${activeGame} » actif pour la saison ${currentSeasonId}, mais pas encore prêt.`);
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
