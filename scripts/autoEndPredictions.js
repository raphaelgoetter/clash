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

  for (const clanTag of FAMILY_CLAN_TAGS) {
    const channelId = getChannelId(clanTag);
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

      if (realChampion) {
        description += `**Véritable Champion de la semaine ${weekId} :**\n`;
        description += `🏆 **${realChampion.name}** — ${formatFame(realChampion.fame)} pts\n\n`;

        if (result.winnerTag === realChampion.tag) {
          description += `🎉 **Les votants ont eu raison !** Le challenger majoritaire était bien le Champion !\n\n`;
          if (winnerVoters.length > 0) {
            description += `Félicitations à :\n`;
            description += winnerVoters.map((name) => `• ${name}`).join("\n");
            description += `\n\n`;
          }
        } else {
          description += `😅 Le challenger majoritaire **${winnerName}** n'était pas le bon cette fois.`;
        }
      } else {
        description += `ℹ️ Le véritable Champion n'a pas encore été déterminé.`;
      }

      const embed = {
        title: `🔮 Résultat des Pronostics — ${clanName}`,
        color: 0xf1c40f,
        description,
        footer: {
          text: `Semaine ${weekId}`,
        },
      };

      if (DRY_RUN) {
        console.log(
          `[${clanTag}] DRY-RUN : message simulé pour ${channelId}`,
        );
        console.log(JSON.stringify({ embeds: [embed] }, null, 2));
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
          body: JSON.stringify({ embeds: [embed] }),
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
