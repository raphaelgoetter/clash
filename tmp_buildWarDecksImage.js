import { Resvg } from "@resvg/resvg-js";
async function buildWarDecksImage(warDecks) {
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

  const rows = warDecks.slice(0, 4);
  const cardWidth = 144;
  const cardHeight = 192;
  const cardGap = 8;
  const padding = 20;
  const topLabelHeight = 38;
  const labelSpacing = 6;
  const matchTopSpacing = 12;
  const textLineHeight = 16;
  const deckSpacing = 8;
  const width = padding * 2 + 8 * cardWidth + 7 * cardGap;
  const height =
    padding * 2 +
    topLabelHeight +
    rows.reduce((sum, deck) => {
      const matches = Array.isArray(deck.matches) ? deck.matches : [];
      const matchCount = Math.min(matches.length, 4);
      const matchBlock =
        matchCount > 0 ? matchTopSpacing + matchCount * textLineHeight : 0;
      return sum + cardHeight + labelSpacing + matchBlock + deckSpacing;
    }, 0);

  const uniqueUrls = new Map();
  for (const deck of rows) {
    const ids = Array.isArray(deck.cardIds) ? deck.cardIds : [];
    for (const id of ids) {
      const card = cardById.get(String(id));
      if (card?.iconUrls?.medium) {
        uniqueUrls.set(card.iconUrls.medium, null);
      }
    }
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
      const matchCount = Math.min(matches.length, 4);
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
        const card = cardById.get(String(id));
        const url = card?.iconUrls?.medium
          ? uniqueUrls.get(card.iconUrls.medium)
          : null;
        const x = padding + index * (cardWidth + cardGap);
        return url
          ? `<image x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" href="${url}" preserveAspectRatio="xMidYMid slice"/>`
          : `<rect x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" rx="12" ry="12" fill="#1f2937"/>`;
      })
      .join("");

    const labelY = yStart + cardHeight + 10;
    const matchLines = Array.isArray(deck.matches) ? deck.matches : [];
    const renderedMatchLines = matchLines.slice(0, 4).map((match, index) => {
      const opponentName = escapeText(match.opponentName || "?");
      const towerLevel = Number.isFinite(match.opponentTourLevel)
        ? match.opponentTourLevel
        : "?";
      const score = escapeText(match.score || "?");
      const resultIcon =
        match.result === "win"
          ? "<:success:1499002702208958577>"
          : "<:error:1499002755841265826>";
      const matchup = Number.isFinite(match.matchup)
        ? `${Math.round(match.matchup * 100)}%`
        : "?";
      const line = `- 👥 ${opponentName} <:tower:1515395461140447342> ${towerLevel} ${resultIcon} ${score} ⚡ ${matchup}`;
      const lineY = labelY + 14 + index * textLineHeight;
      return `<text x="${padding}" y="${lineY}" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e2e8f0">${escapeText(line)}</text>`;
    });

    const deckNumber = `#${deckIndex + 1}`;
    return `
      ${cardsSvg}
      <rect x="${padding}" y="${yStart - 42}" width="40" height="28" rx="14" fill="#0ea5e9" />
      <text x="${padding + 20}" y="${yStart - 24}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#ffffff" font-weight="800">${deckNumber}</text>
      ${renderedMatchLines.join("")}
    `;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decks GDC">
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

export { buildWarDecksImage };
