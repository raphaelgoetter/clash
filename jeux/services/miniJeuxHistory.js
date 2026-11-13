// ============================================================
// miniJeuxHistory.js — Reconstitue l'historique des vainqueurs par saison
// mini-jeux (calendaire, cf. getCurrentSeasonBounds) à partir des archives
// déjà tenues par chaque jeu. Il n'existe aucun registre dédié "vainqueur de
// saison" (contrairement au registre des Champions GDC) : ce module relit à
// la demande les archives Redis de chaque jeu et les regroupe par saison de
// la manche (seasonId stocké), comme le classement de saison du jeu : la
// dernière manche d'une saison peut se résoudre au début de la suivante. Les
// archives antérieures à novembre 2026 portent l'ancien seasonId calé sur
// Clash Royale (bornes au 1er lundi du mois), dont le numéro désigne le même
// mois. Date réelle (solvedAt/resolvedAt) à défaut de seasonId.
// ============================================================

import { getCurrentSeasonBounds, getSeasonBoundsById, seasonIdForDate } from "./saison.js";
import { groupLabelForDate, isRefonteSeason } from "./refonte.js";
import { getAllArchivedResults as getFrameResults, readState as readFrameState } from "./frames.js";
import { getAllArchivedResults as getTriviaResults, readState as readTriviaState } from "./trivia.js";
import { getAllArchivedResults as getTriviaGeekResults, readState as readTriviaGeekState } from "./triviageek.js";
import { getAllArchivedResults as getIntrusResults, readState as readIntrusState } from "./intrus.js";
import { getAllArchivedResults as getAnagramResults, readState as readAnagramState } from "./anagrams.js";
import { getAllArchivedResults as getPeleMeleResults, readState as readPeleMeleState } from "./pelemele.js";
import { getAllArchivedResults as getConceptResults, readState as readConceptState } from "./concept.js";
import { getAllArchivedResults as getSynopsisResults, readState as readSynopsisState } from "./synopsis.js";
import { getAllArchivedResults as getZoomResults, readState as readZoomState } from "./zoom.js";
import { getAllArchivedResults as getZoom2Results, readState as readZoom2State } from "./zoom2.js";
import { getAllArchivedResults as getPlatPaysResults, readState as readPlatPaysState } from "./platpays.js";
import { getAllArchivedResults as getPaletteResults, readState as readPaletteState } from "./palette.js";
import { getAllArchivedResults as getBlindRoyaleResults, readState as readBlindRoyaleState } from "./blindroyale.js";
import { getAllArchivedResults as getLaJusteCarteResults, readState as readLaJusteCarteState } from "./lajustecarte.js";
import { listManches as listQuizManches } from "./quiz.js";
import { listManches as listBlackjackManches } from "./blackjack.js";
import { listManches as listMarioClashManches } from "./marioclash.js";
import { listManches as listBangManches } from "./bang.js";
import { listManches as listQuiEstCeManches } from "./quiestce.js";
import { PREMIERE_SAISON_BOSS, championsBoss } from "./boss.js";

// Ordre d'affichage canonique — indépendant de l'ordre de découverte des
// données (les trois groupes ci-dessous tournent en parallèle).
const GAME_ORDER = [
  "culture",
  "lettres",
  "visuels",
  "aveugle",
  "clash",
  "quiz",
  "blackjack",
  "marioclash",
  "bang",
  "quiestce",
];

// Tague chaque résultat avec le nom du jeu précis qui l'a produit — permet à
// bucketScoreGames() de savoir, POUR CHAQUE SAISON, lequel des jeux d'un
// groupe en alternance a réellement tourné (voir subGames plus bas), sans
// dépendre de la logique de parité de jeuxdelettres.js/jeuxvisuels.js (qui
// raisonne en saison technique CR, non en saison calendaire mini-jeux).
function tagSubGame(fetchFn, subGame) {
  return async () => (await fetchFn()).map((r) => ({ ...r, subGame }));
}

