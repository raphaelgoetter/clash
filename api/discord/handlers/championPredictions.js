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
  backfillChampionRegistry,
  resolveClan,
  formatParisDate,
} from "../../../backend/services/championPredictions.js";
import {
  fetchRaceLog,
  fetchClan,
} from "../../../backend/services/clashApi.js";
import {
  computePrevWeekId,
} from "../../../backend/services/dateUtils.js";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const CHAMPION_COLOR = 0x9b59b6;
const CHAMPION_GOLD = 0xf1c40f;

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

function voteBar(votes, maxVotes, width = 12) {
  const filled = maxVotes > 0 ? Math.floor((votes / maxVotes) * width) : 0;
  return "■".repeat(filled) + "□".repeat(width - filled);
}

function topScorerLine(p, idx) {
  return `${ordinal(idx + 1)} **${p.name}** — ${formatFame(p.fame)} pts · ${p.decksUsed} decks`;
}

// ── Commandes ─────────────────────────────────────────────────

export async function handleStart(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const clanResp = await fetchClan(clanTag);
    const clanName = clanResp?.name || resolved.name;

    const raceLog = await fetchRaceLog(clanTag);
    if (!Array.isArray(raceLog) || raceLog.length === 0) {
      await postError(webhookUrl, "Impossible de récupérer le race log du clan.");
      return;
    }

    const prevWeekId = computePrevWeekId(raceLog);
    if (!prevWeekId) {
      await postError(webhookUrl, "Impossible de déterminer la semaine précédente.");
      return;
    }

    const topScorers = await getTopScorers(clanTag, 8);
    if (!Array.isArray(topScorers) || topScorers.length === 0) {
      await postError(webhookUrl, "Aucun participant trouvé pour la semaine précédente.");
      return;
    }

    const { computeCurrentWeekId } = await import("../../../backend/services/dateUtils.js");
    const { fetchCurrentRace } = await import("../../../backend/services/clashApi.js");
    const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
    const targetWeekId = computeCurrentWeekId(currentRace, raceLog) || prevWeekId;

    const now = new Date();
    const endsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    endsAt.setUTCHours(8, 0, 0, 0);
    if (endsAt <= now) {
      endsAt.setUTCDate(endsAt.getUTCDate() + 1);
    }

    const lastRace = raceLog[0];
    const seasonId = lastRace?.seasonId || 0;
    const sectionIndex = lastRace?.sectionIndex || 0;
    const weekId = targetWeekId;

    try {
      await openSession(clanTag, weekId, seasonId, sectionIndex, topScorers, endsAt.toISOString());
    } catch (err) {
      await postError(webhookUrl, err.message);
      return;
    }

    const embed = buildStartEmbed(clanName, prevWeekId, targetWeekId, topScorers, endsAt);
    const selectMenu = buildChallengerSelect(clanTag, weekId, topScorers);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components: [selectMenu] }),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleEnd(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const active = await getActiveSessionByClan(clanTag);
    if (!active) {
      await postError(webhookUrl, "Aucune session de pronostics trouvée pour ce clan.");
      return;
    }

    const { weekId } = active;

    const realChampion = await getRealChampion(clanTag, weekId);
    const result = await closeSessionAndArchive(clanTag, weekId, realChampion);

    const winnerVoters = result.winnerTag
      ? result.session.votes
          .filter((v) => v.challengerTag === result.winnerTag)
          .map((v) => v.discordName)
      : [];

    const embed = buildResultEmbed(
      resolved.name,
      weekId,
      result.session.challengers,
      result.voteResult,
      result.winnerTag,
      result.totalVotes,
      realChampion,
      winnerVoters,
    );

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleCount(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const active = await getActiveSessionByClan(clanTag);
    if (!active) {
      await postError(webhookUrl, `Aucune session de vote en cours pour le clan ${resolved.name}.`);
      return;
    }

    const { weekId } = active;
    const data = await getVoteCounts(clanTag, weekId);
    if (!data) {
      await postError(webhookUrl, `Aucune session de vote en cours pour le clan ${resolved.name}.`);
      return;
    }

    const embed = buildCountEmbed(resolved.name, weekId, data.counts, data.totalVotes, data.session.endsAt);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

export async function handleHistory(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const raceLog = await fetchRaceLog(clanTag).catch(() => null);
    if (Array.isArray(raceLog) && raceLog.length > 0) {
      await backfillChampionRegistry(clanTag, raceLog);
    }

    const history = await getHistory(clanTag, 10);

    if (history.length === 0) {
      await postError(webhookUrl, `Aucun historique de champion pour ${resolved.name}.`);
      return;
    }

    const embed = buildHistoryEmbed(resolved.name, history);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
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
    `Devinez qui sera le **Champion** de la semaine **${targetWeekId}** qui arrive. Tout le monde peut voter !\n`
    + `*Le Champion est le joueur qui marquera le plus de points GDC.*\n\n`
    + `**Challengers** (top 8 scoreurs semaine ${prevWeekId}) :\n`
    + lines.join("\n")
    + `\n${ordinal(9)} **Autre** (pas dans la liste)\n\n`
    + `📅 **Votez jusqu'au ${endParis}**\n`
    + `Sélectionnez votre challenger dans le menu ci-dessous, ou utilisez \`/champion\`.\n`
    + `📌 *Épinglez ce message pour que tout le monde puisse voter facilement.*`;

  return {
    title: `🔮 Pronostics GDC — ${clanName}`,
    color: CHAMPION_COLOR,
    description,
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
            label: `9. Autre (pas dans la liste)`,
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
  realChampions,
  winnerVoters = [],
) {
  // Trouver le nom via les challengers
  const findName = (tag) => {
    if (tag === "__other__") return "Autre";
    const c = challengers.find((ch) => ch.tag === tag);
    return c ? c.name : tag;
  };

  const maxVotes = voteResult.length > 0 ? voteResult[0].votes : 0;
  const lines = voteResult.map((entry, idx) => {
    const name = findName(entry.challengerTag);
    const icon = entry.challengerTag === winnerTag ? " 🏆" : "";
    const votesStr = entry.votes === 1 ? "1 vote" : `${entry.votes} votes`;
    const bar = voteBar(entry.votes, maxVotes);
    return `${ordinal(idx + 1)} ${name} ${icon}\n   ${bar} ${votesStr}`;
  });

  const winnerName = winnerTag ? findName(winnerTag) : "Personne";

  let description = lines.join("\n") + `\n\n`;

  if (totalVotes === 0) {
    description += "😴 Personne n'a voté cette semaine.";
  } else {
    description += `🗳️ **${totalVotes}** vote${totalVotes > 1 ? "s" : ""} au total.\n\n`;
  }

  // Message champion
  if (realChampions && realChampions.length > 0) {
    description += `**Véritable Champion de la semaine ${weekId} :**\n`;
    for (const c of realChampions) {
      description += `🏆 **${c.name}** — ${formatFame(c.fame)} pts\n`;
    }
    description += `\n`;

    const matched = realChampions.some((c) => c.tag === winnerTag);
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
    if (totalVotes > 0) {
      const list = winnerVoters.slice(0, 100).join(", ");
      description += `Vous avez majoritairement voté pour **${winnerName}** : ${list}`;
      if (winnerVoters.length > 100) description += `… (+${winnerVoters.length - 100} autres)`;
    }
    description += `\n`;
  }

  return {
    title: `🔮 Résultat des Pronostics — ${clanName}`,
    color: CHAMPION_GOLD,
    description,
  };
}

function buildCountEmbed(clanName, weekId, counts, totalVotes, endsAt) {
  const sorted = Object.entries(counts)
    .map(([tag, c]) => ({ tag, name: c.name, votes: c.votes }))
    .sort((a, b) => b.votes - a.votes);

  const maxVotes = sorted.length > 0 ? sorted[0].votes : 0;
  const lines = sorted.map((entry, idx) => {
    const votesStr = entry.votes === 1 ? "1 vote" : `${entry.votes} votes`;
    const bar = voteBar(entry.votes, maxVotes);
    return `${ordinal(idx + 1)} **${entry.name}**\n   ${bar} ${votesStr}`;
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
  };
}

function buildHistoryEmbed(clanName, history) {
  const lines = history.map((entry) => {
    const weekLabel = entry.weekId || `S${entry.seasonId}W${entry.sectionIndex + 1}`;
    const champions = entry.champions || (entry.champion ? [entry.champion] : null);
    if (!champions || champions.length === 0) {
      return `**${weekLabel}**\n❓ Champion inconnu`;
    }
    const list = champions
      .map((c) => `🏆 **${c.name}** — ${formatFame(c.fame)} pts`)
      .join("\n");
    return `**${weekLabel}**\n${list}`;
  });

  return {
    title: `📜 Registre des Champions — ${clanName}`,
    color: CHAMPION_COLOR,
    description: lines.join("\n\n") || "Aucun champion enregistré.",
    footer: {
      text: "Les 10 derniers champions",
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
