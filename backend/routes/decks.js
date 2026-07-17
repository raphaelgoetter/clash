// ============================================================
// routes/decks.js — Deck-specific API routes
// ============================================================

import { Router } from "express";
import {
  fetchPlayer,
  fetchBattleLog,
  fetchClanWarRankings,
  fetchClanMembers,
  fetchLocations,
  fetchCards,
} from "../services/clashApi.js";
import {
  filterCompetitiveBattles,
  filterWarBattles,
  normalizeWarDeckCardId,
  summarizeDecks,
  summarizeWarDecks,
} from "../services/battleLogUtils.js";
import { getOrSet } from "../services/cache.js";

const router = Router();
const PLAYER_DECK_CACHE_TTL = 30 * 1000;
const LOCATION_CACHE_TTL = 24 * 60 * 60 * 1000;
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;
const TOP_WAR_DECKS_CACHE_TTL = 10 * 60 * 1000;
const TOP_WAR_DECKS_LIMIT = 100;
const DEFAULT_TOP_CLANS = 10;
const DEFAULT_PLAYERS_PER_CLAN = 10;
const MAX_TOP_CLANS = 20;
const MAX_PLAYERS_PER_CLAN = 15;

function normalizeTag(raw) {
  if (!raw || typeof raw !== "string") return null;
  const tag = raw.trim().replace(/^#/, "");
  return tag.length === 0 ? null : tag.toUpperCase();
}

function normalizeLocationQuery(raw) {
  if (!raw || typeof raw !== "string") return null;
  return raw.trim().toLowerCase();
}

async function resolveLocation(query) {
  const locationKey = normalizeLocationQuery(query);
  if (!locationKey) return null;

  const { value: locations } = await getOrSet(
    "clashLocations",
    () => fetchLocations(),
    LOCATION_CACHE_TTL,
  );
  if (!Array.isArray(locations)) return null;

  const exact = locations.find(
    (loc) =>
      String(loc.id) === locationKey ||
      loc.name?.toLowerCase() === locationKey ||
      loc.countryCode?.toLowerCase() === locationKey,
  );
  if (exact) return exact;

  if (locationKey === "usa" || locationKey === "us") {
    return locations.find((loc) => loc.countryCode?.toLowerCase() === "us");
  }

  return locations.find((loc) => loc.name?.toLowerCase().includes(locationKey));
}

function normalizeCardName(card) {
  const raw = card?.name ?? card?.id ?? card;
  return String(raw ?? "").trim();
}

function buildDeckSignature(cards) {
  return cards.map(normalizeWarDeckCardId).filter(Boolean).sort().join("-");
}

const WIN_CONDITIONS = new Set([
  "balloon",
  "battle ram",
  "bandit",
  "barbarian hut",
  "barbarrel",
  "bowler",
  "golem",
  "giant",
  "giant skeleton",
  "hog rider",
  "lava hound",
  "miner",
  "mega knight",
  "mortar",
  "pekka",
  "royal giant",
  "royal hogs",
  "skeleton barrel",
  "sparky",
  "three musketeers",
  "wizard",
  "ram rider",
  "x-bow",
]);

const SPELLS = new Set([
  "arrows",
  "barbarian barrel",
  "clone",
  "decorate",
  "earthquake",
  "fireball",
  "freeze",
  "goblin barrel",
  "gravel",
  "heal",
  "lightning",
  "mirror",
  "poison",
  "rocket",
  "snowball",
  "tornado",
  "the log",
  "zap",
]);

const DEFENSES = new Set([
  "barbarian hut",
  "bomb tower",
  "cannon",
  "inferno tower",
  "mortar",
  "tombstone",
  "tesla",
  "x-bow",
]);

const SUPPORTS = new Set([
  "archers",
  "baby dragon",
  "bats",
  "dark prince",
  "electro wizard",
  "electro dragon",
  "elves",
  "fire spirits",
  "ice spirit",
  "mega minion",
  "musketeer",
  "pekka",
  "prince",
  "royal ghost",
  "skeletons",
  "wizard",
  "witch",
  "valkyrie",
]);

function classifyCardType(cardName) {
  if (!cardName) return "unknown";
  const name = cardName.toLowerCase();
  if (WIN_CONDITIONS.has(name)) return "win condition";
  if (SPELLS.has(name)) return "spell";
  if (DEFENSES.has(name)) return "defense";
  if (SUPPORTS.has(name)) return "support";
  if (
    name.includes("dragon") ||
    name.includes("wizard") ||
    name.includes("musketeer")
  ) {
    return "support";
  }
  if (
    name.includes("princess") ||
    name.includes("mirror") ||
    name.includes("heal")
  ) {
    return "spell";
  }
  if (name.includes("cannon") || name.includes("tower")) {
    return "defense";
  }
  return "utility";
}

function buildDeckSuggestions(currentDeck) {
  const cardTypes = currentDeck.map((card) =>
    classifyCardType(normalizeCardName(card)),
  );
  const winConditionCount = cardTypes.filter(
    (type) => type === "win condition",
  ).length;
  const spellCount = cardTypes.filter((type) => type === "spell").length;
  const supportCount = cardTypes.filter((type) => type === "support").length;
  const defenseCount = cardTypes.filter((type) => type === "defense").length;
  const suggestions = [];

  if (winConditionCount === 0) {
    suggestions.push(
      "Ajoutez une vraie win condition pour engager le jeu offensif.",
    );
  }
  if (spellCount === 0) {
    suggestions.push(
      "Au moins un sort est recommandé pour gérer les unités rapides et les petits groupes.",
    );
  }
  if (spellCount >= 3) {
    suggestions.push(
      "Ce deck contient déjà plusieurs sorts ; un sort de support ou une carte de défense pourrait améliorer l'équilibre.",
    );
  }
  if (supportCount <= 1 && winConditionCount > 0) {
    suggestions.push(
      "Renforcez le deck avec un support polyvalent (Musketeer, Wizard, Baby Dragon, etc.).",
    );
  }
  if (defenseCount === 0) {
    suggestions.push(
      "Une carte de défense ou un bâtiment peut stabiliser les contre-attaques adverses.",
    );
  }

  return suggestions.slice(0, 3);
}

function getCurrentDeckSummary(currentDeck, warDecks) {
  const currentSignature = buildDeckSignature(currentDeck);
  const matched = (warDecks || []).find(
    (deck) => deck.signature === currentSignature,
  );
  return {
    cards: currentDeck.map((card) => ({
      ...card,
      type: classifyCardType(normalizeCardName(card)),
    })),
    samplePlays: matched?.plays ?? 0,
    sampleWins: matched?.wins ?? 0,
    winRateEstimate: matched?.winRate ?? null,
    suggestions: [],
  };
}

function pooledAllSettled(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  ).then(() => results);
}

