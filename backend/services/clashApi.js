// ============================================================
// clashApi.js — Wrapper for the official Clash Royale API
// All requests are proxied through this service to centralise
// authentication and error handling.
// ============================================================

import fetch from 'node-fetch';

// Using the official RoyaleAPI proxy which does not enforce IP whitelisting.
// Same API key, same endpoints — no need to whitelist Vercel's dynamic IPs.
const BASE_URL = 'https://proxy.royaleapi.dev/v1';

/**
 * Build authorization headers using the API key stored in env.
 */
function buildHeaders() {
  const key = process.env.CLASH_API_KEY?.trim();
  if (!key) {
    throw new Error('CLASH_API_KEY environment variable is not set.');
  }
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
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

async function get(path, retries = 3, delayMs = 500) {
  const url = `${BASE_URL}${path}`;
  let attempt = 0;

  while (true) {
    const res = await fetch(url, { headers: buildHeaders() });

    if (res.ok) {
      return res.json();
    }

    const body = await res.text();
    const err = new Error(`Clash API error ${res.status} on ${path}: ${body}`);
    if (res.status === 429) {
      err.isRateLimit = true;
      err.retryAfter = res.headers.get('retry-after');
    }

    if ((res.status === 429 || [502, 503, 504].includes(res.status)) && attempt < retries) {
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
  return encodeURIComponent(tag.startsWith('#') ? tag : `#${tag}`);
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
  return Array.isArray(data) ? data : data.items ?? [];
}

// ── Clan endpoints ────────────────────────────────────────────

/** Fetch a clan's public profile. */
export async function fetchClan(tag) {
  return get(`/clans/${encodeTag(tag)}`);
}

/** Fetch the list of members in a clan. */
export async function fetchClanMembers(tag) {
  const data = await get(`/clans/${encodeTag(tag)}/members`);
  return Array.isArray(data) ? data : data.items ?? [];
}

/**
 * Fetch the river race log for a clan (last ~10 completed seasons).
 * Each entry contains standings and per-player fame/decks data.
 */
export async function fetchRaceLog(tag) {
  const data = await get(`/clans/${encodeTag(tag)}/riverracelog`);
  return Array.isArray(data) ? data : data.items ?? [];
}

/**
 * Fetch the current ongoing river race for a clan.
 */
export async function fetchCurrentRace(tag) {
  return get(`/clans/${encodeTag(tag)}/currentriverrace`);
}
