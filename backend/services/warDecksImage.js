// ============================================================
// warDecksImage.js — Image PNG des decks d'un joueur (une ligne de 8 cartes
// par deck), partagée par /matchup-gdc, /matchup (api/discord/interactions.js)
// et l'Exploit du jour (scripts/notifyWarExploit.js).
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { fetchCards } from "./clashApi.js";
import { getOrSet } from "./cache.js";
import { CARD_ART_OVERRIDES, cardArtUrl, readCardArt } from "./cardArt.js";

const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;
const CARD_ICON_CACHE = new Map();

async function loadCardDefinitions() {
  const { value } = await getOrSet(
    "clashCardDefinitions",
    () => fetchCards(),
    CARD_DEF_CACHE_TTL,
  );
  return Array.isArray(value) ? value : [];
}

// Illustrations de base à l'ancien design côté API : lues directement sur
// Blob (voir backend/services/cardArt.js), y compris pour les icônes de
// battle log mémorisées avant la correction (URL d'origine de l'API).
const BLOB_ICON_PREFIX = "blob:";

async function fetchImageDataUrl(url, signal) {
  if (!url) return null;
  if (CARD_ICON_CACHE.has(url)) return CARD_ICON_CACHE.get(url);

  let fetchUrl = url;
  if (url.startsWith(BLOB_ICON_PREFIX)) {
    const name = url.slice(BLOB_ICON_PREFIX.length);
    try {
      const buffer = await readCardArt(name);
      const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
      CARD_ICON_CACHE.set(url, dataUrl);
      return dataUrl;
    } catch (err) {
      // Sans BLOB_READ_WRITE_TOKEN (scripts GitHub Actions) : repli sur la
      // route publique /api/card-art, même illustration.
      fetchUrl = cardArtUrl(name);
      if (!fetchUrl) {
        console.error("Illustration à jour indisponible :", err?.message || err);
        return null;
      }
    }
  }

  const res = await fetch(fetchUrl, { signal });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/png";
  const dataUrl = `data:${type};base64,${buffer.toString("base64")}`;
  CARD_ICON_CACHE.set(url, dataUrl);
  return dataUrl;
}

