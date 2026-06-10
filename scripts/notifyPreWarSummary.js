#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { MS_PER_DAY, parseClashDate } from "../backend/services/dateUtils.js";
import { computeMemberReliability } from "../backend/services/playerAnalysis.js";
import { fetchClanWarRankings } from "../backend/services/clashApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "clan-cache",
);
const LOG_FILE = path.join(__dirname, "..", "data", "pre-gdc-weekly-log.json");
const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");
const CLAN_TAGS = ["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"];
const MAX_CLAN_SIZE = 50;

function normalizeTag(tag) {
  if (!tag) return "";
  return String(tag).replace(/^#/, "").trim().toUpperCase();
}

async function readJson(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  if (DRY_RUN) {
    console.log("[dry-run] Écriture simulée de", filePath);
    return;
  }
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readClanCache(clanTag) {
  const cacheFile = path.join(CACHE_DIR, `${normalizeTag(clanTag)}.json`);
  return readJson(cacheFile, null);
}

function parseMemberLastSeen(member) {
  const raw = member?.profile?.lastSeen ?? member?.lastSeen;
  if (!raw) return null;
  return parseClashDate(raw);
}

function getInactiveMembers(members, now) {
  return members
    .map((member) => {
      const lastSeen = parseMemberLastSeen(member);
      if (!lastSeen) return null;
      const hours = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60);
      if (hours < 24 * 4) return null;
      return {
        name: member.profile?.name ?? member.name ?? "inconnu",
        tag: normalizeTag(member.profile?.tag ?? member.tag ?? ""),
        lastSeen,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.lastSeen.getTime() - b.lastSeen.getTime());
}

function getRiskyMembers(members) {
  return members
    .map((member) => {
      const profile = member.profile ?? member;
      const verdict =
        typeof member.verdict === "string"
          ? member.verdict
          : computeMemberReliability(profile).verdict;
      const score = Number.isFinite(member.reliability)
        ? member.reliability
        : computeMemberReliability(profile).score;
      return {
        name: profile.name ?? member.name ?? "inconnu",
        tag: normalizeTag(profile.tag ?? member.tag ?? ""),
        score,
        verdict,
      };
    })
    .filter(
      (entry) =>
        entry.verdict === "High risk" || entry.verdict === "Extreme risk",
    )
    .sort((a, b) => a.score - b.score);
}

function getPlayerUrl(tag) {
  const normalized = normalizeTag(tag);
  return `https://trustroyale.vercel.app/fr/player/${normalized}`;
}

function formatList(entries, max = 10) {
  if (!entries.length) return "aucun";
  if (entries.length > max) return `${entries.length} membres`;
  return entries
    .map((entry) => {
      const label = entry.name ?? entry.tag ?? "inconnu";
      const url = entry.tag ? getPlayerUrl(entry.tag) : null;
      const link = url ? `[${label}](${url})` : label;
      if (entry.verdict) {
        return `• ${link} — ${entry.verdict}`;
      }
      if (entry.lastSeen) {
        const days = Math.floor(
          (Date.now() - entry.lastSeen.getTime()) / MS_PER_DAY,
        );
        return `• ${link} — ${days}j`;
      }
      return `• ${link}`;
    })
    .join("\n");
}

function formatDelta(current, previous) {
  if (typeof previous !== "number" || Number.isNaN(previous)) return "";
  const diff = current - previous;
  if (diff === 0) return "";
  return diff > 0 ? ` (+${diff})` : ` (${diff})`;
}

function getRankDelta(currentRank, previousRank) {
  if (!Number.isFinite(currentRank) || !Number.isFinite(previousRank))
    return "";
  const delta = currentRank - previousRank;
  if (delta === 0) return "";
  return delta > 0 ? ` (+${delta})` : ` (${delta})`;
}

async function fetchRankingsByLocation(clans) {
  const locationIds = new Set();
  for (const clan of clans) {
    if (clan?.clan?.location?.id) {
      locationIds.add(clan.clan.location.id);
    }
  }

  const rankByLocation = new Map();
  for (const locationId of locationIds) {
    try {
      const rankings = await fetchClanWarRankings(locationId, 500);
      rankByLocation.set(locationId, rankings);
    } catch (err) {
      console.warn(
        `[notifyPreWarSummary] impossible de charger le classement pour location ${locationId} : ${err.message}`,
      );
      rankByLocation.set(locationId, []);
    }
  }
  return rankByLocation;
}

function buildEmbed(clanName, summary, riskValue, inactiveValue) {
  return {
    title: `Résumé pré-GDC pour ${clanName}`,
    color: 0x1f8b4c,
    fields: [
      {
        name: `<:members:1506175789731811399> Membres : ${summary.membersCount}/${MAX_CLAN_SIZE}${summary.membersWarning}${summary.membersDelta}`,
        value: "\u200b",
        inline: false,
      },
      {
        name: `<:key:1514255039764631662> Statut du clan : ${summary.status}`,
        value: "\u200b",
        inline: false,
      },
      {
        name: `<:trophy2:1493677804733337621> Trophées GDC : ${summary.clanWarTrophies}${summary.trophiesDelta}`,
        value: "\u200b",
        inline: false,
      },
      {
        name: `<:stats:1499284927894650950> Classement France : ${summary.rankLabel}${summary.rankDelta}`,
        value: "\u200b",
        inline: false,
      },
      {
        name: `<:warn:1506174837519945800> Fiabilité : ${summary.scoreClan}%${summary.scoreClanDelta}`,
        value: "\u200b",
        inline: false,
      },
      {
        name: `<:sweat:1504139431106576405> À risque :`,
        value: riskValue || "aucun",
        inline: false,
      },
      {
        name: `<:eyeclosed:1504138067580158053> Membres inactifs :`,
        value: inactiveValue || "aucun",
        inline: false,
      },
    ],
  };
}

async function sendDiscordEmbed(channelId, token, embed) {
  if (DRY_RUN) {
    console.log(`\n[dry-run] Embed pour le channel ${channelId}:`);
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
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("Variable manquante: DISCORD_TOKEN");
  }

  const now = new Date();
  const previousLog = await readJson(LOG_FILE, {});
  const clans = [];

  for (const clanTag of CLAN_TAGS) {
    const cache = await readClanCache(clanTag);
    if (!cache || !cache.clan) {
      console.warn(
        `[notifyPreWarSummary] cache manquant pour ${clanTag}, résumé ignoré.`,
      );
      continue;
    }
    clans.push({ clanTag, cache });
  }

  const rankingsByLocation = await fetchRankingsByLocation(
    clans.map((entry) => entry.cache),
  );
  const newLog = { ...previousLog };
  let sentCount = 0;

  for (const { clanTag, cache } of clans) {
    const clan = cache.clan;
    const membersRaw = cache.membersRaw ?? {};
    const memberEntries =
      Array.isArray(cache.members) && cache.members.length > 0
        ? cache.members
        : Object.values(membersRaw);

    const previous = previousLog[clanTag] ?? {};
    const membersCount = Number.isFinite(cache.members)
      ? cache.members
      : memberEntries.length;

    const rawStatus = clan.type === "inviteOnly" ? "inviteOnly" : "open";
    const status = rawStatus === "inviteOnly" ? "fermé" : "ouvert";
    const clanWarTrophies = Number.isFinite(cache.clanWarTrophies)
      ? cache.clanWarTrophies
      : Number.isFinite(clan.clanWarTrophies)
        ? clan.clanWarTrophies
        : 0;

    let rank = null;
    let rankLabel = "inconnu";
    const locationId = clan.location?.id;
    if (locationId) {
      const rankings = rankingsByLocation.get(locationId) ?? [];
      const found = rankings.find(
        (entry) => normalizeTag(entry.tag) === normalizeTag(clan.tag),
      );
      if (found && Number.isFinite(found.rank)) {
        rank = found.rank;
        rankLabel = `#${rank}`;
      }
    }

    const reliabilityScores = memberEntries
      .map((member) => {
        if (Number.isFinite(member.reliability)) return member.reliability;
        const profile = member.profile ?? member;
        const { score } = computeMemberReliability(profile);
        return Number.isFinite(score) ? score : null;
      })
      .filter((score) => score !== null);
    const scoreClan = reliabilityScores.length
      ? Math.round(
          reliabilityScores.reduce((sum, value) => sum + value, 0) /
            reliabilityScores.length,
        )
      : 0;
    const previousScore = Number.isFinite(previous.scoreClan)
      ? previous.scoreClan
      : Number.isFinite(previous.reliabilityPercent)
        ? previous.reliabilityPercent
        : null;

    const riskMembers = getRiskyMembers(memberEntries);
    const inactiveMembers = getInactiveMembers(memberEntries, now);

    const summary = {
      membersCount,
      status,
      clanWarTrophies,
      rank,
      rankLabel,
      scoreClan,
      membersWarning: membersCount <= 45 ? " ⚠️" : "",
      membersDelta: formatDelta(membersCount, previous.membersCount),
      trophiesDelta: formatDelta(clanWarTrophies, previous.clanWarTrophies),
      rankDelta: getRankDelta(rank, previous.rank),
      scoreClanDelta: formatDelta(scoreClan, previousScore),
    };

    const riskValue = formatList(riskMembers, 10);
    const inactiveValue = formatList(inactiveMembers, 10);
    const embed = buildEmbed(clan.name, summary, riskValue, inactiveValue);

    const channelId =
      process.env[`DISCORD_CHANNEL_MEMBERS_${normalizeTag(clanTag)}`];
    if (!channelId) {
      console.warn(
        `[notifyPreWarSummary] channel Discord non configuré pour ${clanTag} (DISCORD_CHANNEL_MEMBERS_${clanTag})`,
      );
      continue;
    }

    await sendDiscordEmbed(channelId, token, embed);
    sentCount += 1;

    newLog[clanTag] = {
      date: now.toISOString(),
      membersCount,
      clanWarTrophies,
      rank: rank ?? null,
      scoreClan,
    };
  }

  await writeJson(LOG_FILE, newLog);
  console.log(
    `notifyPreWarSummary: ${sentCount} message${sentCount > 1 ? "s" : ""} posté${sentCount > 1 ? "s" : ""}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[notifyPreWarSummary] Erreur:", err.message);
    process.exit(1);
  });
}
