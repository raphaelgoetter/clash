// ============================================================
// jeuxvisuels.js — Tronc commun aux mini-jeux "visuels" (Zoom carte,
// Palette), qui alternent désormais une saison sur deux sous
// le nom collectif "Jeux visuels" : résolution de quel jeu est actif pour
// une saison donnée. Contrairement à jeuxdelettres.js, pas de planification
// hebdomadaire à dupliquer ici : Zoom a toujours eu un créneau fixe unique
// (vendredi 18h UTC), pas l'historique multi-créneaux d'Anagram — le
// gating jour/heure reste géré directement par jeux/scripts/postJeuxVisuels.js.
// jeux/scripts/postJeuxVisuels.js est le seul consommateur destiné à la
// production (cron unique, remplace .github/workflows/zoom.yml).
//
// ⚠️ Ne DUPLIQUE PAS getCurrentSeasonId() : chaque jeu (zoom.js, palette.js,
// frames.js, anagrams.js, pelemele.js, lajustecarte.js, blindroyale.js)
// garde sa propre copie de cette fonction — convention assumée du repo (voir
// jeuxdelettres.js). Ce module en a néanmoins besoin pour SA PROPRE décision
// (quel jeu est actif), indépendante de celle de chaque jeu.
//
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON (136, septembre 2026,
// voir saison.js), même référence que jeuxdelettres.js, sans lien entre les
// deux alternances.
// Décision produit explicite : Zoom termine CETTE saison avant de céder la
// main, jamais une bascule en cours de saison. Parité par rapport à cette
// référence : écart PAIR (0, 2, 4...) → Zoom, écart IMPAIR (1, 3, 5...) →
// Palette. Donc saison 136 = Zoom (en cours au moment de la mise en place),
// 137 = Palette ("la saison prochaine"), 138 = Zoom, etc.
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
export function getActiveVisualGame(seasonId) {
  const refonte = getRefonteGame("visuels", seasonId);
  if (refonte) return refonte;
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
// partagé et tenu par l'orchestrateur (jeux/scripts/postJeuxVisuels.js), pas par
// un jeu individuel.
const LAST_SEASON_KEY = "jeuxvisuels:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