export async function buildWarDecksImage(warDecks, { maxRows = 4, kind = "gdc" } = {}) {
  if (!Array.isArray(warDecks) || warDecks.length === 0) return null;
  let cardDefinitions = [];
  try {
    cardDefinitions = await loadCardDefinitions();
  } catch (err) {
    console.error(
      "Impossible de charger les définitions de cartes pour l'image :",
      err?.message || err,
    );
    cardDefinitions = [];
  }
  const cardById = new Map(
    cardDefinitions
      .filter((card) => card && card.id !== undefined)
      .map((card) => [String(card.id), card]),
  );

  const rows = warDecks.slice(0, maxRows);
  const cardWidth = 152;
  const cardHeight = 204;
  const cardGap = 8;
  const padding = 20;
  const topLabelHeight = 0;
  const labelSpacing = 0;
  const matchTopSpacing = 6;
  const textLineHeight = 16;
  const deckSpacing = 0;
  const width = padding * 2 + 8 * cardWidth + 7 * cardGap;
  // Sur /matchup (kind="recent"), les lignes "adversaire/score/matchup%"
  // sont déjà affichées dans la description de l'embed (formatRecentBattlesField)
  // — les omettre ici évite la redondance et garde l'image aussi compacte que
  // possible en hauteur (6 decks empilés sur une image height-bound côté
  // Discord font vite rétrécir les cartes si l'image devient trop haute).
  const showMatchLines = kind !== "recent";
  const height =
    padding * 2 +
    topLabelHeight +
    rows.reduce((sum, deck) => {
      const matches = Array.isArray(deck.matches) ? deck.matches : [];
      const matchCount = showMatchLines ? Math.min(matches.length, 4) : 0;
      const matchBlock =
        matchCount > 0 ? matchTopSpacing + matchCount * textLineHeight : 0;
      return sum + cardHeight + matchBlock + deckSpacing;
    }, 0);

  // Icône de la forme jouée (évolution/héros) mémorisée depuis le battle log
  // (cardIcons, cf. battleCardIconUrl), sinon version normale du catalogue.
  // Version de base à l'illustration périmée côté API : cardArt.js.
  const cardIconUrl = (deck, id, index) => {
    const card = cardById.get(String(id));
    const iconUrl = deck.cardIcons?.[index] ?? card?.iconUrls?.medium ?? null;
    const base = [card?.iconUrls?.medium, card?.iconUrls?.apiMedium];
    return CARD_ART_OVERRIDES.has(card?.name) && base.includes(iconUrl)
      ? `${BLOB_ICON_PREFIX}${card.name}`
      : iconUrl;
  };

  const uniqueUrls = new Map();
  for (const deck of rows) {
    const ids = Array.isArray(deck.cardIds) ? deck.cardIds : [];
    ids.slice(0, 8).forEach((id, index) => {
      const iconUrl = cardIconUrl(deck, id, index);
      if (iconUrl) uniqueUrls.set(iconUrl, null);
    });
  }

  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => abortController.abort(), 9000);
  try {
    await Promise.all(
      [...uniqueUrls.keys()].map(async (url) => {
        try {
          uniqueUrls.set(
            url,
            await fetchImageDataUrl(url, abortController.signal),
          );
        } catch (err) {
          console.error(
            "Impossible de charger l'icône de carte :",
            url,
            err?.message || err,
          );
          uniqueUrls.set(url, null);
        }
      }),
    );
  } catch (err) {
    console.error(
      "Erreur lors de la récupération des images de cartes :",
      err?.message || err,
    );
  } finally {
    clearTimeout(abortTimeout);
  }

  function escapeText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const deckRows = rows.map((deck, deckIndex) => {
    const yStart = rows.slice(0, deckIndex).reduce((sum, prevDeck) => {
      const matches = Array.isArray(prevDeck.matches) ? prevDeck.matches : [];
      const matchCount = showMatchLines ? Math.min(matches.length, 4) : 0;
      return (
        sum +
        cardHeight +
        labelSpacing +
        matchCount * textLineHeight +
        deckSpacing
      );
    }, padding + topLabelHeight);

    const ids = Array.isArray(deck.cardIds) ? deck.cardIds : [];
    const cardsSvg = ids
      .slice(0, 8)
      .map((id, index) => {
        const iconUrl = cardIconUrl(deck, id, index);
        const url = iconUrl ? uniqueUrls.get(iconUrl) : null;
        const x = padding + index * (cardWidth + cardGap);
        return url
          ? `<image x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" href="${url}" preserveAspectRatio="xMidYMid slice"/>`
          : `<rect x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" rx="12" ry="12" fill="#1f2937"/>`;
      })
      .join("");

    const labelY = yStart + cardHeight + 6;
    const matchLines = showMatchLines && Array.isArray(deck.matches)
      ? deck.matches
      : [];
    const renderedMatchLines = matchLines.slice(0, 4).map((match, index) => {
      const opponentName = escapeText(match.opponentName || "?");
      const score = escapeText(match.score || "?");
      const resultIcon =
        match.result === "win"
          ? "<:success:1499002702208958577>"
          : "<:error:1499002755841265826>";
      const matchup = Number.isFinite(match.matchup)
        ? `${Math.round(match.matchup * 100)}%`
        : "?";
      const line = `- 👥 ${opponentName} ${resultIcon} ${score} ⚡ ${matchup}`;
      const lineY = labelY + 12 + index * textLineHeight;
      return `<text x="${padding}" y="${lineY}" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e2e8f0">${escapeText(line)}</text>`;
    });

    return `
      ${cardsSvg}
      ${renderedMatchLines.join("")}
    `;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${kind === "recent" ? "Derniers decks" : "Decks GDC"}">
  <rect width="100%" height="100%" rx="24" fill="#0f172a" />
  ${deckRows.join("")}
</svg>`;

  const svgBuffer = Buffer.from(svg, "utf8");
  try {
    const resvg = new Resvg(svgBuffer, {
      fitTo: { mode: "width", value: width },
      background: "#0f172a",
    });
    const pngData = resvg.render();
    return {
      buffer: Buffer.from(pngData.asPng()),
      mimeType: "image/png",
      filename: "matchup-decks.png",
    };
  } catch (err) {
    console.error("Resvg a échoué pour l'image de deck :", err?.message || err);
    return null;
  }
}
