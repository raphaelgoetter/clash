// ============================================================
// services/blacklist.js — Liste Noire du staff (commande /blacklist)
// Stockage : Upstash Redis (hash `blacklist`, même instance que
// discordLinks.js). Un champ par tag Clash (« #TAG »), valeur JSON :
//   { name, clans: [{ tag, name }], reason, addedBy, addedAt }
// `clans` = historique des clans distincts où le joueur a été vu, du plus
// récent au plus ancien (plafonné à MAX_CLAN_HISTORY) — sert à afficher le
// « dernier clan connu » même quand le joueur a quitté tout clan.
// ============================================================

import { Redis } from "@upstash/redis";

const BLACKLIST_KEY = "blacklist";
const MAX_CLAN_HISTORY = 5;

// Caractères autorisés dans un tag Clash Royale (alphabet Supercell)
const TAG_REGEX = /^[0289PYLQGRJCUV]{3,12}$/;

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

/**
 * Normalise un tag saisi (avec ou sans #, minuscules, O à la place de 0).
 * Retourne « #TAG » ou null si le format est invalide.
 */
export function normalizeBlacklistTag(raw) {
  const clean = String(raw ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase()
    .replace(/O/g, "0");
  return TAG_REGEX.test(clean) ? `#${clean}` : null;
}

/**
 * Ajoute un clan en tête de l'historique s'il diffère du plus récent.
 * Retourne un nouveau tableau (ne modifie pas l'entrée).
 */
export function pushClanHistory(clans, clan) {
  const list = Array.isArray(clans) ? clans : [];
  if (!clan?.tag) return list;
  if (list[0]?.tag === clan.tag) {
    // Même clan : on rafraîchit juste le nom (renommage éventuel)
    return [{ tag: clan.tag, name: clan.name }, ...list.slice(1)];
  }
  return [{ tag: clan.tag, name: clan.name }, ...list].slice(
    0,
    MAX_CLAN_HISTORY,
  );
}

/**
 * Historique des clans d'un joueur déduit de son journal de combats (du plus
 * ancien au plus récent), puis de son clan actuel. Même format que `clans`.
 */
export function clanHistoryFromBattles(tag, battles, currentClan) {
  let clans = [];
  for (const battle of [...(battles ?? [])].reverse()) {
    const me = (battle?.team ?? []).find((p) => p.tag === tag);
    clans = pushClanHistory(clans, me?.clan);
  }
  return pushClanHistory(clans, currentClan);
}

/**
 * Dernier clan connu = clan le plus récent de l'historique différent du clan
 * actuel (sinon on répéterait le clan actuel). null si aucun.
 */
export function lastKnownClan(clans, currentClanTag) {
  return (clans ?? []).find((c) => c.tag !== currentClanTag) ?? null;
}

/**
 * Clans « à risque » : tous les clans de l'historique des joueurs de la
 * Liste Noire. Retourne Map<"#CLANTAG", Set<"#TAG joueur">>.
 */
export function buildRiskyClanMap(blacklist) {
  const map = new Map();
  for (const [playerTag, entry] of Object.entries(blacklist ?? {})) {
    for (const clan of entry?.clans ?? []) {
      if (!clan?.tag) continue;
      if (!map.has(clan.tag)) map.set(clan.tag, new Set());
      map.get(clan.tag).add(playerTag);
    }
  }
  return map;
}

/**
 * Retourne { "#TAG": entry, ... }. En cas d'erreur Redis, lève l'exception
 * (une liste noire vide par erreur serait trompeuse pour le staff).
 */
export async function getBlacklist() {
  const flat = (await getRedis().hgetall(BLACKLIST_KEY)) || [];
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    try {
      obj[flat[i]] = JSON.parse(flat[i + 1]);
    } catch {
      obj[flat[i]] = { name: null, clans: [] };
    }
  }
  return obj;
}

/** Retourne true si le tag est déjà dans la liste noire. */
export async function isBlacklisted(tag) {
  return (await getRedis().hexists(BLACKLIST_KEY, tag)) === 1;
}

/**
 * Écrit (ou remplace) une ou plusieurs entrées.
 * `entries` : { "#TAG": entry, ... } — HSET atomique par tag.
 */
export async function setBlacklistEntries(entries) {
  const pairs = Object.entries(entries ?? {});
  if (pairs.length === 0) return;
  await getRedis().hset(
    BLACKLIST_KEY,
    Object.fromEntries(pairs.map(([tag, e]) => [tag, JSON.stringify(e)])),
  );
}

/** Retire un tag. Retourne true s'il était présent. */
export async function removeFromBlacklist(tag) {
  return (await getRedis().hdel(BLACKLIST_KEY, tag)) > 0;
}
