// ============================================================
// jeuxculture.js — Groupe 🎬 Ciné-club (Synopsis éclaté, Trouve le film) :
// jeu actif pour une saison donnée (une saison sur deux, paire définie
// dans refonte.js) et suivi partagé de la dernière saison connue. Seul
// consommateur en production : jeux/scripts/postJeuxCulture.js.
// ============================================================

import { Redis } from "@upstash/redis";
import { getCurrentSeasonId } from "./saison.js";
import { getRefonteGame } from "./refonte.js";

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

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Alternance saisonnière ──────────────────────────────────────
// Fonction pure : jeu de la paire actif pour `seasonId` (voir refonte.js),
// null avant la bascule de novembre 2026.
export function getActiveCultureGame(seasonId) {
  return getRefonteGame("culture", seasonId);
}

// ── Suivi de la dernière saison connue ────────────────────────────
// Distinct de l'état propre à chaque jeu (synopsis:state / frame:state) : un
// seul jeu tourne par saison, donc l'état interne du jeu qui vient de
// terminer sa saison ne "voit" la transition suivante que DEUX saisons plus
// tard (la prochaine fois que CE jeu repostera) — trop tard pour un récap de
// fin de saison posté en temps voulu. Ce suivi est donc nécessairement
// partagé et tenu par l'orchestrateur (jeux/scripts/postJeuxCulture.js), pas par
// un jeu individuel.
const LAST_SEASON_KEY = "jeuxculture:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
