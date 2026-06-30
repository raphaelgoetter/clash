#!/usr/bin/env node
// autoStartPredictions.js
// Post automatiquement les pronostics GDC le mardi matin dans chaque channel
// de clan. Utilise le token Bot Discord pour poster et épingler.
//
// Usage :
//   node scripts/autoStartPredictions.js            — mode normal
//   node scripts/autoStartPredictions.js --dry-run  — sans poster

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fetch from "node-fetch";
import { FAMILY_CLAN_TAGS } from "../backend/services/warHistory.js";

const CLAN_NAMES = {
  Y8JUPC9C: "La Resistance",
  LRQP20V9: "Les Resistants",
  QU9UQJRL: "Les Revoltes",
};

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");

function getChannelId(clanTag) {
  return process.env[`DISCORD_CHANNEL_MEMBERS_${clanTag}`];
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN manquant.");
    process.exit(1);
  }

  for (const clanTag of FAMILY_CLAN_TAGS) {
    const channelId = getChannelId(clanTag);
    if (!channelId) {
      console.warn(`[${clanTag}] Pas de channel configuré, ignoré.`);
      continue;
    }

    const clanName = CLAN_NAMES[clanTag] || clanTag;

    try {
      const { getTopScorers, openSession, resolveClan, formatParisDate } =
        await import("../backend/services/championPredictions.js");
      const { fetchRaceLog, fetchClan } =
        await import("../backend/services/clashApi.js");
      const { computePrevWeekId, computeCurrentWeekId } =
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

      const topScorers = await getTopScorers(clanTag, 5);
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
      endsAt.setUTCHours(10, 0, 0, 0);
      if (endsAt <= now) {
        endsAt.setUTCDate(endsAt.getUTCDate() + 2);
      } else {
        endsAt.setUTCDate(endsAt.getUTCDate() + 2);
      }

      // Vérifier si une session existe déjà
      const { getActiveSessionByClan } = await import(
        "../backend/services/championPredictions.js"
      );
      const existing = await getActiveSessionByClan(clanTag);
      if (existing) {
        console.log(
          `[${clanTag}] Session déjà active (${existing.weekId}), ignoré.`,
        );
        continue;
      }

      const lastRace = raceLog[0];
      const seasonId = lastRace?.seasonId || 0;
      const sectionIndex = lastRace?.sectionIndex || 0;

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
          `Devinez qui sera le **Champion** de la semaine **${targetWeekId}** qui arrive !\n` +
          `*Le Champion est le joueur qui marquera le plus de points GDC.*\n\n` +
          `**Challengers** (top 5 scoreurs semaine ${prevWeekId}) :\n` +
          lines.join("\n") +
          `\n\n` +
          `📅 **Votez jusqu'au ${endParis}**\n` +
          `Sélectionnez votre challenger dans le menu ci-dessous.`,
        footer: {
          text: `Clan : ${clanName} · Semaine ${targetWeekId}`,
        },
      };

      const selectMenu = {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `champion_vote:${clanTag}:${targetWeekId}`,
            placeholder: "Choisissez votre challenger...",
            options: topScorers.map((p, idx) => ({
              label: `${idx + 1}. ${p.name}`,
              value: p.tag,
              description: `${formatFame(p.fame)} pts · ${p.decksUsed} decks`,
            })),
          },
        ],
      };

      if (DRY_RUN) {
        console.log(
          `[${clanTag}] DRY-RUN : message simulé pour ${channelId}`,
        );
        console.log(JSON.stringify({ embeds: [embed], components: [selectMenu] }, null, 2));
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
          body: JSON.stringify({
            embeds: [embed],
            components: [selectMenu],
          }),
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

      const msgData = await msgRes.json();
      const messageId = msgData.id;

      // Épingler le message
      const pinRes = await fetch(
        `${DISCORD_API}/channels/${channelId}/pins/${messageId}`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${token}` },
        },
      );

      if (!pinRes.ok && pinRes.status !== 204) {
        // 204 = No Content (succès)
        const errBody = await pinRes.text();
        console.warn(
          `[${clanTag}] Épinglage ignoré (${pinRes.status}):`,
          errBody,
        );
      } else {
        console.log(`[${clanTag}] Message épinglé ✓`);
      }

      console.log(`[${clanTag}] Pronostics postés ✓`);
    } catch (err) {
      console.error(`[${clanTag}] Erreur:`, err.message);
    }
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
