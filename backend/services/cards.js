// ============================================================
// cards.js — Catalogue des cartes jouables pour les jeux de draft (Draft
// Royale, jeu spécial, et Draft, duel à la demande) : filtrage de
// data/cardNames.json et résolution d'une clé en carte affichable. Aucune
// I/O ici, le catalogue brut est passé en paramètre.
// ============================================================

export const TYPES = ["troop", "flying", "spell", "building"];
export const RARITIES = ["common", "rare", "epic", "legendary", "champion"];

// Cartes exclues : coût variable (Miroir) ou nature ambiguë troupe/sort,
// volante/au sol (Impératrice spirituelle)
export const EXCLUDED_CARDS = new Set(["Mirror", "Spirit Empress"]);

// Garde les cartes jouables du catalogue brut (coût, type et rareté connus).
export function filterCardPool(allCards) {
  return allCards.filter(
    (c) => !EXCLUDED_CARDS.has(c.cardKey) && c.elixir != null && TYPES.includes(c.type) && RARITIES.includes(c.rarity),
  );
}

// Carte affichable (cardImage.js) : `minBid` porte le coût affiché dans la
// goutte d'élixir. `catalog` : Map cardKey → entrée de cardNames.json.
export function resolveCard(key, catalog) {
  const c = catalog.get(key);
  if (!c) return null;
  return {
    key,
    fr: c.fr || c.cardKey,
    minBid: c.elixir,
    elixir: c.elixir,
    rarity: c.rarity,
    type: c.type,
    family: c.family ?? null,
  };
}
