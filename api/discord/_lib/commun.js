// Fonctions et constantes partagées par plusieurs modules de routage des
// interactions Discord (api/discord/interactions.js et _routes/).

import { waitUntil } from "@vercel/functions";

// Maintient la fonction Vercel active le temps de l'exécution asynchrone.
export function runBackground(fn) {
  try {
    if (typeof waitUntil === "function") {
      waitUntil(fn());
    } else {
      // En environnement non-Vercel (dev), on exécute quand même pour éviter le timeout.
      fn().catch((err) => console.error("runBackground fallback error:", err));
    }
  } catch (err) {
    console.error("runBackground error:", err);
    fn().catch((err2) => console.error("runBackground fallback error:", err2));
  }
}

export const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

export const trustPlayerUrl = (tag) =>
  `${TRUST_ROYALE_URL}/player/${String(tag).replace(/^#/, "")}`;

export const trustClanUrl = (tag) =>
  `${TRUST_ROYALE_URL}/clan/${String(tag).replace(/^#/, "")}`;

export const FAMILY_CLAN_TAGS = new Set(["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"]);

export function buildDiscordWebhookUrl(body) {
  const token = body.token || body.interaction?.token;
  if (!process.env.DISCORD_APP_ID || !token) return null;
  return `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${token}`;
}

export const COLOR_MAP = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
};

export const RELIABILITY_ICON = {
  green: "<:green:1506174830297485362>",
  yellow: "<:yellow:1506174838870642739>",
  orange: "<:orange:1506174834470686860>",
  red: "<:red:1506174836102139944>",
};

export const FR_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

// Heure de l'observation (Paris) — réutilise le décalage UTC→Paris déjà
// exposé par dateUtils.js (parisOffsetMs), pas de dépendance au fuseau du runtime.
export async function formatParisObservationTime(date = new Date()) {
  const { parisOffsetMs } = await import("../../../backend/services/dateUtils.js");
  const paris = new Date(date.getTime() + parisOffsetMs(date));
  const day = paris.getUTCDate();
  const month = FR_MONTHS[paris.getUTCMonth()];
  const hour = paris.getUTCHours();
  const minute = String(paris.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} à ${hour}h${minute}`;
}

export async function mapWithConcurrency(items, limit, mapper) {
  const result = Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return result;
}

export function parseBattleTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;

  // fallback: format 20240315T123456.000Z
  const m = /^(.{8}T.{6}\.\d{3}Z)$/.exec(value);
  if (m) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(16, 19)}Z`;
    const d2 = new Date(iso);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

export function deckUsageBadge(decksUsed, ignored = false) {
  if (ignored) return "⚪";
  if (typeof decksUsed !== "number" || Number.isNaN(decksUsed)) return "❔";
  if (decksUsed >= 16) return "<:success:1499002702208958577>";
  if (decksUsed >= 12) return "<:warning:1499002725965500577>";
  return "<:error:1499002755841265826>";
}

export const WAR_DAY_SHORT_LABELS_BY_UTC_DAY = {
  4: "J1",
  5: "J2",
  6: "J3",
  0: "J4",
};

export function getWarDayLabel(dayKey) {
  if (!dayKey) return "Jour GDC";
  const date = new Date(`${dayKey}T00:00:00Z`);
  return WAR_DAY_SHORT_LABELS_BY_UTC_DAY[date.getUTCDay()] || dayKey;
}

// TODO: emoji temporaire pour un jour de GDC à venir, en attendant que le
// bon emoji custom soit créé — remplacer <:warn:1506174837519945800> une
// fois disponible.
export const FUTURE_DAY_BADGE = "<:warn:1506174837519945800>";

/**
 * Badge de statut pour une journée GDC, affiché à la place des anciens
 * emojis numérotés (1️⃣2️⃣3️⃣4️⃣) directement à côté du libellé "J1"/"J2"/etc :
 * - jour à venir : badge temporaire FUTURE_DAY_BADGE (cf. TODO ci-dessus) ;
 * - jour en cours ("aujourd'hui") : toujours warning, quel que soit le
 *   nombre de decks déjà joués (la journée n'est pas terminée) ;
 * - jour passé : succès si 4/4 decks joués, erreur si moins de 4 (y
 *   compris 0 confirmé), warning si aucune donnée disponible (decks
 *   inconnu, ex. semaine dernière sans snapshot exploitable).
 */
export function getCombatsDayBadge(decks, { isFuture = false, isToday = false } = {}) {
  if (isFuture) return FUTURE_DAY_BADGE;
  if (isToday) return SCORE_BADGES.warning;
  if (decks == null) return SCORE_BADGES.warning;
  if (decks >= 4) return SCORE_BADGES.success;
  return SCORE_BADGES.error;
}

export const SCORE_BADGES = {
  success: "<:success:1499002702208958577>",
  warning: "<:warning:1499002725965500577>",
  error: "<:error:1499002755841265826>",
};

export function normalizeClanTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

export function normalizeClashTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}
