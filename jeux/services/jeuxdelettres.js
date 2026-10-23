// ============================================================
// jeuxdelettres.js — Tronc commun aux mini-jeux "de lettres" (Anagram,
// Pêle-mêle), qui alternent désormais une saison sur deux sous
// le nom collectif "Jeux de lettres" (créneau unique samedi 18h UTC) :
// résolution de quel jeu est actif pour une saison donnée. jeux/scripts/postJeuxDeLettres.js
// est le seul consommateur destiné à la production (cron unique).
//
// ⚠️ Ne DUPLIQUE PAS getCurrentSeasonId() : chaque jeu (anagrams.js,
// pelemele.js, frames.js, zoom.js, lajustecarte.js, blindroyale.js) garde
// sa propre copie de cette fonction — convention assumée du repo (voir le
// commentaire correspondant dans lajustecarte.js), pas une omission. Ce
// module en a néanmoins besoin pour SA PROPRE décision (quel jeu est actif),
// indépendante de celle de chaque jeu — copie volontaire, pas une régression
// de la convention.
//
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON (136, septembre 2026,
// voir saison.js), saison encore gérée par Anagram à la mise en place de
// l'alternance — décision produit explicite : on
// attend la fin de CETTE saison avant de basculer, jamais une bascule en
// cours de saison. Parité par rapport à cette référence : écart PAIR (0, 2,
// 4...) → Anagram, écart IMPAIR (1, 3, 5...) → Pêle-mêle. Donc saison 136 =
// Anagram (celle en cours au moment de la mise en place), 137 = Pêle-mêle,
// 138 = Anagram, etc.
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
export const ACTIVE_GAME_REFERENCE_SEASON = 136;

// Fonction pure, testable indépendamment de Redis. À partir de la saison de
// bascule du groupe, la nouvelle paire prend le relais (voir refonte.js).
export function getActiveLetterGame(seasonId) {
  const refonte = getRefonteGame("lettres", seasonId);
  if (refonte) return refonte;
  const diff = seasonId - ACTIVE_GAME_REFERENCE_SEASON;
  const parity = ((diff % 2) + 2) % 2; // toujours 0 ou 1, même si diff était négatif
  return parity === 0 ? "anagram" : "pelemele";
}

// ── Suivi de la dernière saison connue ────────────────────────────
// Distinct de l'état propre à chaque jeu (anagram:state / pelemele:state) :
// un seul jeu tourne par saison, donc l'état interne du jeu qui vient de
// terminer sa saison ne "voit" la transition suivante que DEUX saisons plus
// tard (la prochaine fois que CE jeu repostera) — trop tard pour un récap de
// fin de saison posté en temps voulu. Ce suivi est donc nécessairement
// partagé et tenu par l'orchestrateur (jeux/scripts/postJeuxDeLettres.js), pas
// par un jeu individuel.
const LAST_SEASON_KEY = "jeuxdelettres:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
