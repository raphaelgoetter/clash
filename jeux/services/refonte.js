// ============================================================
// refonte.js — Bascule des 4 groupes de mini-jeux hebdomadaires vers leurs
// nouvelles paires, sans lien avec Clash Royale (voir jeux/CONTRIBUTING.md,
// « Refonte hors Clash Royale »).
//
// Avant REFONTE_SEASON[groupe], le groupe garde son ancienne paire (parité
// ancrée sur ACTIVE_GAME_REFERENCE_SEASON dans jeux<groupe>.js). À partir de
// cette saison, la parité s'ancre sur la saison de bascule elle-même : écart
// PAIR → 1er jeu de la nouvelle paire, IMPAIR → 2nd. Reporter la bascule d'un
// groupe = augmenter sa saison ici, rien d'autre (un jeu absent de
// REFONTE_PRETS n'est jamais lancé : voir les gardes des orchestrateurs).
//
// Les clés de groupe (et donc les clés Redis `<groupe>:last_season_id`)
// restent les identifiants techniques historiques ; seuls les libellés
// affichés changent.
// ============================================================

import { seasonIdForDate } from "./saison.js";

// Saison de bascule par groupe : 139 = décembre 2026.
export const REFONTE_SEASON = {
  culture: 139,
  aveugle: 139,
  lettres: 139,
  visuels: 139,
};

// Nouvelles paires : [jeu des écarts pairs (saison de bascule), jeu des
// écarts impairs]. Identifiants techniques = préfixes Redis. Pêle-mêle et
// Zoom gardent le leur : même jeu, nouveau thème (archives rangées par
// saison, donc jamais mélangées avec celles de la version Clash Royale).
export const REFONTE_PAIRS = {
  culture: ["synopsis", "frame"],
  aveugle: ["triviageek", "intrus"],
  lettres: ["emojis", "pelemele"],
  visuels: ["platpays", "zoom"],
};

// Jeux des nouvelles paires réellement prêts. Un jeu absent de cette liste
// n'est jamais lancé à partir de la bascule, même si son identifiant est
// déjà branché (pelemele, zoom : versions Clash Royale tant que leur
// refonte n'est pas faite). Frame est déjà hors Clash Royale.
export const REFONTE_PRETS = new Set(["frame", "triviageek"]);

const LABELS = {
  culture: { avant: "🎬 Jeux de culture", apres: "🎬 Ciné-club" },
  aveugle: { avant: "🙈 Jeux à l'aveugle", apres: "🎮 Culture geek" },
  lettres: { avant: "🔤 Jeux de lettres", apres: "🔤 Jeux de mots" },
  visuels: { avant: "🎨 Jeux visuels", apres: "📸 Coup d'œil" },
};

export function isRefonteSeason(group, seasonId) {
  return seasonId >= REFONTE_SEASON[group];
}

// Fonction pure : jeu de la nouvelle paire actif pour `seasonId`, null avant
// la bascule du groupe.
export function getRefonteGame(group, seasonId) {
  if (!isRefonteSeason(group, seasonId)) return null;
  const diff = seasonId - REFONTE_SEASON[group];
  return REFONTE_PAIRS[group][diff % 2];
}

/** `game` s'il peut être lancé pour `seasonId`, null sinon (voir REFONTE_PRETS). */
export function getWiredGame(group, seasonId, game) {
  return !isRefonteSeason(group, seasonId) || REFONTE_PRETS.has(game) ? game : null;
}

/** Libellé affiché du groupe pour une saison donnée. */
export function groupLabel(group, seasonId) {
  return isRefonteSeason(group, seasonId) ? LABELS[group].apres : LABELS[group].avant;
}

/** Libellé affiché du groupe pour la saison contenant `date`. */
export function groupLabelForDate(group, date) {
  return groupLabel(group, seasonIdForDate(date));
}
