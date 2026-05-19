// Source de vérité unique pour les paliers de ligue de Guerre de Clan (GDC).
// Importé par le frontend (frontend/main.js) et le bot Discord (api/discord/interactions.js).
// Ne jamais dupliquer ces seuils ailleurs — modifier ici uniquement.

/**
 * Seuils de trophées de guerre (clanWarTrophies) par palier de ligue GDC.
 * 12 paliers, de Bronze 1 à Légendaire 3.
 */
export const WAR_LEAGUE_THRESHOLDS = [
  { min: 0, max: 199, en: "Bronze 1", fr: "Bronze 1" },
  { min: 200, max: 399, en: "Bronze 2", fr: "Bronze 2" },
  { min: 400, max: 599, en: "Bronze 3", fr: "Bronze 3" },
  { min: 600, max: 899, en: "Silver 1", fr: "Argent 1" },
  { min: 900, max: 1199, en: "Silver 2", fr: "Argent 2" },
  { min: 1200, max: 1499, en: "Silver 3", fr: "Argent 3" },
  { min: 1500, max: 1999, en: "Gold 1", fr: "Or 1" },
  { min: 2000, max: 2499, en: "Gold 2", fr: "Or 2" },
  { min: 2500, max: 2999, en: "Gold 3", fr: "Or 3" },
  { min: 3000, max: 3999, en: "Legendary 1", fr: "Légendaire 1" },
  { min: 4000, max: 4999, en: "Legendary 2", fr: "Légendaire 2" },
  { min: 5000, max: Infinity, en: "Legendary 3", fr: "Légendaire 3" },
];

/**
 * Retourne le nom du palier de ligue GDC pour un nombre de trophées donné.
 * @param {number|null|undefined} trophies - Trophées de guerre du clan (clanWarTrophies)
 * @param {'en'|'fr'} lang - Langue cible (défaut : 'en')
 * @returns {string|null}
 */
export function getLeagueName(trophies, lang = "en") {
  const t = Number(trophies);
  if (trophies == null || Number.isNaN(t)) return null;
  const entry =
    WAR_LEAGUE_THRESHOLDS.find((l) => t >= l.min && t <= l.max) ??
    WAR_LEAGUE_THRESHOLDS[WAR_LEAGUE_THRESHOLDS.length - 1];
  return entry[lang] ?? entry.en;
}
