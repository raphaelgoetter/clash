// ============================================================
// miniJeuxStats.js — Statistiques de participation aux mini-jeux (bouton
// "📊 Stats" de /mini-jeux), recalculées à la demande à partir des archives
// déjà tenues par chaque jeu (même source que miniJeuxHistory.js) : aucun
// registre dédié, lecture seule.
//
// - Jeux hebdomadaires : une entrée archivée = un joueur ayant joué une
//   manche (Trivia archive aussi les mauvaises réponses, les autres jeux
//   seulement les manches résolues). Moyenne = joueurs par manche archivée.
// - Jeux spéciaux : pas de saison, une manche archivée = une partie de 7
//   jours. Seules les parties dont le nombre de joueurs est connu
//   (`nbJoueurs` ou `ranking`) sont comptées — Tamagotchi, Robinson, Boss
//   Raid, Goblin Hunters et les parties Mario Clash archivées avant le
//   18/10/2026 n'archivent qu'un résultat collectif ou un vainqueur.
// - Assidus : manches hebdomadaires de la saison mini-jeux en cours
//   (calendaire, cf. getCurrentSeasonBounds), via la date de publication.
// ============================================================

import { getCurrentSeasonBounds } from "@clash/clash-royale/dateUtils.js";
import { getAllArchivedResults as getFrameResults } from "./frames.js";
import { getAllArchivedResults as getTriviaResults } from "./trivia.js";
import { getAllArchivedResults as getAnagramResults } from "./anagrams.js";
import { getAllArchivedResults as getPeleMeleResults } from "./pelemele.js";
import { getAllArchivedResults as getZoomResults } from "./zoom.js";
import { getAllArchivedResults as getPaletteResults } from "./palette.js";
import { getAllArchivedResults as getBlindRoyaleResults } from "./blindroyale.js";
import { getAllArchivedResults as getLaJusteCarteResults } from "./lajustecarte.js";
import { listManches as listQuizManches } from "./quiz.js";
import { listManches as listBlackjackManches } from "./blackjack.js";
import { listManches as listMarioClashManches } from "./marioclash.js";
import { listManches as listGobeletManches } from "./gobelet.js";
import { listManches as listBangManches } from "./bang.js";
import { listManches as listQuiEstCeManches } from "./quiestce.js";
import { listManches as listMeowManches } from "./meow.js";

const WEEKLY_GAMES = [
  { key: "frame", title: "🎬 Trouve le film !", fetch: getFrameResults },
  { key: "trivia", title: "🧠 Trivia", fetch: getTriviaResults },
  { key: "anagram", title: "🔤 Anagram", fetch: getAnagramResults },
  { key: "pelemele", title: "🔤 Pêle-mêle", fetch: getPeleMeleResults },
  { key: "zoom", title: "🔍 Zoom carte", fetch: getZoomResults },
  { key: "palette", title: "🎨 Palette", fetch: getPaletteResults },
  { key: "blindroyale", title: "🎧 Blind Royale", fetch: getBlindRoyaleResults },
  { key: "lajustecarte", title: "🃏 La Juste Carte", fetch: getLaJusteCarteResults },
];

export const SPECIAL_GAMES = [
  { key: "quiz", title: "❓ Quiz", fetch: listQuizManches },
  { key: "blackjack", title: "🂡 Blackjack", fetch: listBlackjackManches },
  { key: "marioclash", title: "🏎️ Mario Clash", fetch: listMarioClashManches },
  { key: "gobelet", title: "🎲 Gobelet", fetch: listGobeletManches },
  { key: "bang", title: "💣 Bang!", fetch: listBangManches },
  { key: "quiestce", title: "🕵️ Qui est-ce ?", fetch: listQuiEstCeManches },
  { key: "meow", title: "🐱 Meow", fetch: listMeowManches },
];

function mancheParticipantCount(manche) {
  if (Number.isFinite(manche.nbJoueurs)) return manche.nbJoueurs;
  return Array.isArray(manche.ranking) ? manche.ranking.length : null;
}

function inBounds(dateStr, { start, end }) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date >= start && date < end;
}

