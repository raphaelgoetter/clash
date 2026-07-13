#!/usr/bin/env node
// autoStartPredictions.js
// Post automatiquement les pronostics GDC le mardi matin dans chaque channel
// de clan. Le message peut être épinglé manuellement.
//
// Usage :
//   node scripts/autoStartPredictions.js            — mode normal
//   node scripts/autoStartPredictions.js --dry-run  — sans poster

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fetch from "node-fetch";
import { FAMILY_CLAN_TAGS } from "../backend/services/warHistory.js";
import { resolveMembersChannelId } from "../backend/services/discordChannels.js";

const CLAN_NAMES = {
  Y8JUPC9C: "La Resistance",
  LRQP20V9: "Les Resistants",
  QU9UQJRL: "Les Revoltes",
};

const CLAN_ROLE_NAMES = {
  Y8JUPC9C: "LA RESISTANCE ★",
  LRQP20V9: "LES RESISTANTS ★",
  QU9UQJRL: "LES REVOLTES ★",
};

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DRY_RUN = process.argv.includes("--dry-run");
const NO_PING = process.argv.includes("--no-ping");

const ROLE_CACHE = new Map();
let roleCacheLoaded = false;

function normalizeRoleName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getClanRoleId(clanTag) {
  const roleName = CLAN_ROLE_NAMES[clanTag];
  if (!roleName || !DISCORD_GUILD_ID) return null;

  const cacheKey = `roles:${DISCORD_GUILD_ID}`;
  if (!ROLE_CACHE.has(cacheKey)) {
    try {
      const token = process.env.DISCORD_TOKEN;
      const res = await fetch(`${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/roles`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) {
        console.warn(`Impossible de récupérer les rôles (${res.status})`);
        ROLE_CACHE.set(cacheKey, []);
      } else {
        const roles = await res.json();
        ROLE_CACHE.set(cacheKey, Array.isArray(roles) ? roles : []);
      }
    } catch (err) {
      console.warn(`Erreur rôles:`, err.message);
      ROLE_CACHE.set(cacheKey, []);
    }
  }

  const roles = ROLE_CACHE.get(cacheKey);
  const role = roles.find(
    (r) => normalizeRoleName(r?.name) === normalizeRoleName(roleName),
  );
  return role?.id ?? null;
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN manquant.");
    process.exit(1);
  }

  for (const clanTag of FAMILY_CLAN_TAGS) {
    const channelId = resolveMembersChannelId(clanTag, { thread: false });
    if (!channelId) {
      console.warn(`[${clanTag}] Pas de channel configuré, ignoré.`);
      continue;
    }

    const clanName = CLAN_NAMES[clanTag] || clanTag;

    try {
      const { getTopScorers, openSession, formatParisDate } =
        await import("../backend/services/championPredictions.js");
      const { fetchRaceLog } =
        await import("../backend/services/clashApi.js");
      const { computePrevWeekId, computeCurrentWeekId, parseWeekId } =
        await import("../backend/services/dateUtils.js");

      const raceLog = await fetchRaceLog(clanTag);
      if (!Array.isArray(raceLog) || raceLog.length === 0) {
        console.warn(`[${clanTag}] Race log vide, ignoré.`);
        continue;
      }

      const prevWeekId = computePrevWeekId(raceLog);
      if (!prevWeekId) {
        console.warn(`[${clanTag}] Impossible de déterminer la semaine.`);
        continue;
      }

      const topScorers = await getTopScorers(clanTag, 8);
      if (topScorers.length === 0) {
        console.warn(`[${clanTag}] Aucun top scoreur trouvé.`);
        continue;
      }

      const { fetchCurrentRace } =
        await import("../backend/services/clashApi.js");
      const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
      const targetWeekId =
        computeCurrentWeekId(currentRace, raceLog) || prevWeekId;

      // Session : 2 jours (mardi 10h UTC → jeudi 10h UTC)
      const now = new Date();
      const endsAt = new Date(now);
      endsAt.setUTCHours(8, 0, 0, 0);
      if (endsAt <= now) {
        endsAt.setUTCDate(endsAt.getUTCDate() + 2);
      } else {
        endsAt.setUTCDate(endsAt.getUTCDate() + 2);
      }

      const lastRace = raceLog[0];
      const { seasonId, sectionIndex } = parseWeekId(targetWeekId) ?? {
        seasonId: lastRace?.seasonId || 0,
        sectionIndex: lastRace?.sectionIndex || 0,
      };

      await openSession(
        clanTag,
        targetWeekId,
        seasonId,
        sectionIndex,
        topScorers,
        endsAt.toISOString(),
      );

      // Construire l'embed
      const ordinal = (n) => n + "\u20E3";
      const formatFame = (n) =>
        Number.isFinite(n) ? n.toLocaleString("fr-FR") : "0";

      const lines = topScorers.map(
        (p, idx) =>
          `${ordinal(idx + 1)} **${p.name}** — ${formatFame(p.fame)} pts`,
      );

      const endParis = formatParisDate(endsAt);

      const embed = {
        title: `🔮 Pronostics GDC — ${clanName}`,
        color: 0x9b59b6,
        description:
          `Devinez qui sera le **Champion** de la semaine **${targetWeekId}** qui arrive. Tout le monde peut voter !\n` +
          `*Le Champion est le joueur qui marquera le plus de points GDC.*\n\n` +
          `**Challengers** (top 8 scoreurs semaine ${prevWeekId}) :\n` +
          lines.join("\n") +
          `\n${ordinal(9)} **Autre** (pas dans la liste)\n\n` +
          `📅 **Votez jusqu'au ${endParis}**\n` +
          `Sélectionnez votre challenger dans le menu ci-dessous.\n` +
          `📌 *Épinglez ce message pour que tout le monde puisse voter facilement.*`,
        footer: {
          text: `Clan : ${clanName} · Devinez le prochain champion`,
        },
      };

      const selectMenu = {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `champion_vote:${clanTag}:${targetWeekId}`,
            placeholder: "Choisissez votre challenger...",
            options: [
              ...topScorers.map((p, idx) => ({
                label: `${idx + 1}. ${p.name}`,
                value: p.tag,
                description: `${formatFame(p.fame)} pts · ${p.decksUsed} decks`,
              })),
              {
                label: `9. Autre (pas dans la liste)`,
                value: "__other__",
                description: "Vote pour un joueur différent",
              },
            ],
          },
        ],
      };

      // Rôle ping
      const roleId = NO_PING ? null : await getClanRoleId(clanTag);
      const content = roleId ? `<@&${roleId}>` : null;
      const body = { embeds: [embed], components: [selectMenu] };
      if (content) body.content = content;

      if (DRY_RUN) {
        console.log(
          `[${clanTag}] DRY-RUN : message simulé pour ${channelId}`,
        );
        console.log(JSON.stringify(body, null, 2));
        continue;
      }
      console.log(`[${clanTag}] Poste les pronostics dans ${channelId}...`);

      // Poster le message
      const msgRes = await fetch(
        `${DISCORD_API}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!msgRes.ok) {
        const errBody = await msgRes.text();
        console.error(
          `[${clanTag}] Erreur envoi message (${msgRes.status}):`,
          errBody,
        );
        continue;
      }

      console.log(`[${clanTag}] Pronostics postés ✓`);
    } catch (err) {
      console.error(`[${clanTag}] Erreur:`, err.message);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Erreur fatale:", err);
    process.exit(1);
  });
}
