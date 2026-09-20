// ============================================================
// services/discordLinks.js — Liens Clash tag → Discord user ID
// Stockage : Upstash Redis (hash `discordlinks`, même instance que
// clanCache.js/snapshot.js). Remplace l'ancien stockage via l'API GitHub
// Contents (lecture avec cache 5 min + écriture par sha, non atomique et
// déclenchant un commit sur main à chaque /discord-link, donc un
// redéploiement Vercel complet — cf. incident Function Storage du 05/09).
// Chaque lien est maintenant un HSET atomique, chaque lecture un HGETALL
// direct, sans commit ni redéploiement.
// ============================================================

import { Redis } from "@upstash/redis";

const LINKS_KEY = "discordlinks";

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

// automaticDeserialization: false → hgetall renvoie un tableau plat
// [field1, value1, field2, value2, ...] et non un objet (même convention
// que backend/services/blackjack.js).
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

/**
 * Retourne le mapping { "#TAG": "discord_user_id" }.
 * En cas d'erreur, retourne {}.
 */
export async function getDiscordLinks() {
  try {
    const flat = (await getRedis().hgetall(LINKS_KEY)) || [];
    return pairsToObject(flat);
  } catch {
    return {};
  }
}

/**
 * Lie un ou plusieurs tags Clash à un utilisateur Discord.
 * `tagToUserId` : { "#TAG": "discord_user_id", ... }.
 * Écriture atomique (HSET) — n'écrase jamais les liens des autres joueurs.
 */
export async function setDiscordLinks(tagToUserId) {
  const entries = Object.entries(tagToUserId ?? {});
  if (entries.length === 0) return true;
  try {
    await getRedis().hset(LINKS_KEY, Object.fromEntries(entries));
    return true;
  } catch {
    return false;
  }
}