// Classement des jeux hebdomadaires + manches de la saison en cours.
async function collectWeekly(seasonBounds, players, dates) {
  const games = [];
  const seasonRounds = new Set();
  const seasonPlayers = new Map(); // discordId → { pseudo, rounds: Set }

  const results = await Promise.all(WEEKLY_GAMES.map((game) => game.fetch()));
  WEEKLY_GAMES.forEach((game, index) => {
    const rounds = new Map(); // seasonId:gameId → Set(discordId)
    const gamePlayers = new Set();
    for (const r of results[index]) {
      if (!r.discordId) continue;
      const roundKey = `${r.seasonId}:${r.gameId}`;
      if (!rounds.has(roundKey)) rounds.set(roundKey, new Set());
      rounds.get(roundKey).add(r.discordId);
      gamePlayers.add(r.discordId);
      players.add(r.discordId);

      const dateStr = r.postedAt || r.solvedAt;
      if (dateStr) dates.push(dateStr);
      if (inBounds(dateStr, seasonBounds)) {
        const seasonRoundKey = `${game.key}:${roundKey}`;
        seasonRounds.add(seasonRoundKey);
        const entry = seasonPlayers.get(r.discordId) || { pseudo: r.pseudo, rounds: new Set() };
        entry.pseudo = r.pseudo || entry.pseudo;
        entry.rounds.add(seasonRoundKey);
        seasonPlayers.set(r.discordId, entry);
      }
    }
    if (rounds.size === 0) return;
    const totalEntries = [...rounds.values()].reduce((sum, set) => sum + set.size, 0);
    games.push({
      title: game.title,
      average: totalEntries / rounds.size,
      totalPlayers: gamePlayers.size,
      rounds: rounds.size,
    });
  });

  games.sort((a, b) => b.average - a.average || b.totalPlayers - a.totalPlayers);

  // Assidus : nombre de manches jouées sur le total de la saison, du plus
  // assidu au moins assidu (seuls les 3 premiers paliers sont affichés).
  const totalRounds = seasonRounds.size;
  const tiers = [];
  for (let played = totalRounds; played >= Math.max(1, totalRounds - 2); played--) {
    const names = [...seasonPlayers.values()]
      .filter((p) => p.rounds.size === played)
      .map((p) => p.pseudo)
      .sort((a, b) => a.localeCompare(b));
    if (names.length) tiers.push({ played, names });
  }

  return { games, assidus: { totalRounds, tiers } };
}

async function collectSpecial(players, dates) {
  const manchesByGame = await Promise.all(
    SPECIAL_GAMES.map((game) => game.fetch({ limit: Infinity })),
  );
  const parties = [];
  SPECIAL_GAMES.forEach((game, index) => {
    const manches = manchesByGame[index];
    for (const manche of manches) {
      if (manche.resolvedAt) dates.push(manche.resolvedAt);
      const count = mancheParticipantCount(manche);
      for (const r of manche.ranking || []) if (r.discordId) players.add(r.discordId);
      if (!count) continue;
      parties.push({
        key: game.key,
        title: game.title,
        manche: manche.manche,
        multiple: manches.length > 1,
        players: count,
        live: false,
      });
    }
  });
  return parties;
}

// live : partie spéciale en cours ({ key, playerIds }) fournie par le
// handler /mini-jeux (seul à savoir quel jeu tourne sur le salon public).
export async function computeMiniJeuxStats({ now = new Date(), live = null } = {}) {
  const players = new Set();
  const dates = [];
  const [weekly, parties] = await Promise.all([
    collectWeekly(getCurrentSeasonBounds(now), players, dates),
    collectSpecial(players, dates),
  ]);

  if (live?.playerIds?.length) {
    const game = SPECIAL_GAMES.find((g) => g.key === live.key);
    if (game) {
      live.playerIds.forEach((id) => players.add(id));
      parties.push({
        key: game.key,
        title: game.title,
        manche: null,
        multiple: parties.some((p) => p.key === game.key),
        players: live.playerIds.length,
        live: true,
      });
    }
  }
  parties.sort((a, b) => b.players - a.players);

  dates.sort();
  return {
    weekly: weekly.games,
    assidus: weekly.assidus,
    special: parties,
    totalPlayers: players.size,
    firstDate: dates[0] ?? null,
  };
}
