#!/usr/bin/env node
// postJeuxDeLettres.js
// Point d'entrée UNIQUE en production pour les "Jeux de lettres" (Anagram /
// Pêle-mêle, en alternance une saison Clash Royale sur deux — voir
// backend/services/jeuxdelettres.js pour le détail de l'alternance).
// Remplace l'ancien cron dédié à Anagram seul (.github/workflows/anagrams.yml) :
//
//   1. Décide UNE SEULE FOIS le jour/créneau (samedi, tirage 10h/18h) —
//      les deux jeux partagent ce mécanisme (backend/services/jeuxdelettres.js),
//      copié à l'identique de l'ancien mécanisme d'Anagram.
//   2. Détecte un changement de saison depuis le dernier passage (suivi
//      PARTAGÉ, indépendant de l'état interne de chaque jeu — voir
//      getLastKnownSeasonId/setLastKnownSeasonId) et poste le récap de fin
//      de saison du jeu qui vient de se terminer, quel qu'il soit — sans ce
//      suivi partagé, le jeu qui reprend la main ne "verrait" la transition
//      que 2 saisons plus tard (la prochaine fois que LUI repostera).
//   3. Délègue la publication de la nouvelle manche au jeu actif de la
//      saison en cours, avec force:true (le gating jour/créneau a déjà été
//      fait ici) et skipSeasonRecap:true pour Anagram (sinon son propre
//      mécanisme interne de récap, comparé à SON état à lui, redéclencherait
//      à tort un récap déjà posté à l'étape 2).
//
// Usage :
//   node scripts/postJeuxDeLettres.js               — poste sur le salon de test
//   node scripts/postJeuxDeLettres.js --public       — poste sur le salon public
//   node scripts/postJeuxDeLettres.js --dry-run      — simulation, sans écrire ni poster
//   node scripts/postJeuxDeLettres.js --force        — ignore le gating jour/créneau
//   node scripts/postJeuxDeLettres.js --no-ping      — poste sans pinger @MINI JEUX

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  getCurrentSeasonId,
  computeWeeklySlotIndex,
  shouldPostThisSlot,
  getActiveLetterGame,
  getLastKnownSeasonId,
  setLastKnownSeasonId,
} from "../backend/services/jeuxdelettres.js";
import { alreadyPostedThisWeek as anagramAlreadyPostedThisWeek } from "../backend/services/anagrams.js";
import { alreadyPostedThisWeek as pelemeleAlreadyPostedThisWeek } from "../backend/services/pelemele.js";
import { postAnagram, postSeasonRecap as postAnagramSeasonRecap } from "../api/discord/_handlers/anagrams.js";
import { postPeleMele, postSeasonRecap as postPeleMeleSeasonRecap } from "../api/discord/_handlers/pelemele.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping") || !PUBLIC;

const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const ALREADY_POSTED_BY_GAME = { anagram: anagramAlreadyPostedThisWeek, pelemele: pelemeleAlreadyPostedThisWeek };
const POST_BY_GAME = { anagram: postAnagram, pelemele: postPeleMele };
const RECAP_BY_GAME = { anagram: postAnagramSeasonRecap, pelemele: postPeleMeleSeasonRecap };
const LABEL_BY_GAME = { anagram: "Anagram", pelemele: "Pêle-mêle" };

(async () => {
  try {
    const currentSeasonId = await getCurrentSeasonId();
    if (currentSeasonId == null) throw new Error("Impossible de déterminer la saison Clash Royale en cours.");
    const activeGame = getActiveLetterGame(currentSeasonId);

    // Récap de fin de saison — jamais en dry-run (lecture seule stricte,
    // comme les autres jeux : aucune écriture Redis, y compris le suivi de
    // dernière saison connue, tant qu'on est en simulation).
    if (!DRY_RUN) {
      const lastKnown = await getLastKnownSeasonId();
      if (lastKnown != null && lastKnown !== currentSeasonId) {
        const endedGame = getActiveLetterGame(lastKnown);
        console.log(`Changement de saison détecté (${lastKnown} -> ${currentSeasonId}) — récap de fin de saison pour ${LABEL_BY_GAME[endedGame]}.`);
        await RECAP_BY_GAME[endedGame](channelId, lastKnown, currentSeasonId, { noPing: NO_PING });
      }
      await setLastKnownSeasonId(currentSeasonId);
    }

    if (!FORCE && !DRY_RUN) {
      const now = new Date();
      if (now.getUTCDay() !== 6) {
        console.log("Pas de publication cette fois-ci — raison : not-saturday");
        return;
      }
      if (await ALREADY_POSTED_BY_GAME[activeGame](now)) {
        console.log("Pas de publication cette fois-ci — raison : already-posted-this-week");
        return;
      }
      const slotIndex = computeWeeklySlotIndex(now);
      if (!shouldPostThisSlot(slotIndex)) {
        console.log(`Pas de publication cette fois-ci — raison : not-selected-slot-${slotIndex}`);
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
    console.error("Échec de la publication Jeux de lettres :", err.message);
    process.exit(1);
  }
})();
