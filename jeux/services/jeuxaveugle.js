// ============================================================
// jeuxaveugle.js — Tronc commun aux mini-jeux "à l'aveugle" (La Juste Carte,
// Blind Royale), qui alternent désormais une saison sur deux
// sous le nom collectif "Jeux à l'aveugle" : résolution de quel jeu est
// actif pour une saison donnée. jeux/scripts/postJeuxAveugle.js est le seul
// consommateur destiné à la production (cron unique, remplace
// .github/workflows/lajustecarte.yml et blindroyale.yml).
//
// ⚠️ Ne DUPLIQUE PAS getCurrentSeasonId() : chaque jeu (lajustecarte.js,
// blindroyale.js, zoom.js, palette.js, anagrams.js, pelemele.js, frames.js)
// garde sa propre copie de cette fonction — convention assumée du repo (voir
// jeuxdelettres.js). Ce module en a néanmoins besoin pour SA PROPRE décision
// (quel jeu est actif), indépendante de celle de chaque jeu.
//
// Jour de publication — cas particulier par rapport à jeuxvisuels.js et
// jeuxdelettres.js : les deux jeux tournaient déjà en prod, chacun avec sa
// saison en cours et son propre jour (La Juste Carte : dimanche 16h UTC ;
// Blind Royale : lundi 18h UTC), contrairement à Palette/Pêle-mêle qui
// avaient été conçus dès leur création pour partager le jour du jeu
// existant. Décision produit explicite (2026-09-21) : le jour commun retenu
// est LUNDI 18h UTC (créneau actuel de Blind Royale). L'alternance est
// calée pour que Blind Royale (déjà sur ce jour) prenne la main dès la
// première saison de bascule (137, voir ci-dessous) — donc aucun jour ne
// bouge tant que Blind Royale est actif. La Juste Carte migrera de dimanche
// à lundi seulement quand elle reprendra la main (saison 138).
//
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON (136, septembre 2026,
// voir saison.js), même référence que jeuxvisuels.js/jeuxdelettres.js, sans
// lien entre les trois alternances. Décision produit
// explicite, comme pour les deux autres : chaque jeu termine SA saison en
// cours avant de céder la main, jamais de bascule en milieu de saison.
// Parité par rapport à cette référence : écart PAIR (0, 2, 4...) → La Juste
// Carte (le plus ancien des deux, créé le 2026-08-16), écart IMPAIR (1, 3,
// 5...) → Blind Royale. Donc saison 136 = La Juste Carte (en cours au
// moment de la mise en place), 137 = Blind Royale ("la saison prochaine",
// déjà sur le bon jour), 138 = La Juste Carte (bascule dimanche → lundi à
// ce moment-là), etc.
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
export function getActiveBlindGame(seasonId) {
  const refonte = getRefonteGame("aveugle", seasonId);
  if (refonte) return refonte;
  const diff = seasonId - ACTIVE_GAME_REFERENCE_SEASON;
  const parity = ((diff % 2) + 2) % 2; // toujours 0 ou 1, même si diff était négatif
  return parity === 0 ? "lajustecarte" : "blindroyale";
}

// ── Suivi de la dernière saison connue ────────────────────────────
// Distinct de l'état propre à chaque jeu (lajustecarte:state /
// blindroyale:state) : un seul jeu tourne par saison, donc l'état interne du
// jeu qui vient de terminer sa saison ne "voit" la transition suivante que
// DEUX saisons plus tard (la prochaine fois que CE jeu repostera) — trop
// tard pour un récap de fin de saison posté en temps voulu. Ce suivi est
// donc nécessairement partagé et tenu par l'orchestrateur
// (jeux/scripts/postJeuxAveugle.js), pas par un jeu individuel.
const LAST_SEASON_KEY = "jeuxaveugle:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