// Trivia et Zoom carte rejoignent le groupe Clash à la refonte : leurs
// résultats restent dans leur ancien groupe avant la bascule (clash: false),
// dans « clash » ensuite (clash: true). Découpage par saison de la manche
// (la dernière manche d'une saison peut se résoudre au début de la
// suivante), par date à défaut ; les anciens seasonId calés sur Clash
// Royale sont tous antérieurs à la bascule.
function splitAtClash(fetchFn, { clash }) {
  return async () =>
    (await fetchFn()).filter((r) => {
      const dateStr = r.solvedAt || r.postedAt;
      const seasonId = r.seasonId ?? (dateStr ? seasonIdForDate(new Date(dateStr)) : null);
      return seasonId != null && isRefonteSeason("clash", Number(seasonId)) === clash;
    });
}

// Une manche hebdomadaire court 7 jours après sa publication (même durée que
// miniJeuxStats.js).
const ROUND_DURATION_MS = 7 * 24 * 3600 * 1000;

// Saison de la dernière manche publiée d'un jeu si elle court encore, null
// sinon. `clash` : même découpage que splitAtClash.
function openRound(readStateFn, { clash } = {}) {
  return async (now) => {
    const state = await readStateFn();
    if (!state?.startedAt || state.seasonId == null) return null;
    if (new Date(state.startedAt).getTime() + ROUND_DURATION_MS <= now.getTime()) return null;
    const seasonId = Number(state.seasonId);
    if (clash != null && isRefonteSeason("clash", seasonId) !== clash) return null;
    return seasonId;
  };
}

// Jeux réguliers : une entrée archivée = un joueur ayant résolu une manche.
// Le score se cumule sur toute la saison mini-jeux.
//
// "lettres" fusionne Anagram et Pêle-mêle (voir jeuxdelettres.js), "visuels"
// fusionne Zoom carte et Palette (voir jeuxvisuels.js), "culture" fusionne
// Frame et Trivia (voir jeuxculture.js), "aveugle" fusionne Blind Royale et
// La Juste Carte (voir jeuxaveugle.js) : sous leur alternance respective
// (une saison sur deux), les deux jeux d'une même paire ne sont
// jamais actifs la même saison — leurs résultats archivés se concatènent
// donc sans jamais se chevaucher, et apparaissent comme UNE seule catégorie
// plutôt que deux entrées dont l'une serait toujours vide pour une saison
// donnée. Le nom du jeu réellement actif cette saison-là est précisé dans le
// label (voir subGames dans getSeasonWinnersHistory) — pour ajouter un futur
// groupe en alternance, il suffit de lister ici chaque jeu via
// tagSubGame(), rien d'autre à changer.
//
// Exception assumée pour "aveugle" : Blind Royale et La Juste Carte ont
// tourné en parallèle (hebdomadaires indépendants, pas d'alternance) du
// 2026-09-04 (création de Blind Royale) au 2026-09-21 (bascule vers
// l'alternance saisonnière, voir jeuxaveugle.js) — seule la saison 87
// (septembre 2026) peut donc afficher un total fusionnant les deux jeux
// pour cette période de transition, contrairement aux saisons suivantes où
// un seul des deux aura tourné.
//
// openRounds : manche en cours de chaque jeu du groupe. Tant que l'une court
// encore, le groupe n'a pas de vainqueur pour la saison de cette manche (la
// dernière manche d'un mois déborde sur le suivant).
const SCORE_GAMES = [
  {
    key: "culture",
    openRounds: [openRound(readFrameState), openRound(readTriviaState, { clash: false }), openRound(readSynopsisState)],
    // Libellé selon la saison : ancien nom avant la refonte (voir refonte.js).
    labelFor: (seasonStart) => groupLabelForDate("culture", seasonStart),
    fetch: async () => [
      ...(await tagSubGame(getFrameResults, "Trouve le film")()),
      ...(await tagSubGame(splitAtClash(getTriviaResults, { clash: false }), "Trivia")()),
      ...(await tagSubGame(getSynopsisResults, "Synopsis éclaté")()),
    ],
  },
  {
    key: "lettres",
    openRounds: [openRound(readAnagramState), openRound(readPeleMeleState), openRound(readConceptState)],
    labelFor: (seasonStart) => groupLabelForDate("lettres", seasonStart),
    fetch: async () => [
      ...(await tagSubGame(getAnagramResults, "Anagram")()),
      ...(await tagSubGame(getPeleMeleResults, "Pêle-mêle")()),
      ...(await tagSubGame(getConceptResults, "Concept")()),
    ],
  },
  {
    key: "visuels",
    openRounds: [
      openRound(readZoomState, { clash: false }),
      openRound(readPaletteState),
      openRound(readZoom2State),
      openRound(readPlatPaysState),
    ],
    labelFor: (seasonStart) => groupLabelForDate("visuels", seasonStart),
    fetch: async () => [
      ...(await tagSubGame(splitAtClash(getZoomResults, { clash: false }), "Zoom carte")()),
      ...(await tagSubGame(getPaletteResults, "Palette")()),
      ...(await tagSubGame(getZoom2Results, "Zoom logo")()),
      ...(await tagSubGame(getPlatPaysResults, "Plat Pays")()),
    ],
  },
  {
    key: "aveugle",
    openRounds: [
      openRound(readBlindRoyaleState),
      openRound(readLaJusteCarteState),
      openRound(readTriviaGeekState),
      openRound(readIntrusState),
    ],
    labelFor: (seasonStart) => groupLabelForDate("aveugle", seasonStart),
    fetch: async () => [
      ...(await tagSubGame(getBlindRoyaleResults, "Blind Royale")()),
      ...(await tagSubGame(getLaJusteCarteResults, "La Juste Carte")()),
      ...(await tagSubGame(getTriviaGeekResults, "Trivia Geek")()),
      ...(await tagSubGame(getIntrusResults, "Intrus de l'inventaire")()),
    ],
  },
  {
    key: "clash",
    openRounds: [openRound(readTriviaState, { clash: true }), openRound(readZoomState, { clash: true })],
    labelFor: (seasonStart) => groupLabelForDate("clash", seasonStart),
    fetch: async () => [
      ...(await tagSubGame(splitAtClash(getTriviaResults, { clash: true }), "Trivia")()),
      ...(await tagSubGame(splitAtClash(getZoomResults, { clash: true }), "Zoom carte")()),
    ],
  },
];

