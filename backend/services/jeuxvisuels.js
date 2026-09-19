// ============================================================
// jeuxvisuels.js — Tronc commun aux mini-jeux "visuels" (Zoom carte,
// Palette), qui alternent désormais une saison Clash Royale sur deux sous
// le nom collectif "Jeux visuels" : résolution de quel jeu est actif pour
// une saison donnée. Contrairement à jeuxdelettres.js, pas de planification
// hebdomadaire à dupliquer ici : Zoom a toujours eu un créneau fixe unique
// (vendredi 18h UTC), pas l'historique multi-créneaux d'Anagram — le
// gating jour/heure reste géré directement par scripts/postJeuxVisuels.js.
// scripts/postJeuxVisuels.js est le seul consommateur destiné à la
// production (cron unique, remplace .github/workflows/zoom.yml).
//
// ⚠️ Ne DUPLIQUE PAS getCurrentSeasonId() : chaque jeu (zoom.js, palette.js,
// frames.js, anagrams.js, pelemele.js, lajustecarte.js, blindroyale.js)
// garde sa propre copie de cette fonction — convention assumée du repo (voir
// jeuxdelettres.js). Ce module en a néanmoins besoin pour SA PROPRE décision
// (quel jeu est actif), indépendante de celle de chaque jeu.
//
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON, la saison technique
// Clash Royale en cours au moment de la mise en place de l'alternance
// (vérifiée le 2026-09-19 : saison technique 136, Saison publique 87 via
// toPublicSeasonId — la même saison de référence que jeuxdelettres.js,
// coïncidence de calendrier, pas un lien entre les deux alternances).
// Décision produit explicite : Zoom termine CETTE saison avant de céder la
// main, jamais une bascule en cours de saison. Parité par rapport à cette
// référence : écart PAIR (0, 2, 4...) → Zoom, écart IMPAIR (1, 3, 5...) →
// Palette. Donc saison 136 = Zoom (en cours au moment de la mise en place),
// 137 = Palette ("la saison prochaine"), 138 = Zoom, etc.
// ============================================================

import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";

let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      automaticDeserialization: false,
    });
  }
  return _redis;
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Copie assumée (voir en-tête de fichier) — même fonction 100% générique
// que dans chaque jeu individuel, juste utilisée ici pour la décision
// d'alternance elle-même (scripts/postJeuxVisuels.js), pas pour l'état
// interne d'un jeu précis.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "jeuxvisuels:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      for (const delay of [0, 1000, 3000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const raceLog = await fetchRaceLog(clanTag).catch(() => null);
        const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
        const seasonId = computeCurrentSeasonId(currentRace, raceLog);
        if (seasonId != null) return seasonId;
      }
      return null;
    },
    15 * 60 * 1000,
  );
  return value;
}

// ── Alternance saisonnière ──────────────────────────────────────
export const ACTIVE_GAME_REFERENCE_SEASON = 136;

// Fonction pure, testable indépendamment de Redis.
export function getActiveVisualGame(seasonId) {
  const diff = seasonId - ACTIVE_GAME_REFERENCE_SEASON;
  const parity = ((diff % 2) + 2) % 2; // toujours 0 ou 1, même si diff était négatif
  return parity === 0 ? "zoom" : "palette";
}

// ── Suivi de la dernière saison connue ────────────────────────────
// Distinct de l'état propre à chaque jeu (zoom:state / palette:state) : un
// seul jeu tourne par saison, donc l'état interne du jeu qui vient de
// terminer sa saison ne "voit" la transition suivante que DEUX saisons plus
// tard (la prochaine fois que CE jeu repostera) — trop tard pour un récap de
// fin de saison posté en temps voulu. Ce suivi est donc nécessairement
// partagé et tenu par l'orchestrateur (scripts/postJeuxVisuels.js), pas par
// un jeu individuel.
const LAST_SEASON_KEY = "jeuxvisuels:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
