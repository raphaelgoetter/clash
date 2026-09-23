// ============================================================
// championHistory.js — Handler Discord pour `/champion-history` : registre
// des champions GDC passés d'un clan (vrais champions, pas des pronostics).
// Voir backend/services/championHistory.js pour l'historique de la
// restauration.
// ============================================================

import {
  getHistory,
  backfillChampionRegistry,
  resolveClan,
} from "../../../backend/services/championHistory.js";
import { fetchRaceLog } from "../../../backend/services/clashApi.js";
import { toPublicWeekId } from "../../../backend/services/dateUtils.js";

const CHAMPION_COLOR = 0x9b59b6;

function formatFame(n) {
  return Number.isFinite(n) ? n.toLocaleString("fr-FR") : "0";
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

// ── Constructeurs d'embed ─────────────────────────────────────

function buildHistoryEmbed(clanName, history, { offset = 0 } = {}) {
  const lines = history.map((entry) => {
    const weekLabel = toPublicWeekId(
      entry.weekId || `S${entry.seasonId}W${entry.sectionIndex + 1}`,
    );
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
