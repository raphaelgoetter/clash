// ============================================================
// championPredictions.js — Handlers Discord pour les pronostics GDC
// Embeds, Select Menu, gestion des interactions
// ============================================================

import {
  getTopScorers,
  castVote,
  getVoteCounts,
  getSessionData,
  getActiveSessionByClan,
  getHistory,
  backfillChampionRegistry,
  resolveClan,
  formatParisDate,
} from "../../../backend/services/championPredictions.js";
import { fetchRaceLog } from "../../../backend/services/clashApi.js";

const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const CHAMPION_COLOR = 0x9b59b6;

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

function voteBar(votes) {
  if (votes === 0) return "";
  const lines = [];
  let remaining = votes;
  while (remaining > 0) {
    lines.push("■".repeat(Math.min(remaining, 12)));
    remaining -= 12;
  }
  return lines.join("\n");
}

function topScorerLine(p, idx) {
  return `${ordinal(idx + 1)} **${p.name}** — ${formatFame(p.fame)} pts · ${p.decksUsed} decks`;
}

// ── Commandes ─────────────────────────────────────────────────

export async function handleCount(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const active = await getActiveSessionByClan(clanTag);
    if (!active) {
      await postError(
        webhookUrl,
        `Aucune session de vote en cours pour le clan ${resolved.name}.`,
      );
      return;
    }

    const { weekId } = active;
    const data = await getVoteCounts(clanTag, weekId);
    if (!data) {
      await postError(
        webhookUrl,
        `Aucune session de vote en cours pour le clan ${resolved.name}.`,
      );
      return;
    }

    const embed = buildCountEmbed(
      resolved.name,
      weekId,
      data.counts,
      data.totalVotes,
      data.session.endsAt,
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

export async function handleHistory(webhookUrl, clanVal) {
  try {
    const resolved = resolveClan(clanVal);
    const clanTag = resolved.tag;

    const raceLog = await fetchRaceLog(clanTag).catch(() => null);
    if (Array.isArray(raceLog) && raceLog.length > 0) {
      await backfillChampionRegistry(clanTag, raceLog);
    }

    const { entries: history, hasMore } = await getHistory(clanTag, 10, 0);

    if (history.length === 0) {
      await postError(
        webhookUrl,
        `Aucun historique de champion pour ${resolved.name}.`,
      );
      return;
    }

    const embed = buildHistoryEmbed(resolved.name, history, { offset: 0 });
    const components = buildHistoryPaginationRow(clanVal, 0, hasMore);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

// Bouton "Précédents" — édite le message existant pour afficher la page
// suivante (semaines plus anciennes) du registre.
export async function handleHistoryPage(originalWebhookUrl, clanVal, offset) {
  if (!originalWebhookUrl) return;
  try {
    const resolved = resolveClan(clanVal);
    const { entries: history, hasMore } = await getHistory(
      resolved.tag,
      10,
      offset,
    );

    if (history.length === 0) {
      await fetch(originalWebhookUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ components: [] }),
      });
      return;
    }

    const embed = buildHistoryEmbed(resolved.name, history, { offset });
    const components = buildHistoryPaginationRow(clanVal, offset, hasMore);

    await fetch(originalWebhookUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    await fetch(originalWebhookUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⚠️ Erreur : ${err.message}` }),
    }).catch(() => {});
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
    const discordName =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    if (!discordId) {
      await postError(
        webhookUrl,
        "Impossible d'identifier votre compte Discord.",
      );
      return;
    }

    await castVote(clanTag, weekId, discordId, discordName, selectedTag);

    // Message éphémère de confirmation
    const sessionData2 = await getSessionData(clanTag, weekId);
    const displayName =
      selectedTag === "__other__"
        ? "Autre (pas dans la liste)"
        : sessionData2?.challengers?.find((c) => c.tag === selectedTag)?.name ||
          selectedTag;
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
      `**Semaine ${weekId}**\n\n` +
      lines.join("\n") +
      `\n\n📊 **${totalVotes}** vote${totalVotes > 1 ? "s" : ""} au total` +
      `\n📅 Vote ouvert jusqu'au ${endParis}`,
  };
}

function buildHistoryEmbed(clanName, history, { offset = 0 } = {}) {
  const lines = history.map((entry) => {
    const weekLabel =
      entry.weekId || `S${entry.seasonId}W${entry.sectionIndex + 1}`;
    const champions =
      entry.champions || (entry.champion ? [entry.champion] : null);
    if (!champions || champions.length === 0) {
      return `**${weekLabel}**\n❓ Champion inconnu`;
    }
    const list = champions
      .map((c) => {
        let line = `🏆 **${c.name}** — ${formatFame(c.fame)} pts`;
        if (c.totalCount >= 3) line += ` · ${"⭐".repeat(c.totalCount)}`;
        if (c.streak >= 2) line += ` · ${"🔥".repeat(c.streak)}`;
        return line;
      })
      .join("\n");
    return `**${weekLabel}**\n${list}`;
  });

  const footerTitle =
    offset === 0 ? "Les 10 derniers champions" : "Champions précédents";

  return {
    title: `📜 Registre des Champions — ${clanName}`,
    color: CHAMPION_COLOR,
    description: lines.join("\n\n") || "Aucun champion enregistré.",
    footer: {
      text: `${footerTitle}\n⭐ nombre de titres (dès 3) · 🔥 semaines consécutives (dès 2)`,
    },
  };
}

function buildHistoryPaginationRow(clanVal, offset, hasMore) {
  const buttons = [];
  if (offset > 0) {
    buttons.push({
      type: 2,
      style: 2,
      label: "↑ Suivants",
      custom_id: `champion_history_page:${clanVal}:${Math.max(0, offset - 10)}`,
    });
  }
  if (hasMore) {
    buttons.push({
      type: 2,
      style: 2,
      label: "↓ Précédents",
      custom_id: `champion_history_page:${clanVal}:${offset + 10}`,
    });
  }
  return buttons.length > 0 ? [{ type: 1, components: buttons }] : [];
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