function pickPlayersForClan(members, limit) {
  if (!Array.isArray(members)) return [];
  return members.slice(0, limit).map((member) => ({
    tag: member.tag,
    name: member.name,
    role: member.role,
    donations: member.donations,
  }));
}

function aggregateDecksFromPlayers(playersDecks) {
  const decks = new Map();
  for (const player of playersDecks) {
    const sampleKey = `${player.tag}:${player.clanTag}`;
    for (const deck of player.warDecks) {
      if (!deck.signature) continue;
      const existing = decks.get(deck.signature) ?? {
        signature: deck.signature,
        cards: deck.cards,
        cardNames: Array.isArray(deck.cardNames)
          ? deck.cardNames
          : String(deck.cards).split(/,\s*/),
        cardIds: Array.isArray(deck.cardIds) ? deck.cardIds : [],
        plays: 0,
        wins: 0,
        players: new Set(),
        clans: new Set(),
        samplePlayers: [],
      };
      existing.plays += deck.plays;
      existing.wins += deck.wins;
      existing.players.add(player.tag);
      existing.clans.add(player.clanTag);
      if (existing.samplePlayers.length < 6) {
        existing.samplePlayers.push({
          tag: player.tag,
          clanTag: player.clanTag,
        });
      }
      decks.set(deck.signature, existing);
    }
  }

  return [...decks.values()]
    .sort((a, b) => {
      if (b.plays !== a.plays) return b.plays - a.plays;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.signature.localeCompare(b.signature);
    })
    .map((deck) => ({
      signature: deck.signature,
      cards: deck.cards,
      cardNames: deck.cardNames,
      cardIds: deck.cardIds,
      plays: deck.plays,
      wins: deck.wins,
      winRate: deck.plays > 0 ? Math.round((deck.wins / deck.plays) * 100) : 0,
      samplePlayers: deck.samplePlayers,
      clans: [...deck.clans],
      playerCount: deck.players.size,
      clanCount: deck.clans.size,
    }));
}

