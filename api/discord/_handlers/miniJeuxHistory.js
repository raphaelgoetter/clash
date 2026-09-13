// ============================================================
// miniJeuxHistory.js — Handler Discord pour /mini-jeux-history
// Visuel calqué sur le registre des Champions GDC (championPredictions.js) :
// embed paginé, un bloc par saison, pagination par boutons.
// ============================================================

import { getSeasonWinnersHistory } from "../../../backend/services/miniJeuxHistory.js";

const MINIJEUX_COLOR = 0x5865f2; // même couleur que /mini-jeux, cohérence visuelle
const PAGE_SIZE = 6;

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function formatSeasonLabel(start) {
  return `${MOIS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
}

function formatDateShort(d) {
  return `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
}

// ── Commande ──────────────────────────────────────────────────

export async function handleMiniJeuxHistory(webhookUrl) {
  try {
    const seasons = await getSeasonWinnersHistory();

    if (seasons.length === 0) {
      await postError(
        webhookUrl,
        "Aucun historique de saison mini-jeux pour l'instant.",
      );
      return;
    }

    const embed = buildHistoryEmbed(seasons, 0);
    const components = buildHistoryPaginationRow(0, seasons.length);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    await postError(webhookUrl, `Erreur : ${err.message}`);
  }
}

// Bouton "Précédentes" — édite le message existant pour afficher la page
// suivante (saisons plus anciennes).
export async function handleMiniJeuxHistoryPage(originalWebhookUrl, offset) {
  if (!originalWebhookUrl) return;
  try {
    const seasons = await getSeasonWinnersHistory();

    const embed = buildHistoryEmbed(seasons, offset);
    const components = buildHistoryPaginationRow(offset, seasons.length);

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

function buildHistoryEmbed(seasons, offset) {
  const page = seasons.slice(offset, offset + PAGE_SIZE);

  const blocks = page.map((season) => {
    const label =
      `**${formatSeasonLabel(season.start)}**` +
      ` (${formatDateShort(season.start)} → ${formatDateShort(season.end)})`;
    const lines = season.games.map((g) => {
      const names = g.winners.map((w) => `**${w.name}**`).join(" / ");
      return `${g.label} — 🏆 ${names}`;
    });
    return `${label}\n${lines.join("\n")}`;
  });

  const footerTitle =
    offset === 0 ? "Les dernières saisons mini-jeux" : "Saisons précédentes";

  return {
    title: "📜 Historique des vainqueurs — Mini-jeux",
    color: MINIJEUX_COLOR,
    description: blocks.join("\n\n") || "Aucun historique.",
    footer: {
      text:
        `${footerTitle}\n` +
        "🏆 score cumulé sur la saison (nombre de manches gagnées pour Mario Clash)",
    },
  };
}

function buildHistoryPaginationRow(offset, total) {
  const buttons = [];
  if (offset > 0) {
    buttons.push({
      type: 2,
      style: 2,
      label: "↑ Suivantes",
      custom_id: `minijeux_history_page:${Math.max(0, offset - PAGE_SIZE)}`,
    });
  }
  if (offset + PAGE_SIZE < total) {
    buttons.push({
      type: 2,
      style: 2,
      label: "↓ Précédentes",
      custom_id: `minijeux_history_page:${offset + PAGE_SIZE}`,
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
