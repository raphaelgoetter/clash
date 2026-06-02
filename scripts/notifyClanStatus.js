#!/usr/bin/env node
// notifyClanStatus.js
// Poste un avertissement journalier si le statut d'un clan ne correspond pas
// à la règle attendue selon le jour : InvitationOnly pendant la GDC/Colisée,
// open pendant les jours d'entraînement.

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import { warResetOffsetMs } from "../backend/services/dateUtils.js";
import { fetchClan } from "../backend/services/clashApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "clan-cache",
);
const LOG_FILE = path.join(__dirname, "..", "data", "clan-status-log.json");

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const ROLE_CACHE = new Map();

const CLAN_RULES = {
  Y8JUPC9C: {
    name: "La Resistance",
    roleName: "LA RESISTANCE ★",
  },
  LRQP20V9: {
    name: "Les Resistants",
    roleName: "LES RESISTANTS ★",
  },
};

function normalizeClanTag(tag) {
  if (!tag) return "";
  return String(tag).replace(/^#/, "").trim().toUpperCase();
}

function normalizeClanType(type) {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "inviteonly") return "inviteOnly";
  if (normalized === "open") return "open";
  return normalized;
}

function getParisDateParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${getPart("year")}-${getPart("month")}-${getPart("day")}`,
  };
}

function shouldBeInviteOnly(clanTag, now = new Date()) {
  const resetOffset = warResetOffsetMs(clanTag);
  const adjustedDow = new Date(now.getTime() - resetOffset).getUTCDay();
  return (
    adjustedDow === 4 ||
    adjustedDow === 5 ||
    adjustedDow === 6 ||
    adjustedDow === 0
  );
}

function expectedClanType(clanTag, now = new Date()) {
  return shouldBeInviteOnly(clanTag, now) ? "inviteOnly" : "open";
}

function normalizeRoleName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function fetchGuildRoles(token) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error("Variable manquante: DISCORD_GUILD_ID");
  }

  const cacheKey = `roles:${guildId}`;
  if (ROLE_CACHE.has(cacheKey)) {
    return ROLE_CACHE.get(cacheKey);
  }

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }

  const roles = await res.json();
  ROLE_CACHE.set(cacheKey, Array.isArray(roles) ? roles : []);
  return ROLE_CACHE.get(cacheKey);
}

async function resolveRoleMention(token, roleName) {
  const normalizedTarget = normalizeRoleName(roleName);
  const roles = await fetchGuildRoles(token);
  const role = roles.find(
    (entry) => normalizeRoleName(entry?.name) === normalizedTarget,
  );

  if (!role?.id) {
    throw new Error(`Rôle Discord introuvable: ${roleName}`);
  }

  return { id: role.id, mention: `<@&${role.id}>` };
}

export function collectClanStatusIssues(clan, clanTag, now = new Date()) {
  const normalizedTag = normalizeClanTag(clanTag);
  const actualType = normalizeClanType(clan?.clan?.type ?? clan?.type);
  const expectedType = expectedClanType(normalizedTag, now);

  if (actualType === expectedType) {
    return null;
  }

  return {
    tag: normalizedTag,
    name: clan?.clan?.name ?? clan?.name ?? `#${normalizedTag}`,
    actualType,
    expectedType,
    isWarDay: shouldBeInviteOnly(normalizedTag, now),
  };
}

function formatStatusLabel(type) {
  return type === "inviteOnly" ? "InvitationOnly" : "open";
}

function formatExpectedMessage(issue) {
  return issue.isWarDay
    ? "Statut attendu pendant GDC/Colisée : InvitationOnly."
    : "Statut attendu hors GDC : open.";
}

export function buildClanStatusEmbed(issue) {
  return {
    title: "<:sweat:1504139431106576405> Avertissement statut du clan",
    description: issue.name,
    color: 0xed4245,
    fields: [
      {
        name: "Statut actuel",
        value: formatStatusLabel(issue.actualType),
        inline: true,
      },
      {
        name: "Statut attendu",
        value: formatStatusLabel(issue.expectedType),
        inline: true,
      },
      {
        name: "Règle",
        value: formatExpectedMessage(issue),
        inline: false,
      },
    ],
  };
}

export function buildClanStatusPayload(issue, role) {
  const embed = buildClanStatusEmbed(issue);
  return {
    content: role?.mention,
    embeds: [embed],
    allowed_mentions: {
      parse: [],
      roles: role?.id ? [role.id] : [],
    },
  };
}

async function readClanCache(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function readLog() {
  if (!existsSync(LOG_FILE)) return {};
  try {
    return JSON.parse(await readFile(LOG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveLog(log) {
  if (DRY_RUN) return;
  await writeFile(LOG_FILE, JSON.stringify(log, null, 2));
}

async function sendDiscordEmbed(channelId, token, payload) {
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("Variable manquante: DISCORD_TOKEN");
  }

  const staffChannelId = process.env.DISCORD_CHANNEL_STAFF;
  if (!staffChannelId) {
    console.warn(
      "[notifyClanStatus] Variable manquante: DISCORD_CHANNEL_STAFF, script ignore.",
    );
    return;
  }

  const now = new Date();
  const parisParts = getParisDateParts(now);
  const log = await readLog();
  const todayKey = parisParts.dateKey;
  let postedCount = 0;

  for (const [clanTag, rule] of Object.entries(CLAN_RULES)) {
    if (!FORCE && log[clanTag] === todayKey) {
      continue;
    }

    const cached = await readClanCache(clanTag);
    const liveClan = await fetchClan(clanTag).catch(() => null);
    if (!cached && !liveClan) continue;

    const issue = collectClanStatusIssues(
      {
        clan: {
          name: liveClan?.name ?? cached?.clan?.name,
          type: liveClan?.type ?? cached?.clan?.type,
        },
      },
      clanTag,
      now,
    );
    if (!issue) continue;

    const role = await resolveRoleMention(token, rule.roleName);
    await sendDiscordEmbed(
      staffChannelId,
      token,
      buildClanStatusPayload(issue, role),
    );
    log[clanTag] = todayKey;
    await saveLog(log);
    postedCount += 1;
  }

  console.log(
    `ClanStatus: ${postedCount} message${postedCount > 1 ? "s" : ""} poste${postedCount > 1 ? "s" : ""}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[notifyClanStatus] Erreur:", err.message);
    process.exit(1);
  });
}