router.get("/player/:tag", async (req, res) => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) return res.status(400).json({ error: "Tag joueur invalide." });

    const cacheKey = `decks:player:${tag}`;
    const { value: payload } = await getOrSet(
      cacheKey,
      async () => {
        const player = await fetchPlayer(tag);
        const currentDeck = Array.isArray(player.currentDeck)
          ? player.currentDeck
          : [];
        const battleLog = await fetchBattleLog(tag);
        const allDecks = summarizeDecks(battleLog, Infinity);
        const warDecks = await summarizeWarDecks(filterWarBattles(battleLog), 4);

        return {
          player,
          currentDeck: getCurrentDeckSummary(currentDeck, allDecks),
          warDecks,
        };
      },
      PLAYER_DECK_CACHE_TTL,
    );

    res.json(payload);
  } catch (err) {
    const status = err.message?.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get("/player/:tag/war-decks", async (req, res) => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) return res.status(400).json({ error: "Tag joueur invalide." });

    const battleLog = await fetchBattleLog(tag);
    const warDecks = await summarizeWarDecks(filterWarBattles(battleLog), 4);
    res.json({ tag, warDecks });
  } catch (err) {
    const status = err.message?.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get("/meta/top-war-decks", async (req, res) => {
  try {
    const locationQuery = req.query.location;
    const location = await resolveLocation(locationQuery);
    if (!location) {
      return res.status(400).json({
        error:
          "Location inconnue. Utilisez Europe, France, USA ou un identifiant de location valide.",
      });
    }

    const topClans = Math.min(
      Math.max(1, Number.parseInt(req.query.clans ?? DEFAULT_TOP_CLANS, 10)),
      MAX_TOP_CLANS,
    );
    const playersPerClan = Math.min(
      Math.max(
        1,
        Number.parseInt(req.query.players ?? DEFAULT_PLAYERS_PER_CLAN, 10),
      ),
      MAX_PLAYERS_PER_CLAN,
    );

    const cacheKey = `decks:topWarDecks:${location.id}:${topClans}:${playersPerClan}`;
    const { value: payload } = await getOrSet(
      cacheKey,
      async () => {
        const rankings = await fetchClanWarRankings(location.id, topClans);
        const clans = Array.isArray(rankings)
          ? rankings.slice(0, topClans)
          : [];

        const memberTasks = clans.map((clan) => async () => {
          const members = await fetchClanMembers(clan.tag);
          return { clanTag: clan.tag, clanName: clan.name, members };
        });

        const memberResults = await pooledAllSettled(memberTasks, 4);
        const playerCandidates = [];
        const warnings = [];

        for (const result of memberResults) {
          if (result.status === "fulfilled") {
            const { clanTag, clanName, members } = result.value;
            playerCandidates.push(
              ...pickPlayersForClan(members, playersPerClan).map((player) => ({
                ...player,
                clanTag,
                clanName,
              })),
            );
          } else {
            warnings.push(
              `Impossible de charger les membres d'un clan : ${result.reason.message}`,
            );
          }
        }

        const battleLogTasks = playerCandidates.map((player) => async () => {
          const battleLog = await fetchBattleLog(player.tag);
          return { ...player, battleLog };
        });
        const battleLogResults = await pooledAllSettled(battleLogTasks, 6);

        const playersCompetitiveDecks = [];
        for (const result of battleLogResults) {
          if (result.status === "fulfilled") {
            const { tag, name, clanTag, clanName, battleLog } = result.value;
            const warDecks = summarizeDecks(
              filterCompetitiveBattles(battleLog),
              4,
            );
            if (warDecks.length) {
              playersCompetitiveDecks.push({
                tag,
                name,
                clanTag,
                clanName,
                warDecks,
              });
            }
          } else {
            warnings.push(
              `Impossible de charger les logs de bataille d'un joueur : ${result.reason.message}`,
            );
          }
        }

        const aggregatedDecks = aggregateDecksFromPlayers(
          playersCompetitiveDecks,
        ).slice(0, TOP_WAR_DECKS_LIMIT);

        const cardDefinitions = await getOrSet(
          "clashCardDefinitions",
          () => fetchCards(),
          CARD_DEF_CACHE_TTL,
        );
        const cardById = new Map(
          (cardDefinitions.value ?? cardDefinitions ?? [])
            .filter((card) => card && card.id !== undefined)
            .map((card) => [String(card.id), card]),
        );

        const enrichedDecks = aggregatedDecks.map((deck) => ({
          ...deck,
          cardList: deck.cardIds
            ? deck.cardIds.map((id, index) => ({
                id,
                name: deck.cardNames?.[index] ?? String(id),
                iconUrl: cardById.get(String(id))?.iconUrls?.medium || null,
              }))
            : (deck.cardNames?.map((name) => ({ name })) ?? []),
        }));

        return {
          location,
          topClans: clans.map((clan) => ({
            tag: clan.tag,
            name: clan.name,
            rank: clan.rank,
            clanScore: clan.clanScore,
          })),
          playersSampled: playersCompetitiveDecks.length,
          decks: enrichedDecks,
          warnings,
        };
      },
      TOP_WAR_DECKS_CACHE_TTL,
    );

    res.json(payload);
  } catch (err) {
    const status = err.message?.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
