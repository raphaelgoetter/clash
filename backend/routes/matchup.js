// ============================================================
// routes/matchup.js — Catalogue public de win conditions/counters
// pour la page web /matchup. Source de vérité unique :
// data/clash-royale-matchup-catalog.json (via getWinConditionsCatalog,
// hot-reload sans redéploiement).
// ============================================================

import { Router } from "express";
import { fetchCards } from "../services/clashApi.js";
import { getWinConditionsCatalog } from "../services/matchupCatalog.js";
import { getOrSet } from "../services/cache.js";

const router = Router();
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;

async function loadCardByNormalizedName(normalizeCardName) {
  try {
    const { value: cards } = await getOrSet(
      "clashCardDefinitions",
      () => fetchCards(),
      CARD_DEF_CACHE_TTL,
    );
    const map = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
      if (card?.name) map.set(normalizeCardName(card.name), card);
    }
    return map;
  } catch (err) {
    console.error(
      "Impossible de charger les définitions de cartes :",
      err?.message || err,
    );
    return new Map();
  }
}

router.get("/catalog", async (req, res) => {
  try {
    const { winConditionsByName, normalizeCardName } =
      await getWinConditionsCatalog();
    const cardByNormalizedName = await loadCardByNormalizedName(
      normalizeCardName,
    );

    const buildIcon = (name) => {
      const card = cardByNormalizedName.get(normalizeCardName(name));
      return card
        ? { url: card.iconUrls?.medium ?? null, rarity: card.rarity ?? null }
        : { url: null, rarity: null };
    };

    const winConditions = [...winConditionsByName.values()]
      .map((wc) => ({
        name: wc.name,
        archetype: wc.archetype,
        icon: buildIcon(wc.name),
        hardCounters: wc.hardCounters.map((name) => ({
          name,
          icon: buildIcon(name),
        })),
        softCounters: wc.softCounters.map((name) => ({
          name,
          icon: buildIcon(name),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ winConditions });
  } catch (err) {
    console.error("Erreur /api/matchup/catalog :", err?.message || err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
