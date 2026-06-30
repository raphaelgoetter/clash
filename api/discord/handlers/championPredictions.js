// ============================================================
// championPredictions.js — Handlers Discord pour les pronostics GDC
// Embeds, Select Menu, gestion des interactions
// ============================================================

import {
  getTopScorers,
  getRealChampion,
  openSession,
  castVote,
  getVoteCounts,
  getSessionData,
  getActiveSessionByClan,
  closeSessionAndArchive,
  getHistory,
  formatParisDate,
} from "../../../backend/services/championPredictions.js";
import { fetchRaceLog } from "../../../backend/services/clashApi.js";
import {
  computePrevWeekId,
} from "../../../backend/services/dateUtils.js";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const CHAMPION_COLOR = 0x9b59b6;
const CHAMPION_GOLD = 0xf1c40f;

const ALL_CLANS = [
  { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
  { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
  { index: 2, name: "Les Revoltes", tag: "QU9UQJRL" },
];

// ── Helpers ───────────────────────────────────────────────────

function buildWebhookUrl(body) {
  const token = body.token || body.interaction?.token;
  if (!DISCORD_APP_ID || !token) return null;
  return `https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}`;
}

function decodeCustomId(customId) {
  const parts = customId.split(":");
  if (parts.length < 3) return null;
  return { clanTag: parts[1], weekId: parts[2] };
}

function formatFame(n) {
  return Number.isFinite(n) ? n.toLocaleString("fr-FR") : "0";
}

function ordinal(n) {
  return n + "\u20E3";
}

function topScorerLine(p, idx) {
  return `${ordinal(idx + 1)} **${p.name}** — ${formatFame(p.fame)} pts · ${p.decksUsed} decks`;
}

// ── Commandes ─────────────────────────────────────────────────

export async function handleStart(webhookUrl) {
  try {
    const embeds = [];
    const components = [];
    const errors = [];

    for (const clan of ALL_CLANS) {
      const { tag: clanTag, name: clanName } = clan;

      try {
        const raceLog = await fetchRaceLog(clanTag);
        if (!Array.isArray(raceLog) || raceLog.length === 0) {
          errors.push(`${clanName} : race log vide`);
          continue;
        }

        const prevWeekId = computePrevWeekId(raceLog);
        if (!prevWeekId) {
          errors.push(`${clanName} : semaine indéterminable`);
          continue;
        }

        const topScorers = await getTopScorers(clanTag, 5);
        if (!Array.isArray(topScorers) || topScorers.length === 0) {
          errors.push(`${clanName} : aucun top scoreur`);
          continue;
        }

        const { computeCurrentWeekId } = await import("../../../backend/services/dateUtils.js");
        const { fetchCurrentRace } = await import("../../../backend/services/clashApi.js");
        const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
        const targetWeekId = computeCurrentWeekId(currentRace, raceLog) || prevWeekId;

        const now = new Date();
        const endsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
        endsAt.setUTCHours(10, 0, 0, 0);
        if (endsAt <= now) {
          endsAt.setUTCDate(endsAt.getUTCDate() + 1);
        }

        const lastRace = raceLog[0];
        const seasonId = lastRace?.seasonId || 0;
        const sectionIndex = lastRace?.sectionIndex || 0;
        const weekId = targetWeekId;

        await openSession(clanTag, weekId, seasonId, sectionIndex, topScorers, endsAt.toISOString());

        embeds.push(buildStartEmbed(clanName, prevWeekId, targetWeekId, topScorers, endsAt));
        components.push(buildChallengerSelect(clanTag, weekId, topScorers));
      } catch (err) {
        errors.push(`${clanName} : ${err.message}`);
      }
    }

    const body = { embeds };
    if (components.length > 0) body.components = components;
    if (errors.length > 0) body.content = `⚠️ Erreurs partielles :\n${errors.join("\n")}`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleEnd(webhookUrl) {
  try {
    const embeds = [];
    const errors = [];

    for (const clan of ALL_CLANS) {
      const { tag: clanTag, name: clanName } = clan;

      try {
        const active = await getActiveSessionByClan(clanTag);
        if (!active) {
          errors.push(`${clanName} : aucune session active`);
          continue;
        }

        const { weekId } = active;
        const realChampion = await getRealChampion(clanTag);
        const result = await closeSessionAndArchive(clanTag, weekId, realChampion);

        const winnerVoters = result.winnerTag
          ? result.session.votes
              .filter((v) => v.challengerTag === result.winnerTag)
              .map((v) => v.discordName)
          : [];

        embeds.push(buildResultEmbed(
          clanName,
          weekId,
          result.session.challengers,
          result.voteResult,
          result.winnerTag,
          result.totalVotes,
          realChampion,
          winnerVoters,
        ));
      } catch (err) {
        errors.push(`${clanName} : ${err.message}`);
      }
    }

    const body = { embeds };
    if (errors.length > 0) body.content = `⚠️ Erreurs partielles :\n${errors.join("\n")}`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleCount(webhookUrl) {
  try {
    const embeds = [];
    const errors = [];

    for (const clan of ALL_CLANS) {
      const { tag: clanTag, name: clanName } = clan;

      try {
        const active = await getActiveSessionByClan(clanTag);
        if (!active) {
          continue; // pas d'erreur, juste pas de session
        }

        const { weekId } = active;
        const data = await getVoteCounts(clanTag, weekId);
        if (!data) {
          continue;
        }

        embeds.push(buildCountEmbed(clanName, weekId, data.counts, data.totalVotes, data.session.endsAt));
      } catch (err) {
        errors.push(`${clanName} : ${err.message}`);
      }
    }

    if (embeds.length === 0) {
      await postError(webhookUrl, "Aucune session de vote en cours.");
      return;
    }

    const body = { embeds };
    if (errors.length > 0) body.content = `⚠️ Erreurs :\n${errors.join("\n")}`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleHistory(webhookUrl) {
  try {
    const embeds = [];
    const errors = [];

    for (const clan of ALL_CLANS) {
      const { tag: clanTag, name: clanName } = clan;

      try {
        const history = await getHistory(clanTag, 10);
        if (history.length === 0) continue;

        embeds.push(buildHistoryEmbed(clanName, history));
      } catch (err) {
        errors.push(`${clanName} : ${err.message}`);
      }
    }

    if (embeds.length === 0) {
      await postError(webhookUrl, "Aucun historique de champion pour les 3 clans.");
      return;
    }

    const body = { embeds };
    if (errors.length > 0) body.content = `⚠️ Erreurs :\n${errors.join("\n")}`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

// ── Select Menu Interaction ───────────────────────────────────

export async function handleSelectInteraction(webhookUrl, body) {
  try {
    const decoded = decodeCustomId(body.data?.custom_id);
    if (!decoded) {
      await postError(webhookUrl, "Interaction invalide.");
      return;
    }

    const { clanTag, weekId } = decoded;
    const selectedTag = body.data.values?.[0];
    if (!selectedTag) {
      await postError(webhookUrl, "Aucun challenger sélectionné.");
      return;
    }

    const discordId = body.member?.user?.id;
    const discordName = body.member?.user?.username || "Inconnu";
    if (!discordId) {
      await postError(webhookUrl, "Impossible d'identifier votre compte Discord.");
      return;
    }

    await castVote(clanTag, weekId, discordId, discordName, selectedTag);

    // Message éphémère de confirmation
    const sessionData2 = await getSessionData(clanTag, weekId);
    const displayName = selectedTag === "__other__"
      ? "Autre (pas dans la liste)"
      : (sessionData2?.challengers?.find((c) => c.tag === selectedTag)?.name || selectedTag);
    const msg = `Votre vote pour **${displayName}** est enregistré ! ✓`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: msg, flags: 64 }),
    });
  } catch (err) {
    await postError(webhookUrl, err.message);
  }
}

// ── Constructeurs d'embed ─────────────────────────────────────

function buildStartEmbed(clanName, prevWeekId, targetWeekId, topScorers, endsAt) {
  const lines = topScorers.map((p, idx) =>
    `${ordinal(idx + 1)} **${p.name}** — ${formatFame(p.fame)} pts`,
  );

  const endParis = formatParisDate(endsAt);

  const description =
    `Devinez qui sera le **Champion** de la semaine **${targetWeekId}** qui arrive !\n`
    + `*Le Champion est le joueur qui marquera le plus de points GDC.*\n\n`
    + `**Challengers** (top 5 scoreurs semaine ${prevWeekId}) :\n`
    + lines.join("\n")
    + `\n\n`
    + `📅 **Votez jusqu'au ${endParis}**\n`
    + `Sélectionnez votre challenger dans le menu ci-dessous, ou utilisez \`/champion\`.\n`
    + `📌 *Épinglez ce message pour que tout le monde puisse voter facilement.*`;

  return {
    title: `🔮 Pronostics GDC — ${clanName}`,
    color: CHAMPION_COLOR,
    description,
    footer: {
      text: `Clan : ${clanName} · Devinez le prochain champion`,
    },
  };
}

function buildChallengerSelect(clanTag, weekId, topScorers) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `champion_vote:${clanTag}:${weekId}`,
        placeholder: "Choisissez votre challenger...",
        options: [
          ...topScorers.map((p, idx) => ({
            label: `${idx + 1}. ${p.name}`,
            value: p.tag,
            description: `${formatFame(p.fame)} pts · ${p.decksUsed} decks`,
          })),
          {
            label: `6. Autre (pas dans la liste)`,
            value: "__other__",
            description: "Vote pour un joueur différent",
          },
        ],
      },
    ],
  };
}

function buildResultEmbed(
  clanName,
  weekId,
  challengers,
  voteResult,
  winnerTag,
  totalVotes,
  realChampion,
  winnerVoters = [],
) {
  // Trouver le nom via les challengers
  const findName = (tag) => {
    if (tag === "__other__") return "Autre";
    const c = challengers.find((ch) => ch.tag === tag);
    return c ? c.name : tag;
  };

  const lines = voteResult.map((entry, idx) => {
    const name = findName(entry.challengerTag);
    const icon = entry.challengerTag === winnerTag ? " 🏆" : "";
    const votesStr = entry.votes === 1 ? "1 vote" : `${entry.votes} votes`;
    return `${ordinal(idx + 1)} ${name} ${icon} (${votesStr})`;
  });

  const winnerName = winnerTag ? findName(winnerTag) : "Personne";

  let description = lines.join("\n") + `\n\n`;

  if (totalVotes === 0) {
    description += "😴 Personne n'a voté cette semaine.";
  } else {
    description += `🗳️ **${totalVotes}** vote${totalVotes > 1 ? "s" : ""} au total.\n\n`;
  }

  // Message champion
  if (realChampion) {
    description += `**Véritable Champion de la semaine ${weekId} :**\n`;
    description += `🏆 **${realChampion.name}** — ${formatFame(realChampion.fame)} pts\n\n`;

    if (winnerTag === realChampion.tag) {
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
    description += `ℹ️ Le véritable Champion n'a pas encore été déterminé (GDC peut-être en cours).`;
  }

  return {
    title: `🔮 Résultat des Pronostics — ${clanName}`,
    url: realChampion ? undefined : undefined,
    color: CHAMPION_GOLD,
    description,
    footer: {
      text: `Semaine ${weekId}`,
    },
  };
}

function buildCountEmbed(clanName, weekId, counts, totalVotes, endsAt) {
  const sorted = Object.entries(counts)
    .map(([tag, c]) => ({ tag, name: c.name, votes: c.votes }))
    .sort((a, b) => b.votes - a.votes);

  const lines = sorted.map((entry, idx) => {
    const votesStr = entry.votes === 1 ? "1 vote" : `${entry.votes} votes`;
    return `${ordinal(idx + 1)} **${entry.name}** — ${votesStr}`;
  });

  const endParis = formatParisDate(new Date(endsAt));

  return {
    title: `🗳️ Pronostics en cours — ${clanName}`,
    color: CHAMPION_COLOR,
    description:
      `**Semaine ${weekId}**\n\n`
      + lines.join("\n")
      + `\n\n📊 **${totalVotes}** vote${totalVotes > 1 ? "s" : ""} au total`
      + `\n📅 Vote ouvert jusqu'au ${endParis}`,
    footer: {
      text: `Utilisez le menu déroulant ou /champion pour voter`,
    },
  };
}

function buildHistoryEmbed(clanName, history) {
  const lines = history.map((entry) => {
    const weekLabel = entry.weekId || `S${entry.seasonId}W${entry.sectionIndex + 1}`;
    const champion = entry.realChampion
      ? `🏆 **${entry.realChampion.name}** — ${formatFame(entry.realChampion.fame)} pts`
      : "❓ Champion inconnu";
    const votes = `${entry.totalVotes || 0} vote${entry.totalVotes !== 1 ? "s" : ""}`;

    // Trouver le challenger gagnant
    const winnerChallenger = entry.challengers?.find(
      (c) => c.tag === entry.winnerChallengerTag,
    );
    const winnerStr = winnerChallenger
      ? `🔮 Majorité : ${winnerChallenger.name}`
      : "🔮 Aucun vote";

    return `**${weekLabel}**\n${champion}\n${winnerStr} · ${votes}`;
  });

  return {
    title: `📜 Historique des Champions — ${clanName}`,
    color: CHAMPION_COLOR,
    description: lines.join("\n\n") || "Aucun historique pour le moment.",
    footer: {
      text: "Les 10 dernières entrées",
    },
  };
}

// ── Erreur ────────────────────────────────────────────────────

async function postError(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⚠️ ${message}`, flags: 64 }),
    });
  } catch {
    // silence
  }
}
