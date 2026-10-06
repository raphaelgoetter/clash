// ============================================================
// services/matchupPerformance.js — Cumul de la performance GDC (victoires
// réelles vs attendues d'après le %matchup) sur une fenêtre glissante.
//
// Le battle log de l'API ne garde que 25 à 40 combats : trop peu pour que
// l'écart à l'attendu dépasse la marge du hasard. Le cron horaire
// collectSnapshots.js (qui récupère déjà le battle log de chaque participant
// GDC) enregistre donc ici chaque combat GDC, pour cumuler ~3 semaines.
//
// Stockage : un seul hash Redis `matchupPerf:war` (champ = tag joueur,
// valeur = JSON [{ key, t, p, w }]) — 2 commandes par clan et par heure.
// ============================================================

import { Redis } from "@upstash/redis";
import { listMatchupPerformanceSamples } from "./battleLogUtils.js";
import { MS_PER_DAY } from "./dateUtils.js";

const KEY = "matchupPerf:war";
export const PERFORMANCE_WINDOW_DAYS = 21;

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

function normalizeTag(tag) {
  return String(tag || "")
    .replace(/^#/, "")
    .toUpperCase();
}

function parseSamples(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Fusionne les échantillons (dédoublonnés par `key`, le stocké prime : sa
// difficulté est figée au moment du combat) et purge ceux hors fenêtre.
function mergeSamples(stored, fresh, now = Date.now()) {
  const minTime = now - PERFORMANCE_WINDOW_DAYS * MS_PER_DAY;
  const byKey = new Map();
  for (const sample of [...fresh, ...stored]) {
    if (sample.t >= minTime) byKey.set(sample.key, sample);
  }
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

/**
 * Enregistre les combats GDC des battle logs fournis (appelé par le cron
 * horaire collectSnapshots.js). N'écrit que les joueurs dont le cumul change.
 * @param {Record<string, object[]>} battleLogsByTag
 * @returns {Promise<number>} nombre de joueurs mis à jour
 */
export async function recordWarMatchupSamples(battleLogsByTag) {
  const tags = Object.keys(battleLogsByTag ?? {});
  if (tags.length === 0) return 0;
  const fields = tags.map(normalizeTag);
  const stored = (await getRedis().hmget(KEY, ...fields)) ?? {};

  const updates = {};
  const removals = [];
  for (let i = 0; i < tags.length; i++) {
    const field = fields[i];
    const previous = parseSamples(stored[field]);
    const fresh = await listMatchupPerformanceSamples(
      battleLogsByTag[tags[i]],
      {
        warOnly: true,
      },
    );
    const merged = mergeSamples(previous, fresh);
    const changed =
      merged.length !== previous.length ||
      merged.some((sample, j) => sample.key !== previous[j]?.key);
    if (!changed) continue;
    if (merged.length === 0) removals.push(field);
    else updates[field] = JSON.stringify(merged);
  }

  if (Object.keys(updates).length > 0) await getRedis().hset(KEY, updates);
  if (removals.length > 0) await getRedis().hdel(KEY, ...removals);
  return Object.keys(updates).length + removals.length;
}

/**
 * Performance GDC d'un joueur sur la fenêtre glissante : cumul Redis complété
 * par le battle log courant (combats joués depuis le dernier passage du cron).
 * Repli sur le battle log seul si Redis est indisponible.
 * @param {string} tag
 * @param {object[]} [battleLog]
 */
export async function getWarMatchupPerformanceSamples(tag, battleLog = []) {
  const fresh = await listMatchupPerformanceSamples(battleLog, {
    warOnly: true,
  });
  let stored = [];
  try {
    stored = parseSamples(await getRedis().hget(KEY, normalizeTag(tag)));
  } catch (err) {
    console.warn("[matchupPerformance] lecture Redis impossible:", err.message);
  }
  return mergeSamples(stored, fresh);
}
