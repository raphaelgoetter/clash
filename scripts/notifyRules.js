#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISCORD_API = "https://discord.com/api/v10";
const CLAN_TAGS = ["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"];
const RULES_FILE = path.resolve(
  __dirname,
  "..",
  "frontend",
  "public",
  "documentation",
  "rules.md",
);
const IMAGE_URL = "https://trustroyale.vercel.app/images/regles.webp";

const CLAN_ROLE_NAMES = {
  Y8JUPC9C: "LA RESISTANCE ★",
  LRQP20V9: "LES RESISTANTS ★",
  QU9UQJRL: "LES REVOLTES ★",
};

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const NO_PING = process.argv.includes("--no-ping");
const TAG_FILTER = process.argv
  .find((arg) => arg.startsWith("--tag="))
  ?.slice("--tag=".length);

const ROLE_CACHE = new Map();

function normalizeRoleName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getClanRoleId(clanTag) {
  const roleName = CLAN_ROLE_NAMES[clanTag];
  if (!roleName) return null;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  const cacheKey = `roles:${guildId}`;
  if (!ROLE_CACHE.has(cacheKey)) {
    try {
      const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      });
      if (!res.ok) {
        console.warn(
          `[notifyRules] Impossible de récupérer les rôles (${res.status})`,
        );
        ROLE_CACHE.set(cacheKey, []);
      } else {
        const roles = await res.json();
        ROLE_CACHE.set(cacheKey, Array.isArray(roles) ? roles : []);
      }
    } catch (err) {
      console.warn(`[notifyRules] Erreur rôles:`, err.message);
      ROLE_CACHE.set(cacheKey, []);
    }
  }

  const roles = ROLE_CACHE.get(cacheKey);
  const role = roles.find(
    (r) => normalizeRoleName(r?.name) === normalizeRoleName(roleName),
  );
  return role?.id ?? null;
}

function isFirstTuesdayOfMonth() {
  const now = new Date();
  const paris = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  return paris.getDay() === 2 && paris.getDate() <= 7;
}

function extractRulesByClan(fileContent) {
  const blocks = [];
  const regex = /```md\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(fileContent)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function buildPayload(roleId, rulesText) {
  const embed = {
    description: rulesText.slice(0, 4096),
    image: { url: IMAGE_URL },
  };

  const payload = { embeds: [embed], allowed_mentions: { parse: [] } };
  if (roleId) {
    payload.content = `<@&${roleId}>`;
    payload.allowed_mentions.roles = [roleId];
  }
  return payload;
}

async function main() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("[notifyRules] Variable manquante: DISCORD_TOKEN");
    process.exit(1);
  }

  if (!FORCE && !isFirstTuesdayOfMonth()) {
    console.log("[notifyRules] Pas le premier mardi du mois — skip.");
    process.exit(0);
  }

  let rulesBlocks;
  try {
    const content = await readFile(RULES_FILE, "utf-8");
    rulesBlocks = extractRulesByClan(content);
  } catch (err) {
    console.error(
      `[notifyRules] Erreur lecture ${RULES_FILE}:`,
      err.message,
    );
    process.exit(1);
  }

  if (rulesBlocks.length < CLAN_TAGS.length) {
    console.error(
      `[notifyRules] ${rulesBlocks.length} blocs trouvés dans rules.md, ${CLAN_TAGS.length} attendus.`,
    );
    process.exit(1);
  }

  for (let i = 0; i < CLAN_TAGS.length; i++) {
    const tag = CLAN_TAGS[i];
    if (TAG_FILTER && tag !== TAG_FILTER) continue;
    const rulesText = rulesBlocks[i];

    const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
    if (!channelId) {
      console.warn(
        `[SKIP] ${tag}: DISCORD_CHANNEL_MEMBERS_${tag} non défini`,
      );
      continue;
    }

    const roleId = NO_PING ? null : await getClanRoleId(tag);
    const payload = buildPayload(roleId, rulesText);

    try {
      if (DRY_RUN) {
        console.log(`\n[DRY RUN] ${tag} → ${channelId}`);
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const res = await fetch(
          `${DISCORD_API}/channels/${channelId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        console.log(`[OK] ${tag} posté dans channel ${channelId}`);
      }
    } catch (err) {
      console.error(`[ERR] ${tag}:`, err.message);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
