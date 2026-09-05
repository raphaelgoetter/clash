// ============================================================
// clanCache.js — cache de données clan pour le frontend
//
// Stockage : Upstash Redis (même instance que quiz.js/tamagotchi.js),
// espace de clés `clancache:*`. Remplace l'ancien double stockage
// fichier (/tmp + bundle statique frontend/public/clan-cache) : ce
// dernier forçait un redéploiement Vercel à chaque régénération
// horaire du cache, ce qui gonflait le Function Storage du projet.
// ============================================================

import { Redis } from "@upstash/redis";

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

function redisKey(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  return `clancache:${clean}`;
}

function stripClanCachePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const {
    lastWarSummary,
    warSnapshotDays,
    currentWarDays,
    decksYesterdayAtThisHour,
    // these are war/day specific and must be kept in snapshots or live API only
    ...rest
  } = payload;

  // warDays/warDecks sont conservés dans le cache pour que le fallback statique
  // affiche la colonne "This War" même quand l'API live échoue (données max 1h stale).
  // Ils seront rechargés à chaque regénération de cache (cron horaire).

  return rest;
}

export async function loadClanCache(clanTag) {
  try {
    const raw = await getRedis().get(redisKey(clanTag));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export async function saveClanCache(clanTag, payload) {
  const data = stripClanCachePayload(payload);
  try {
    await getRedis().set(redisKey(clanTag), JSON.stringify(data));
  } catch (_) {}
}
