// ============================================================
// miniJeuxHistory.js — Reconstitue l'historique des vainqueurs par saison
// mini-jeux (calendaire, cf. getCurrentSeasonBounds) à partir des archives
// déjà tenues par chaque jeu. Il n'existe aucun registre dédié "vainqueur de
// saison" (contrairement au registre des Champions GDC) : ce module relit à
// la demande les archives Redis de chaque jeu et les regroupe par saison via
// la date réelle de chaque résultat (solvedAt/resolvedAt), jamais via le
// seasonId Clash Royale — qui ne correspond pas aux bornes calendaires de la
// saison mini-jeux (voir dateUtils.js).
// ============================================================

import { getCurrentSeasonBounds } from "./dateUtils.js";
import { getAllArchivedResults as getFrameResults } from "./frames.js";
import { getAllArchivedResults as getAnagramResults } from "./anagrams.js";
import { getAllArchivedResults as getPeleMeleResults } from "./pelemele.js";
import { getAllArchivedResults as getZoomResults } from "./zoom.js";
import { getAllArchivedResults as getPaletteResults } from "./palette.js";
import { getAllArchivedResults as getBlindRoyaleResults } from "./blindroyale.js";
import { getAllArchivedResults as getLaJusteCarteResults } from "./lajustecarte.js";
import { listManches as listQuizManches } from "./quiz.js";
import { listManches as listBlackjackManches } from "./blackjack.js";
import { listManches as listMarioClashManches } from "./marioclash.js";

// Ordre d'affichage canonique — indépendant de l'ordre de découverte des
// données (les trois groupes ci-dessous tournent en parallèle).
const GAME_ORDER = [
  "frame",
  "lettres",
  "visuels",
  "blindroyale",
  "lajustecarte",
  "quiz",
  "blackjack",
  "marioclash",
];

// Jeux réguliers : une entrée archivée = un joueur ayant résolu une manche.
// Le score se cumule sur toute la saison mini-jeux.
//
// "lettres" fusionne Anagram et Pêle-mêle (voir jeuxdelettres.js), "visuels"
// fusionne Zoom carte et Palette (voir jeuxvisuels.js) : sous leur
// alternance respective (une saison Clash Royale sur deux), les deux jeux
// d'une même paire ne sont jamais actifs la même saison — leurs résultats
// archivés se concatènent donc sans jamais se chevaucher, et apparaissent
// comme UNE seule catégorie plutôt que deux entrées dont l'une serait
// toujours vide pour une saison donnée.
const SCORE_GAMES = [
  { key: "frame", label: "🖼️ Frame", fetch: getFrameResults },
  {
    key: "lettres",
    label: "🔤 Jeux de lettres",
    fetch: async () => [...(await getAnagramResults()), ...(await getPeleMeleResults())],
  },
  {
    key: "visuels",
    label: "🎨 Jeux visuels",
    fetch: async () => [...(await getZoomResults()), ...(await getPaletteResults())],
  },
  { key: "blindroyale", label: "🙈 Blind Royale", fetch: getBlindRoyaleResults },
  { key: "lajustecarte", label: "🃏 La Juste Carte", fetch: getLaJusteCarteResults },
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

function seasonBoundsFor(dateStr) {
  return getCurrentSeasonBounds(new Date(dateStr));
}

function getOrCreateSeason(seasonMap, dateStr) {
  const { start, end } = seasonBoundsFor(dateStr);
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
    entry = { label: game.label, totals: new Map() };
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

async function bucketScoreGames(seasonMap) {
  for (const game of SCORE_GAMES) {
    const results = await game.fetch();
    for (const r of results) {
      const dateStr = r.solvedAt || r.postedAt;
      if (!dateStr) continue;
      const entry = getOrCreateGameEntry(getOrCreateSeason(seasonMap, dateStr), game);
      addToTotal(entry, r.discordId, r.pseudo, Number(r.score) || 0);
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
// plus ancienne. La saison en cours est toujours exclue : ses résultats sont
// encore partiels, désigner un "vainqueur" serait trompeur avant sa clôture.
export async function getSeasonWinnersHistory() {
  const seasonMap = new Map();
  await Promise.all([
    bucketScoreGames(seasonMap),
    bucketMancheScoreGames(seasonMap),
    bucketMancheWinGames(seasonMap),
  ]);

  const currentSeasonKey = getCurrentSeasonBounds(new Date()).start.toISOString();
  seasonMap.delete(currentSeasonKey);

  return [...seasonMap.values()]
    .map((season) => ({
      start: season.start,
      end: season.end,
      games: [...season.games.entries()]
        .map(([key, entry]) => ({
          key,
          label: entry.label,
          winners: pickWinners(entry),
        }))
        .filter((g) => g.winners.length > 0)
        .sort((a, b) => GAME_ORDER.indexOf(a.key) - GAME_ORDER.indexOf(b.key)),
    }))
    .filter((season) => season.games.length > 0)
    .sort((a, b) => b.start.getTime() - a.start.getTime());
}
