// ============================================================
// jeuxdelettres.js — Tronc commun aux mini-jeux "de lettres" (Anagram,
// Pêle-mêle), qui alternent désormais une saison Clash Royale sur deux sous
// le nom collectif "Jeux de lettres" : planification hebdomadaire partagée
// (samedi, 2 créneaux 10h/18h, tirage aléatoire — copié du mécanisme
// originel d'Anagram, voir backend/services/anagrams.js), et résolution de
// quel jeu est actif pour une saison donnée. scripts/postJeuxDeLettres.js
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
// Alternance : ancrée sur ACTIVE_GAME_REFERENCE_SEASON, la saison technique
// Clash Royale encore gérée par Anagram au moment de la mise en place de
// l'alternance (confirmée le 2026-09-19 : saison technique 136, Saison
// publique 87 via toPublicSeasonId) — décision produit explicite : on
// attend la fin de CETTE saison avant de basculer, jamais une bascule en
// cours de saison. Parité par rapport à cette référence : écart PAIR (0, 2,
// 4...) → Anagram, écart IMPAIR (1, 3, 5...) → Pêle-mêle. Donc saison 136 =
// Anagram (celle en cours au moment de la mise en place), 137 = Pêle-mêle,
// 138 = Anagram, etc.
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
// d'alternance elle-même (scripts/postJeuxDeLettres.js), pas pour l'état
// interne d'un jeu précis.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "jeuxdelettres:seasonId",
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

// ── Planification hebdomadaire ──────────────────────────────────
// Copie assumée de ANAGRAM_CRON_HOURS/computeWeeklySlotIndex/
// shouldPostThisSlot (backend/services/anagrams.js) — voir le commentaire
// original pour la justification complète (2 créneaux seulement, pas plus,
// à cause du biais introduit par les retards de déclenchement GitHub
// Actions). Anagram garde SA propre copie intacte (zéro risque pour le jeu
// déjà en production) ; ce module a la sienne pour la décision de
// planification PARTAGÉE (scripts/postJeuxDeLettres.js).
export const LETTRES_CRON_HOURS = [10, 18];

export function computeWeeklySlotIndex(now = new Date()) {
  const hour = now.getUTCHours();
  const passed = LETTRES_CRON_HOURS.filter((h) => h <= hour).length;
  return Math.min(LETTRES_CRON_HOURS.length, Math.max(1, passed));
}

export function shouldPostThisSlot(slotIndex, rng = Math.random) {
  const remaining = LETTRES_CRON_HOURS.length - slotIndex + 1; // 2,1
  return rng() < 1 / remaining; // dernier créneau : 1/1, garanti
}

// ── Alternance saisonnière ──────────────────────────────────────
export const ACTIVE_GAME_REFERENCE_SEASON = 136;

// Fonction pure, testable indépendamment de Redis.
export function getActiveLetterGame(seasonId) {
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
// partagé et tenu par l'orchestrateur (scripts/postJeuxDeLettres.js), pas
// par un jeu individuel.
const LAST_SEASON_KEY = "jeuxdelettres:last_season_id";

export async function getLastKnownSeasonId() {
  const raw = await getRedis().get(LAST_SEASON_KEY);
  return raw == null ? null : Number(raw);
}

export async function setLastKnownSeasonId(seasonId) {
  await getRedis().set(LAST_SEASON_KEY, String(seasonId));
}