// Jeux spéciaux à manches : une entrée = une partie complète, avec un
// classement interne (`ranking`) à cumuler sur la saison.
const MANCHE_SCORE_GAMES = [
  {
    key: "quiz",
    label: "❓ Quiz",
    fetch: () => listQuizManches({ limit: Infinity }),
    scoreField: "score",
  },
  {
    key: "blackjack",
    label: "🂡 Blackjack",
    fetch: () => listBlackjackManches({ limit: Infinity }),
    scoreField: "points",
  },
  {
    key: "bang",
    label: "💣 Bang!",
    fetch: () => listBangManches({ limit: Infinity }),
    scoreField: "score",
  },
  {
    key: "quiestce",
    label: "🕵️ Qui est-ce ?",
    fetch: () => listQuiEstCeManches({ limit: Infinity }),
    scoreField: "score",
  },
];

// Mario Clash n'a pas de score cumulable (juste un vainqueur par manche) :
// le vainqueur de la saison est celui qui a gagné le plus de manches.
const MANCHE_WIN_GAMES = [
  {
    key: "marioclash",
    label: "🏎️ Mario Clash",
    fetch: () => listMarioClashManches({ limit: Infinity }),
  },
];

// Saison de la manche si connue, sinon celle de la date du résultat.
function seasonBoundsFor(dateStr, seasonId) {
  return seasonId != null
    ? getSeasonBoundsById(Number(seasonId))
    : getCurrentSeasonBounds(new Date(dateStr));
}

function getOrCreateSeason(seasonMap, dateStr, seasonId = null) {
  const { start, end } = seasonBoundsFor(dateStr, seasonId);
  const key = start.toISOString();
  let season = seasonMap.get(key);
  if (!season) {
    season = { start, end, games: new Map() };
    seasonMap.set(key, season);
  }
  return season;
}

function getOrCreateGameEntry(season, game) {
  let entry = season.games.get(game.key);
  if (!entry) {
    // subGames : ensemble (ordonné par insertion) des jeux précis vus cette
    // saison pour ce groupe — vide pour les jeux qui n'alternent pas.
    const label = game.labelFor ? game.labelFor(season.start) : game.label;
    entry = { label, totals: new Map(), subGames: new Set() };
    season.games.set(game.key, entry);
  }
  return entry;
}

