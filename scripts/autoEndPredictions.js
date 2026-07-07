#!/usr/bin/env node
// autoEndPredictions.js
// Annonce automatiquement les résultats des pronostics GDC le lundi après-midi.
// Poste le résultat dans chaque channel de clan.
//
// Usage :
//   node scripts/autoEndPredictions.js            — mode normal
//   node scripts/autoEndPredictions.js --dry-run  — sans poster

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

function formatFame(n) {
  return Number.isFinite(n) ? n.toLocaleString("fr-FR") : "0";
}

function ordinal(n) {
  return n + "\u20E3";
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN manquant.");
    process.exit(1);
  }

  const { formatParisDate, computeNextPredictionsStart } = await import(
    "../backend/services/championPredictions.js"
  );
  const nextStart = computeNextPredictionsStart();
  const nextStartText = formatParisDate(nextStart);

  for (const clanTag of FAMILY_CLAN_TAGS) {
    const channelId = resolveMembersChannelId(clanTag, { thread: false });
    if (!channelId) {
      console.warn(`[${clanTag}] Pas de channel configuré, ignoré.`);
      continue;
    }

    const clanName = CLAN_NAMES[clanTag] || clanTag;

    try {
      const {
        getActiveSessionByClan,
        getRealChampion,
        closeSessionAndArchive,
      } = await import("../backend/services/championPredictions.js");

      const active = await getActiveSessionByClan(clanTag);
      if (!active) {
        console.log(`[${clanTag}] Aucune session active.`);
        continue;
      }

      const { weekId, session } = active;

      // Récupérer le vrai champion de la semaine qui vient de se terminer
      const realChampion = await getRealChampion(clanTag, weekId);

      const result = await closeSessionAndArchive(
        clanTag,
        weekId,
        realChampion,
      );

      // Trouver les noms des votants gagnants
      const winnerVoters = result.winnerTag
        ? result.session.votes
            .filter((v) => v.challengerTag === result.winnerTag)
            .map((v) => v.discordName)
        : [];

      // Construire l'embed
      const findName = (tag) => {
        const c = result.session.challengers.find((ch) => ch.tag === tag);
        return c ? c.name : tag;
      };

      const lines = result.voteResult.map((entry, idx) => {
        const name = findName(entry.challengerTag);
        const icon = entry.challengerTag === result.winnerTag ? " 🏆" : "";
        const votesStr =
          entry.votes === 1 ? "1 vote" : `${entry.votes} votes`;
        return `${ordinal(idx + 1)} ${name} ${icon} (${votesStr})`;
      });

      const winnerName = result.winnerTag
        ? findName(result.winnerTag)
        : "Personne";

      let description = lines.join("\n") + `\n\n`;

      if (result.totalVotes === 0) {
        description += "😴 Personne n'a voté cette semaine.\n\n";
      } else {
        description += `🗳️ **${result.totalVotes}** vote${result.totalVotes > 1 ? "s" : ""} au total.\n\n`;
      }

      if (realChampion && realChampion.length > 0) {
        description += `**Véritable Champion de la semaine ${weekId} :**\n`;
        for (const c of realChampion) {
          description += `🏆 **${c.name}** — ${formatFame(c.fame)} pts\n`;
        }
        description += `\n`;

        const matched = realChampion.some((c) => c.tag === result.winnerTag);
        if (matched) {
          description += `🎉 **Les votants ont eu raison !** Le challenger majoritaire était bien le Champion !\n\n`;
          if (winnerVoters.length > 0) {
            const list = winnerVoters.slice(0, 100).join(", ");
            description += `Félicitations à : ${list}`;
            if (winnerVoters.length > 100) description += `… (+${winnerVoters.length - 100} autres)`;
            description += `\n\n`;
          }
        } else {
          description += `😅 Le challenger majoritaire **${winnerName}** n'était pas le bon cette fois.`;
        }
      } else {
        if (result.totalVotes > 0) {
          const list = winnerVoters.slice(0, 100).join(", ");
          description += `Vous avez majoritairement voté pour **${winnerName}** : ${list}`;
          if (winnerVoters.length > 100) description += `… (+${winnerVoters.length - 100} autres)`;
        }
        description += `\n`;
      }

      description += `\n📅 **Prochaine édition : ${nextStartText} !**`;

      const embed = {
        title: `🔮 Résultat des Pronostics — ${clanName}`,
        color: 0xf1c40f,
        description,
        footer: {
          text: `Semaine ${weekId}`,
        },
      };

      // Rôle ping
      const roleId = NO_PING ? null : await getClanRoleId(clanTag);
      const content = roleId ? `<@&${roleId}>` : null;
      const body = { embeds: [embed] };
      if (content) body.content = content;

      if (DRY_RUN) {
        console.log(
          `[${clanTag}] DRY-RUN : message simulé pour ${channelId}`,
        );
        console.log(JSON.stringify(body, null, 2));
        continue;
      }

      console.log(
        `[${clanTag}] Poste le résultat des pronostics dans ${channelId}...`,
      );

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
          `[${clanTag}] Erreur envoi résultat (${msgRes.status}):`,
          errBody,
        );
        continue;
      }

      console.log(`[${clanTag}] Résultat posté ✓`);
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
