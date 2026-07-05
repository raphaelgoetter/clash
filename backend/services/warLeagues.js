// Source de vérité unique pour les paliers de ligue de Guerre de Clan (GDC).
// Importé par le frontend (frontend/main.js) et le bot Discord (api/discord/interactions.js).
// Ne jamais dupliquer ces seuils ailleurs — modifier ici uniquement.

/**
 * Seuils de trophées de guerre (clanWarTrophies) par palier de ligue GDC.
 * 12 paliers, de Bronze 1 à Légendaire 3.
 */
export const WAR_LEAGUE_THRESHOLDS = [
  { min: 0, max: 199, name: "Bronze 1" },
  { min: 200, max: 399, name: "Bronze 2" },
  { min: 400, max: 599, name: "Bronze 3" },
  { min: 600, max: 899, name: "Argent 1" },
  { min: 900, max: 1199, name: "Argent 2" },
  { min: 1200, max: 1499, name: "Argent 3" },
  { min: 1500, max: 1999, name: "Or 1" },
  { min: 2000, max: 2499, name: "Or 2" },
  { min: 2500, max: 2999, name: "Or 3" },
  { min: 3000, max: 3999, name: "Légendaire 1" },
  { min: 4000, max: 4999, name: "Légendaire 2" },
  { min: 5000, max: Infinity, name: "Légendaire 3" },
];

/**
 * Retourne le nom du palier de ligue GDC pour un nombre de trophées donné.
 * @param {number|null|undefined} trophies - Trophées de guerre du clan (clanWarTrophies)
 * @returns {string|null}
 */
export function getLeagueName(trophies) {
  const t = Number(trophies);
  if (trophies == null || Number.isNaN(t)) return null;
  const entry =
    WAR_LEAGUE_THRESHOLDS.find((l) => t >= l.min && t <= l.max) ??
    WAR_LEAGUE_THRESHOLDS[WAR_LEAGUE_THRESHOLDS.length - 1];
  return entry.name;
}
