// ============================================================
// refonte.js — Bascule des 4 groupes de mini-jeux hebdomadaires vers leurs
// nouvelles paires, sans lien avec Clash Royale (voir jeux/CONTRIBUTING.md,
// « Refonte hors Clash Royale »), et ouverture d'un 5e groupe,
// « Curiosités » (clé technique `clash`, historique : Trivia, puis
// Sékoidon, / Zoom truc, rien avant sa saison de bascule).
//
// Avant REFONTE_SEASON[groupe], le groupe n'a aucun jeu actif (les anciennes
// paires sont supprimées). À partir de cette saison, la parité s'ancre sur la
// saison de bascule : écart PAIR → 1er jeu de la paire, IMPAIR → 2nd. Un jeu
// absent de REFONTE_PRETS n'est jamais lancé (voir les gardes des
// orchestrateurs).
//
// Les clés de groupe (et donc les clés Redis `<groupe>:last_season_id`)
// restent les identifiants techniques historiques ; seuls les libellés
// affichés changent.
// ============================================================

import { seasonIdForDate } from "./saison.js";

// Saison de bascule par groupe : 138 = novembre 2026.
export const REFONTE_SEASON = {
  culture: 138,
  aveugle: 138,
  lettres: 138,
  visuels: 138,
  clash: 138,
};

// Nouvelles paires : [jeu des écarts pairs (saison de bascule), jeu des
// écarts impairs]. Identifiants techniques = préfixes Redis. Zoom logo (`zoom2`) et Zoom truc (`zoom`, groupe Curiosités) ont des
// identifiants distincts.
export const REFONTE_PAIRS = {
  culture: ["synopsis", "frame"],
  aveugle: ["triviageek", "intrus"],
  lettres: ["concept", "pelemele"],
  visuels: ["zoom2", "platpays"],
  clash: ["trivia", "zoom"],
};

// Remplacement d'un jeu de paire à partir d'une saison : le jeu remplacé
// garde ses saisons passées (récap, historique), le nouveau prend sa place
// ensuite. Sékoidon remplace le Trivia Clash Royale en janvier 2027 (140).
export const REMPLACEMENTS = {
  clash: [{ ancien: "trivia", nouveau: "sekoidon", saison: 140 }],
};

function jeuRemplace(group, seasonId, game) {
  const r = (REMPLACEMENTS[group] ?? []).find((x) => x.ancien === game && seasonId >= x.saison);
  return r ? r.nouveau : game;
}

// Jeux des paires réellement prêts. Un jeu absent de cette liste n'est jamais
// lancé, même si son identifiant est déjà branché. Un jeu n'est prêt que dans
// sa propre paire : Zoom truc ne revient jamais dans le groupe visuels.
export const REFONTE_PRETS = new Set(["frame", "triviageek", "intrus", "concept", "synopsis", "zoom2", "platpays", "pelemele", "trivia", "zoom", "sekoidon"]);

const LABELS = {
  culture: { avant: "🎬 Jeux de culture", apres: "🎬 Ciné-club" },
  aveugle: { avant: "🙈 Jeux à l'aveugle", apres: "🎮 Culture geek" },
  lettres: { avant: "🔤 Jeux de lettres", apres: "🔤 Jeux de mots" },
  visuels: { avant: "🎨 Jeux visuels", apres: "📸 Coup d'œil" },
  clash: { avant: "🧐 Curiosités", apres: "🧐 Curiosités" },
};

export function isRefonteSeason(group, seasonId) {
  return seasonId >= REFONTE_SEASON[group];
}

// Fonction pure : jeu de la nouvelle paire actif pour `seasonId`, null avant
// la bascule du groupe.
export function getRefonteGame(group, seasonId) {
  if (!isRefonteSeason(group, seasonId)) return null;
  const diff = seasonId - REFONTE_SEASON[group];
  return jeuRemplace(group, seasonId, REFONTE_PAIRS[group][diff % 2]);
}

/** `game` s'il peut être lancé pour `seasonId`, null sinon (voir REFONTE_PRETS). */
export function getWiredGame(group, seasonId, game) {
  if (!isRefonteSeason(group, seasonId)) return game;
  const paire = REFONTE_PAIRS[group].map((g) => jeuRemplace(group, seasonId, g));
  return paire.includes(game) && REFONTE_PRETS.has(game) ? game : null;
}

/** Libellé affiché du groupe pour une saison donnée. */
export function groupLabel(group, seasonId) {
  return isRefonteSeason(group, seasonId) ? LABELS[group].apres : LABELS[group].avant;
}

/** Libellé affiché du groupe pour la saison contenant `date`. */
export function groupLabelForDate(group, date) {
  return groupLabel(group, seasonIdForDate(date));
}
