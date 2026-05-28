#!/usr/bin/env node
// notifyLastSeen.js
// Poste un avertissement journalier pour les joueurs inactifs de chaque clan.
// Usage:
//   node scripts/notifyLastSeen.js           -- poste sur Discord
//   node scripts/notifyLastSeen.js --dry-run -- affiche les embeds sans poster

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import { parseClashDate, MS_PER_DAY } from "../backend/services/dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "clan-cache",
);
const LOG_FILE = path.join(__dirname, "..", "data", "last-seen-log.json");

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const TARGET_PARIS_HOUR = 11;

const CLAN_RULES = {
  Y8JUPC9C: {
    name: "La Resistance",
    warningDays: 4,
    errorDays: 7,
  },
  LRQP20V9: {
    name: "Les Resistants",
    warningDays: 4,
    errorDays: 7,
  },
  QU9UQJRL: {
    name: "Les Revoltes",
    warningDays: null,
    errorDays: 7,
  },
};

const ROLE_LABELS = {
  member: "membre",
  elder: "aîné",
  coleader: "co-leader",
  leader: "chef",
};

const ROLE_PRIORITY = {
  leader: 4,
  coleader: 3,
  elder: 2,
  member: 1,
};

function normalizeTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function normalizeClanTag(tag) {
  return normalizeTag(tag).replace(/^#/, "");
}

function formatRole(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return ROLE_LABELS[normalized] ?? String(role || "membre");
}

function getRolePriority(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return ROLE_PRIORITY[normalized] ?? 0;
}

function formatDays(days) {
  const wholeDays = Math.max(0, Math.floor(days));
  return `${wholeDays} jour${wholeDays > 1 ? "s" : ""}`;
}

function formatPlayerUrl(tag) {
  return `https://trustroyale.vercel.app/fr/player/${normalizeTag(tag).replace(/^#/, "")}`;
}

function getParisDateParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${getPart("year")}-${getPart("month")}-${getPart("day")}`,
    hour: Number(getPart("hour")),
  };
}

function parseLastSeen(lastSeen) {
  if (!lastSeen) return null;
  const parsed = parseClashDate(lastSeen);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function getInactiveSeverity(daysInactive, rule) {
  if (!rule) return null;
  if (rule.errorDays != null && daysInactive >= rule.errorDays) return "error";
  if (rule.warningDays != null && daysInactive >= rule.warningDays)
    return "warning";
  return null;
}

export function collectInactiveMembers(members, clanTag, now = new Date()) {
  const rule = CLAN_RULES[normalizeClanTag(clanTag)] ?? null;
  if (!rule) {
    return { warnings: [], errors: [] };
  }

  const warnings = [];
  const errors = [];

  for (const member of members ?? []) {
    const lastSeenDate = parseLastSeen(member?.lastSeen);
    if (!lastSeenDate) continue;

    const daysInactive = Math.max(
      0,
      (now.getTime() - lastSeenDate.getTime()) / MS_PER_DAY,
    );
    const severity = getInactiveSeverity(daysInactive, rule);
    if (!severity) continue;

    const entry = {
      tag: normalizeTag(member.tag),
      name: member.name ?? normalizeTag(member.tag),
      role: member.role ?? "member",
      isNew: Boolean(member.isNew),
      daysInactive,
    };

    if (severity === "error") errors.push(entry);
    else warnings.push(entry);
  }

  const sorter = (a, b) =>
    b.daysInactive - a.daysInactive ||
    getRolePriority(b.role) - getRolePriority(a.role) ||
    a.name.localeCompare(b.name, "fr");

  warnings.sort(sorter);
  errors.sort(sorter);

  return { warnings, errors };
}

export function formatInactiveLine(member) {
  const parts = [
    `[${member.name}](${formatPlayerUrl(member.tag)})`,
    formatRole(member.role),
  ];

  if (member.isNew) {
    parts.push("nouveau");
  }

  parts.push(`pas connecté depuis ${formatDays(member.daysInactive)}`);
  return `- ${parts.join(" · ")}`;
}

export function buildInactiveEmbed(clanTag, clanName, warnings, errors) {
  const totalWarnings = warnings.length;
  const totalErrors = errors.length;
  const color = totalErrors > 0 ? 0xed4245 : 0xe67e22;

  const fields = [];
  if (totalErrors > 0) {
    fields.push({
      name: `Erreurs (${totalErrors})`,
      value: errors.map(formatInactiveLine).join("\n"),
      inline: false,
    });
  }

  if (totalWarnings > 0) {
    fields.push({
      name: `Avertissements (${totalWarnings})`,
      value: warnings.map(formatInactiveLine).join("\n"),
      inline: false,
    });
  }

  const descriptionParts = [];
  if (totalErrors > 0) {
    descriptionParts.push(`${totalErrors} erreur${totalErrors > 1 ? "s" : ""}`);
  }
  if (totalWarnings > 0) {
    descriptionParts.push(
      `${totalWarnings} avertissement${totalWarnings > 1 ? "s" : ""}`,
    );
  }

  return {
    title: "Avertissement joueurs inactifs",
    description: descriptionParts.join(" · ") || clanName,
    color,
    fields,
    footer: { text: `${clanName} · #${clanTag}` },
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

async function sendDiscordEmbed(channelId, token, embed) {
  if (DRY_RUN) {
    console.log(JSON.stringify({ embeds: [embed] }, null, 2));
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify({ embeds: [embed] }),
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

  const now = new Date();
  const parisParts = getParisDateParts(now);
  if (!DRY_RUN && !FORCE && parisParts.hour !== TARGET_PARIS_HOUR) {
    console.log(
      `LastSeen: exécution ignorée à ${parisParts.hour}h Paris, cible ${TARGET_PARIS_HOUR}h.`,
    );
    return;
  }

  const log = await readLog();
  const todayKey = parisParts.dateKey;
  let postedCount = 0;

  for (const [clanTag, rule] of Object.entries(CLAN_RULES)) {
    const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${clanTag}`];
    if (!channelId) {
      throw new Error(`Variable manquante: DISCORD_CHANNEL_MEMBERS_${clanTag}`);
    }

    if (log[clanTag] === todayKey) {
      continue;
    }

    const cached = await readClanCache(clanTag);
    const members = Array.isArray(cached?.members) ? cached.members : [];
    if (members.length === 0) continue;

    const { warnings, errors } = collectInactiveMembers(members, clanTag, now);
    if (warnings.length === 0 && errors.length === 0) continue;

    const embed = buildInactiveEmbed(clanTag, rule.name, warnings, errors);
    await sendDiscordEmbed(channelId, token, embed);
    log[clanTag] = todayKey;
    await saveLog(log);
    postedCount += 1;
  }

  console.log(
    `LastSeen: ${postedCount} message${postedCount > 1 ? "s" : ""} poste${postedCount > 1 ? "s" : ""}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[notifyLastSeen] Erreur:", err.message);
    process.exit(1);
  });
}
