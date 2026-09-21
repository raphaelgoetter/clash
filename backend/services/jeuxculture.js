// ============================================================
// jeuxculture.js — Tronc commun aux mini-jeux "de culture" (Frame, Trivia),
// qui alternent une saison Clash Royale sur deux sous le nom collectif
// "Mini-jeux de Culture" : résolution de quel jeu est actif pour une saison
// donnée. Même position que jeuxvisuels.js (pas de planification
// hebdomadaire à dupliquer ici : Frame a toujours eu un créneau fixe unique,
// mercredi 08h UTC — le gating jour/heure reste géré directement par
// scripts/postJeuxCulture.js, seul consommateur destiné à la production,
// remplace .github/workflows/frames.yml).
//
// ⚠️ Ne DUPLIQUE PAS getCurrentSeasonId() : chaque jeu (frames.js, trivia.js)
// garde sa propre copie de cette fonction — convention assumée du repo (voir
// jeuxvisuels.js). Ce module en a néanmoins besoin pour SA PROPRE décision
// (quel jeu est actif), indépendante de celle de chaque jeu.
//
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON, la saison technique
// Clash Royale en cours au moment de la mise en place de l'alternance
// (vérifiée le 2026-09-21 : saison technique 136, comme jeuxvisuels.js —
// coïncidence de calendrier, pas un lien entre les deux alternances).
// Décision produit explicite : Frame termine CETTE saison avant de céder la
// main, jamais une bascule en cours de saison. Parité par rapport à cette
// référence : écart PAIR (0, 2, 4...) → Frame, écart IMPAIR (1, 3, 5...) →
// Trivia. Donc saison 136 = Frame (en cours au moment de la mise en place),
// 137 = Trivia ("la saison prochaine"), 138 = Frame, etc.
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
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "jeuxculture:seasonId",
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
export function getActiveCultureGame(seasonId) {
  const diff = seasonId - ACTIVE_GAME_REFERENCE_SEASON;
  const parity = ((diff % 2) + 2) % 2; // toujours 0 ou 1, même si diff était négatif
  return parity === 0 ? "frame" : "trivia";
}

// ── Suivi de la dernière saison connue ────────────────────────────
// Distinct de l'état propre à chaque jeu (frame:state / trivia:state) : un
// seul jeu tourne par saison, donc l'état interne du jeu qui vient de
// terminer sa saison ne "voit" la transition suivante que DEUX saisons plus
// tard (la prochaine fois que CE jeu repostera) — trop tard pour un récap de
// fin de saison posté en temps voulu. Ce suivi est donc nécessairement
// partagé et tenu par l'orchestrateur (scripts/postJeuxCulture.js), pas par
// un jeu individuel.
const LAST_SEASON_KEY = "jeuxculture:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
