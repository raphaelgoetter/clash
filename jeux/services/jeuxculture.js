// ============================================================
// jeuxculture.js — Tronc commun aux mini-jeux "de culture" (Frame, Trivia),
// qui alternent une saison sur deux sous le nom collectif
// "Mini-jeux de Culture" : résolution de quel jeu est actif pour une saison
// donnée. Même position que jeuxvisuels.js (pas de planification
// hebdomadaire à dupliquer ici : Frame a toujours eu un créneau fixe unique,
// mercredi 08h UTC — le gating jour/heure reste géré directement par
// jeux/scripts/postJeuxCulture.js, seul consommateur destiné à la production,
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
import { getCurrentSeasonId } from "./saison.js";

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
