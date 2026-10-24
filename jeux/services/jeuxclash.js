// ============================================================
// jeuxclash.js — Tronc commun du groupe « Clash » (Trivia / Zoom carte),
// créé par la refonte (voir refonte.js) pour garder un rendez-vous Clash
// Royale : rien avant sa saison de bascule (138, novembre 2026), puis
// alternance une saison sur deux, le MARDI 18h UTC.
// jeux/scripts/postJeuxClash.js est le seul consommateur destiné à la
// production.
//
// Trivia et Zoom carte tournaient auparavant dans d'autres groupes
// (culture le mercredi, visuels le vendredi) : leur jour de publication
// dépend donc de la saison (voir publicationWeekday), pour que la fin de
// leur ancienne alternance reste inchangée.
// ============================================================

import { Redis } from "@upstash/redis";
import { getCurrentSeasonId } from "./saison.js";
import { getRefonteGame, isRefonteSeason } from "./refonte.js";

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

export { getCurrentSeasonId };

export const CLASH_WEEKDAY = 2; // mardi
export const CLASH_JOUR = "mardi";

// Fonction pure : jeu actif pour `seasonId`, null avant la bascule (pas
// d'ancienne paire).
export function getActiveClashGame(seasonId) {
  return getRefonteGame("clash", seasonId);
}

/** Jour UTC de publication d'un jeu du groupe : `avant` (ancien groupe) jusqu'à la bascule, mardi ensuite. */
export function publicationWeekday(seasonId, avant) {
  return isRefonteSeason("clash", seasonId) ? CLASH_WEEKDAY : avant;
}

// ── Suivi de la dernière saison connue (voir jeuxaveugle.js) ──────
const LAST_SEASON_KEY = "jeuxclash:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
