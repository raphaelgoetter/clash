// ============================================================
// clashApi.js — Wrapper for the official Clash Royale API
// All requests are proxied through this service to centralise
// authentication and error handling.
// ============================================================

import fetch from "node-fetch";
import { withCardArtOverrides } from "./cardArt.js";

// Using the official RoyaleAPI proxy which does not enforce IP whitelisting.
// Same API key, same endpoints — no need to whitelist Vercel's dynamic IPs.
const BASE_URL = "https://proxy.royaleapi.dev/v1";

/**
 * Build authorization headers using the API key stored in env.
 */
function buildHeaders() {
  const key = process.env.CLASH_API_KEY?.trim();
  if (!key) {
    throw new Error("CLASH_API_KEY environment variable is not set.");
  }
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

/**
 * Generic GET helper.
 * @param {string} path - API path, e.g. /players/%23ABC123
 * @returns {Promise<object>} Parsed JSON response
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Délai max d'une requête : sans lui, un proxy qui ne répond plus (ETIMEDOUT)
// bloque la fonction Vercel jusqu'à son timeout de 60 s.
const REQUEST_TIMEOUT_MS = 10000;

async function get(path, retries = 3, delayMs = 500) {
  const url = `${BASE_URL}${path}`;
  let attempt = 0;

  while (true) {
    let res;
    try {
      res = await fetch(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (networkErr) {
      // Coupure réseau (ECONNRESET, ETIMEDOUT, délai dépassé) : un seul nouvel essai
      if (attempt < 1) {
        attempt += 1;
        await sleep(delayMs);
        continue;
      }
      throw networkErr;
    }

    if (res.ok) {
      return res.json();
    }

    const body = await res.text();
    const err = new Error(`Clash API error ${res.status} on ${path}: ${body}`);
    err.status = res.status;
    if (res.status === 429) {
      err.isRateLimit = true;
      err.retryAfter = res.headers.get("retry-after");
    }

    // 5xx : le proxy RoyaleAPI (Cloudflare) renvoie aussi des 500/520/525 transitoires
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const backoff = delayMs * Math.pow(2, attempt);
      attempt += 1;
      await sleep(backoff);
      continue;
    }

    throw err;
  }
}

/**
 * Encode a player/clan tag for use in the URL.
 * Tags start with '#'; the API expects '%23' in their place.
 * @param {string} tag
 * @returns {string}
 */
export function encodeTag(tag) {
  return encodeURIComponent(tag.startsWith("#") ? tag : `#${tag}`);
}

// ── Player endpoints ──────────────────────────────────────────

/** Fetch a player's public profile. */
export async function fetchPlayer(tag) {
  return get(`/players/${encodeTag(tag)}`);
}

/** Fetch a player's recent battle log (last 25 battles). */
export async function fetchBattleLog(tag) {
  const data = await get(`/players/${encodeTag(tag)}/battlelog`);
  // The API returns an array directly
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** Fetch all Clash Royale cards definitions. */
// Illustrations de base périmées côté API remplacées (voir cardArt.js).
export async function fetchCards() {
  const data = await get(`/cards`);
  const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
  return withCardArtOverrides(items);
}

/** Fetch all Clash Royale locations (regions and countries). */
export async function fetchLocations() {
  const data = await get(`/locations`);
  if (Array.isArray(data)) return data;
  return Array.isArray(data.items) ? data.items : [];
}

// ── Clan endpoints ────────────────────────────────────────────

/** Fetch a clan's public profile. */
export async function fetchClan(tag) {
  return get(`/clans/${encodeTag(tag)}`);
}

/**
 * Search clans by location/name/member count. Note: search results do NOT
 * include the clan `description` field (only available via fetchClan) — use
 * fetchClan(tag) per candidate if filtering on description is needed.
 * @param {object} params
 * @param {number|string} [params.locationId]
 * @param {string} [params.name]
 * @param {number} [params.minMembers]
 * @param {number} [params.maxMembers]
 * @param {number} [params.limit] - max 1000 per page.
 * @param {string} [params.after] - pagination cursor from a previous page.
 * @returns {Promise<{items: Array, cursorAfter: string|null}>}
 */
export async function searchClans({
  locationId,
  name,
  minMembers,
  maxMembers,
  limit,
  after,
} = {}) {
  const query = new URLSearchParams();
  if (locationId != null) query.set("locationId", locationId);
  if (name) query.set("name", name);
  if (minMembers != null) query.set("minMembers", minMembers);
  if (maxMembers != null) query.set("maxMembers", maxMembers);
  if (limit != null) query.set("limit", limit);
  if (after) query.set("after", after);

  const data = await get(`/clans?${query.toString()}`);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    cursorAfter: data.paging?.cursors?.after ?? null,
  };
}

/** Fetch the list of members in a clan. */
export async function fetchClanMembers(tag) {
  const data = await get(`/clans/${encodeTag(tag)}/members`);
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Fetch the river race log for a clan (last ~10 completed seasons).
 * Each entry contains standings and per-player pts/decks data.
 */
export async function fetchRaceLog(tag) {
  const data = await get(`/clans/${encodeTag(tag)}/riverracelog`);
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Fetch the current ongoing river race for a clan.
 */
export async function fetchCurrentRace(tag) {
  return get(`/clans/${encodeTag(tag)}/currentriverrace`);
}

// ── Location rankings endpoints ───────────────────────────────

/**
 * Fetch clan war rankings for a location.
 * @param {number|string} locationId - e.g. 57000087 for France.
 * @param {number} limit - number of entries to fetch (max ~1000). Default 500.
 * @returns {Promise<Array>} Ranked clan entries with tag, rank, previousRank, clanScore.
 */
export async function fetchClanWarRankings(locationId, limit = 500) {
  const data = await get(
    `/locations/${locationId}/rankings/clanwars?limit=${limit}`,
  );
  return Array.isArray(data) ? data : (data.items ?? []);
}
