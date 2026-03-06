// ============================================================
// clashApi.js — Wrapper for the official Clash Royale API
// All requests are proxied through this service to centralise
// authentication and error handling.
// ============================================================

import fetch from 'node-fetch';

const BASE_URL = 'https://api.clashroyale.com/v1';

/**
 * Build authorization headers using the API key stored in env.
 */
function buildHeaders() {
  const key = process.env.CLASH_API_KEY;
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
async function get(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: buildHeaders() });

  if (!res.ok) {
    const body = await res.text();
    // Surface IP whitelist errors with a clear, actionable message
    if (res.status === 403) {
      let serverIp = 'unknown';
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        serverIp = ipData.ip;
      } catch (_) { /* ignore */ }
      throw new Error(
        `API key not authorised for this server IP (${serverIp}). ` +
        `Go to https://developer.clashroyale.com/, edit your key and add ${serverIp} to the allowed IPs.`
      );
    }
    throw new Error(`Clash API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
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