function addToTotal(entry, id, name, amount) {
  if (!id) return;
  const current = entry.totals.get(id) || { name, total: 0 };
  current.total += amount;
  current.name = name || current.name; // dernier pseudo connu
  entry.totals.set(id, current);
}

async function bucketScoreGames(seasonMap, now) {
  for (const game of SCORE_GAMES) {
    const results = await game.fetch();
    for (const r of results) {
      const dateStr = r.solvedAt || r.postedAt;
      if (!dateStr) continue;
      const entry = getOrCreateGameEntry(getOrCreateSeason(seasonMap, dateStr, r.seasonId), game);
      if (r.subGame) entry.subGames.add(r.subGame);
      addToTotal(entry, r.discordId, r.pseudo, Number(r.score) || 0);
    }
    const openSeasonIds = await Promise.all(game.openRounds.map((open) => open(now)));
    for (const seasonId of openSeasonIds) {
      if (seasonId == null) continue;
      seasonMap.get(getSeasonBoundsById(seasonId).start.toISOString())?.games.delete(game.key);
    }
  }
}

async function bucketMancheScoreGames(seasonMap) {
  for (const game of MANCHE_SCORE_GAMES) {
    const manches = await game.fetch();
    for (const m of manches) {
      if (!m.resolvedAt || !Array.isArray(m.ranking)) continue;
      const entry = getOrCreateGameEntry(getOrCreateSeason(seasonMap, m.resolvedAt), game);
      for (const r of m.ranking) {
        const amount = Number(r[game.scoreField]) || 0;
        if (amount <= 0) continue;
        addToTotal(entry, r.discordId || r.username, r.username, amount);
      }
    }
  }
}

async function bucketMancheWinGames(seasonMap) {
  for (const game of MANCHE_WIN_GAMES) {
    const manches = await game.fetch();
    for (const m of manches) {
      if (!m.resolvedAt || !m.vainqueur || m.vainqueur === "Personne") continue;
      const entry = getOrCreateGameEntry(getOrCreateSeason(seasonMap, m.resolvedAt), game);
      addToTotal(entry, m.vainqueur, m.vainqueur, 1);
    }
  }
}

function pickWinners(entry) {
  const list = [...entry.totals.values()];
  if (list.length === 0) return [];
  const max = Math.max(...list.map((e) => e.total));
  return list
    .filter((e) => e.total === max)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Historique complet, trié de la saison la plus récente déjà terminée à la
// plus ancienne. La saison en cours est toujours exclue, tout comme un groupe
// hebdomadaire dont une manche de la saison précédente court encore : ses
// résultats sont encore partiels, désigner un "vainqueur" serait trompeur
// avant sa clôture.
export async function getSeasonWinnersHistory(now = new Date()) {
  const seasonMap = new Map();
  await Promise.all([
    bucketScoreGames(seasonMap, now),
    bucketMancheScoreGames(seasonMap),
    bucketMancheWinGames(seasonMap),
  ]);

  const currentSeasonKey = getCurrentSeasonBounds(now).start.toISOString();
  seasonMap.delete(currentSeasonKey);

  const seasons = [...seasonMap.values()];
  // Boss de fin de saison (clos le 8 du mois suivant ; conservé 120 jours)
  const boss = await Promise.all(
    seasons.map((season) => {
      const seasonId = seasonIdForDate(season.start);
      return seasonId >= PREMIERE_SAISON_BOSS ? championsBoss(seasonId) : null;
    }),
  );

  return seasons
    .map((season, i) => ({
      start: season.start,
      boss: boss[i],
      end: season.end,
      games: [...season.games.entries()]
        .map(([key, entry]) => ({
          key,
          label:
            entry.subGames.size > 0
              ? `${entry.label} (${[...entry.subGames].join(", ")})`
              : entry.label,
          winners: pickWinners(entry),
        }))
        .filter((g) => g.winners.length > 0)
        .sort((a, b) => GAME_ORDER.indexOf(a.key) - GAME_ORDER.indexOf(b.key)),
    }))
    .filter((season) => season.games.length > 0)
    .sort((a, b) => b.start.getTime() - a.start.getTime());
}
