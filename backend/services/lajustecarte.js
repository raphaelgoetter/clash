// ============================================================
// lajustecarte.js — Jeu "La Juste Carte" (devine la carte Clash Royale à
// partir d'indices comparatifs PV/Portée/Dégâts/Élixir). Couche métier :
// catalogue, état de la partie, comparaison de stats, scoring, classements.
// Miroir structurel d'anagrams.js (même stockage Upstash Redis, mêmes
// pièges — automaticDeserialization/HGETALL, client paresseux — voir les
// commentaires détaillés dans frames.js), avec deux différences
// structurelles :
//
// 1. Pas de fichier de pool dédié : le catalogue est un SOUS-ENSEMBLE de
//    data/cardNames.json — les entrées auxquelles scripts/generateCardStats.js
//    a ajouté les 4 champs elixir/hp/damage/range (uniquement les troupes
//    éligibles, voir ce script pour le détail des exclusions). cardNames.json
//    reste trié alphabétiquement (contrainte de generateCardNames.js), donc
//    contrairement à Frame/Anagram/Zoom, l'ordre de rotation hebdomadaire ne
//    peut pas s'appuyer sur l'ordre physique du fichier : il est mélangé une
//    fois puis PERSISTÉ DANS REDIS (clé lajustecarte:order) — voir
//    loadPlayOrder().
// 2. Chaque joueur soumet PLUSIEURS propositions successives avant de
//    trouver (pas une seule tentative qui résout la manche comme les 3
//    autres jeux) : le score dépend du numéro de tentative INDIVIDUEL du
//    joueur (computeScore(attemptNumber)), pas d'un rang d'arrivée collectif
//    — pas de notion de "position", pas de positions_seq/positions.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace, fetchCards } from "./clashApi.js";
import { computeCurrentSeasonId, countRemainingWeekdayOccurrences } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";
import { normalizeAnswer } from "./textNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");

const SUNDAY = 0;
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;

// Construction paresseuse (pas au chargement du module) — voir frames.js
// pour la raison exacte (ordre des imports ES vs dotenv.config()).
let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      automaticDeserialization: false,
    });
  }
  return _redis;
}

function toJson(value) {
  return JSON.stringify(value);
}

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau plat
// [champ1, valeur1, ...] et non un objet — voir frames.js.
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

async function hgetallRaw(key) {
  return pairsToObject((await getRedis().hgetall(key)) || []);
}

async function hgetallJson(key) {
  const raw = await hgetallRaw(key);
  const result = {};
  for (const [field, value] of Object.entries(raw)) {
    result[field] = fromJson(value);
  }
  return result;
}

const STATE_KEY = "lajustecarte:state";
const ORDER_KEY = "lajustecarte:order";

function participantsKey(gameId) {
  return `lajustecarte:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `lajustecarte:usernames:${gameId}`;
}
function attemptsKey(gameId, discordId) {
  return `lajustecarte:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `lajustecarte:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `lajustecarte:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `lajustecarte:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `lajustecarte:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `lajustecarte:archived:${seasonId}`;
}

// SCAN par motif — uniquement utilisé pour le nettoyage, jamais sur le
// chemin critique d'une interaction joueur (voir frames.js).
async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function scanDelete(pattern) {
  const keys = await scanKeys(pattern);
  if (keys.length) await getRedis().del(...keys);
}

// ── Catalogue (sous-ensemble de data/cardNames.json) ────────────

let catalogCache = null;

export async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const txt = await fs.readFile(CARD_NAMES_PATH, "utf-8");
  const all = JSON.parse(txt);
  catalogCache = all.filter((c) => c.elixir != null && c.hp != null && c.damage != null && c.range != null);
  return catalogCache;
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

async function cleanupGameScratchData(gameId) {
  await getRedis().del(participantsKey(gameId), usernamesKey(gameId));
  await scanDelete(`lajustecarte:attempts:${gameId}:*`);
}

// Remet le jeu à zéro : plus de partie active, ordre de rotation remélangé
// à la prochaine partie, historique/scores entièrement effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY, ORDER_KEY);
  await scanDelete("lajustecarte:participants:*");
  await scanDelete("lajustecarte:usernames:*");
  await scanDelete("lajustecarte:attempts:*");
  await scanDelete("lajustecarte:season:*");
  await scanDelete("lajustecarte:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis anagrams.js/frames.js (seule la clé de
// cache change) — fonction 100% générique.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "lajustecarte:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      for (const delay of [0, 1000, 3000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const raceLog = await fetchRaceLog(clanTag).catch(() => null);
        const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
        const seasonId = computeCurrentSeasonId(currentRace, raceLog);
        if (seasonId != null) return seasonId;
      }
      return null;
    },
    15 * 60 * 1000,
  );
  return value;
}

// ── Ordre de rotation hebdomadaire ────────────────────────────────
// cardNames.json reste trié alphabétiquement (contrainte de
// generateCardNames.js) : contrairement à Frame/Anagram/Zoom, on ne peut
// pas s'appuyer sur l'ordre physique du fichier pour éviter que la
// prochaine carte secrète soit devinable à l'avance. L'ordre de passage est
// donc mélangé une fois puis persisté dans Redis ; les nouvelles cartes
// (ajoutées après coup par generateCardStats.js) sont insérées à la suite,
// mélangées entre elles, sans perturber l'ordre déjà en cours.
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Exportée (contrairement aux autres fonctions internes de cette section) :
// c'est le seul moyen d'inspecter la rotation à venir, utilisé par
// scripts/justeCarteOrder.js — outil admin en lecture, jamais exposé aux
// joueurs (même modèle de confiance que justeCarteScores.js, qui révèle
// déjà la carte secrète en cours à quiconque exécute le script localement).
export async function loadPlayOrder(catalog) {
  const stored = fromJson(await getRedis().get(ORDER_KEY)) || [];
  const catalogKeySet = new Set(catalog.map((c) => c.cardKey));
  const kept = stored.filter((k) => catalogKeySet.has(k));
  const missing = catalog.map((c) => c.cardKey).filter((k) => !kept.includes(k));
  const order = [...kept, ...shuffle(missing)];
  if (missing.length > 0 || kept.length !== stored.length) {
    await getRedis().set(ORDER_KEY, toJson(order));
  }
  return order;
}

export function pickNextIndex(state, order) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % order.length;
}

// Attribue le numéro de manche relatif à la saison — identique en structure
// à anagrams.js (INCR + HSETNX idempotent).
async function assignSeasonMancheNumber(seasonId, gameId) {
  const numbersKey = seasonMancheNumbersKey(seasonId);
  const existing = await getRedis().hget(numbersKey, gameId);
  if (existing != null) return Number(existing);

  const seasonManche = Number(await getRedis().incr(seasonMancheSeqKey(seasonId)));
  const wasSet = Number(await getRedis().hsetnx(numbersKey, gameId, String(seasonManche)));
  if (!wasSet) {
    return Number(await getRedis().hget(numbersKey, gameId));
  }
  return seasonManche;
}

// X = manche déjà attribuée + dimanches restants avant la fin de la saison
// calendaire (countRemainingWeekdayOccurrences, dateUtils.js) — même
// principe que Frame (mercredis) / Anagram (samedis).
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, SUNDAY);
}

export async function startNewGame(channelId) {
  const catalog = await loadCatalog();
  const order = await loadPlayOrder(catalog);
  const previousState = await readState();
  const currentIndex = pickNextIndex(previousState, order);
  const cardKey = order[currentIndex];
  const entry = catalog.find((c) => c.cardKey === cardKey);
  const seasonId = await getCurrentSeasonId();
  const gameId = entry.cardKey;
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);

  const newState = {
    currentIndex,
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal,
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);

  // Purge la progression (tentatives/participants) de la partie précédente
  // — données jetables une fois la partie terminée. Les résultats archivés
  // (lajustecarte:season:*, nécessaires au total de la saison) ne sont eux
  // jamais supprimés ici.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await cleanupGameScratchData(previousState.gameId);
  }

  return { state: newState, entry };
}

// ── Résolution de l'image de carte (API Clash Royale) ────────────

async function loadCardDefinitions() {
  // Clé de cache "clashCardDefinitions" volontairement partagée avec
  // anagrams.js/matchup.js/decks.js (getOrSet est un cache in-memory par
  // process, pas namespacé par fichier).
  const { value } = await getOrSet("clashCardDefinitions", () => fetchCards(), CARD_DEF_CACHE_TTL);
  return value;
}

export async function getCardImageUrl(cardKey) {
  if (!cardKey) return null;
  const cards = await loadCardDefinitions();
  const match = cards.find((c) => c.name === cardKey);
  if (!match) {
    console.warn(`[La Juste Carte] cardKey introuvable dans l'API Clash Royale : "${cardKey}"`);
    return null;
  }
  return match.iconUrls?.medium ?? null;
}

// ── Comparaison de stats et révélation progressive ────────────────

const ALL_STATS = ["hp", "range", "damage", "elixir"];

// Essai 1 → PV+Portée, essai 2 → +Dégâts, essai 3 et suivants → +Élixir.
function visibleStatsForAttempt(attemptNumber) {
  if (attemptNumber <= 1) return ["hp", "range"];
  if (attemptNumber === 2) return ["hp", "range", "damage"];
  return ALL_STATS;
}

// Le sens de la flèche décrit la CARTE SECRÈTE relativement à la
// proposition : "PV ⬆️" se lit "la carte secrète a un PV plus élevé que ta
// proposition" (retour utilisateur : la lecture inverse — "ma proposition
// est plus haute" — prêtait à confusion, l'intuition naturelle est que la
// flèche pointe vers où se trouve la cible).
function compareValue(secretValue, guessValue) {
  if (guessValue === secretValue) return "equal";
  return secretValue > guessValue ? "up" : "down";
}

// Fonction pure : ne dépend d'aucun état Redis, testable indépendamment.
// Compare la carte proposée à la carte secrète sur les 4 stats, puis ne
// renvoie que le sous-ensemble débloqué au numéro de tentative donné —
// range compare TOUJOURS range.rank (jamais la catégorie/valeur brute
// directement, elles ne sont pas sur la même échelle) : voir
// scripts/generateCardStats.js pour la construction de ce rang unique
// (mêlée short/medium/long = 1/2/3, distance = 3 + valeur chiffrée,
// garantit qu'une troupe à distance passe toujours devant la mêlée la plus
// longue). `damage` = dégât par coup (colonne "Damage" du wiki), pas un DPS
// — voir scripts/generateCardStats.js pour la justification.
export function compareCard(secretEntry, guessEntry, attemptNumber) {
  const all = {
    hp: compareValue(secretEntry.hp, guessEntry.hp),
    range: compareValue(secretEntry.range.rank, guessEntry.range.rank),
    damage: compareValue(secretEntry.damage, guessEntry.damage),
    elixir: compareValue(secretEntry.elixir, guessEntry.elixir),
  };
  const visible = visibleStatsForAttempt(attemptNumber);
  const result = {};
  for (const stat of visible) result[stat] = all[stat];
  return result;
}

// 1er essai gratuit (aucune pénalité visible) : essai 1 → 11-1=10. À partir
// de l'essai 2, chaque tentative coûte 1 point. Plancher à 1 quel que soit
// le nombre d'essais — une seule formule couvre les deux règles de
// l'énoncé ("1ère gratuite" + "-1/essai ensuite" + "plancher 1"), pas de
// branche "1er essai gratuit" séparée à coder : à attemptNumber=1, la
// formule ne retranche déjà rien de visible (11-1=10, le max théorique).
export function computeScore(attemptNumber) {
  return Math.max(1, 11 - attemptNumber);
}

// Résout le nom de carte tapé par le joueur (FR, accents/casse tolérés) en
// entrée du catalogue, ou null si non reconnu — égalité STRICTE contre `fr`
// normalisé (même piège documenté qu'Anagram : pas de correspondance par
// sous-chaîne, sur un nom court "Barbares" accepterait à tort "Barbares
// d'élite"... ici sans risque direct vu qu'aucune paire de cartes n'a ce
// problème, mais la règle reste la plus sûre par défaut).
//
// Repli "compact" (espaces retirés après normalizeAnswer) si l'égalité
// stricte échoue : normalizeAnswer transforme toute ponctuation (points,
// apostrophes) en espace, donc "P.E.K.K.A" devient "p e k k a" et "Barbares
// d'élite" devient "barbares d elite" — un joueur qui tape "pekka" ou
// "barbares delite" (sans le séparateur) échouerait sinon l'égalité stricte
// alors que c'est manifestement la bonne carte. Repli seulement (jamais la
// clause principale) : reste une correspondance par MOT complet compacté,
// pas une sous-chaîne arbitraire — n'introduit pas le risque "Barbares"
// matchant "Barbares d'élite" documenté ci-dessus (les mots réels diffèrent
// toujours, seuls les séparateurs internes sont ignorés).
export function resolveGuess(catalog, rawName) {
  const normalized = normalizeAnswer(rawName);
  if (!normalized) return null;
  const exact = catalog.find((c) => normalizeAnswer(c.fr) === normalized);
  if (exact) return exact;
  const compact = normalized.replace(/\s+/g, "");
  return catalog.find((c) => normalizeAnswer(c.fr).replace(/\s+/g, "") === compact) ?? null;
}

// ── Progression par joueur ────────────────────────────────────────

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

export async function countAttempts(gameId, discordId) {
  return Number(await getRedis().llen(attemptsKey(gameId, discordId))) || 0;
}

// Historique des cartes VALIDES déjà proposées par ce joueur sur cette
// manche (nom FR, dans l'ordre), pour rappel affiché dans les embeds
// éphémères ("tu as déjà proposé : ..."). Jamais un nom non reconnu (voir
// recordAttempt ci-dessous).
export async function getGuessHistory(gameId, discordId) {
  return (await getRedis().lrange(attemptsKey(gameId, discordId), 0, -1)) || [];
}

// Ajoute la carte proposée (nom FR) à l'historique des tentatives VALIDES
// (nom de carte reconnu, juste ou fausse) du joueur — une simple LIST Redis
// sert à la fois de compteur (sa longueur, renvoyée par RPUSH) et d'historique
// affichable, sans structure séparée à maintenir. Le nombre renvoyé pilote à
// la fois la révélation progressive des indices (compareCard) et, à la
// victoire, le calcul du score (computeScore). Jamais appelé pour un nom de
// carte non reconnu (voir handleModalSubmit côté handler Discord).
export async function recordAttempt(gameId, discordId, username, guessedFr) {
  await touchUsername(gameId, discordId, username);
  return Number(await getRedis().rpush(attemptsKey(gameId, discordId), guessedFr));
}

// Idempotent : si déjà résolu, renvoie le résultat existant sans rien
// réécrire. attemptNumber doit être le total renvoyé par recordAttempt()
// pour CETTE tentative gagnante (déjà incrémenté avant l'appel).
export async function markSolved(gameId, discordId, username, attemptNumber) {
  const existing = await readParticipant(gameId, discordId);
  if (existing?.solved) {
    return { participant: existing, score: existing.score };
  }

  const score = computeScore(attemptNumber);
  const participant = {
    discordId,
    username,
    attempts: attemptNumber,
    solved: true,
    solvedAt: new Date().toISOString(),
    score,
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });
  return { participant, score };
}

// ── Résultats archivés (classement de la saison) ─────────────────

export async function archiveSolve(state, entry, discordId, username, score, attempts, solvedAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    reponse: entry.fr,
    postedAt: state.startedAt,
    discordId,
    pseudo: username,
    score,
    attempts,
    solvedAt,
  };

  const wasSet = Number(await getRedis().hsetnx(archKey, field, toJson(result)));
  if (!wasSet) {
    return fromJson(await getRedis().hget(archKey, field)) ?? result; // déjà archivé par un appel concurrent
  }

  await getRedis().zincrby(seasonKey(state.seasonId), score, discordId);
  await getRedis().hset(seasonPseudosKey(state.seasonId), { [discordId]: username });
  return result;
}

export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

export async function getSeasonManches(seasonId) {
  const ids = await getRedis().hkeys(seasonMancheNumbersKey(seasonId));
  return ids || [];
}

export async function getSeasonMancheNumber(seasonId, gameId) {
  const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
  return raw == null ? null : Number(raw);
}

export async function previewSeasonManche(seasonId) {
  const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
  return seq + 1;
}

export async function hasPlayerInteracted(gameId, discordId) {
  const username = await getRedis().hget(usernamesKey(gameId), discordId);
  return username != null;
}

// Réponse (nom FR de la carte) pour une manche précise — utilisé par le
// récap de fin de saison pour rappeler la liste des cartes de la saison
// écoulée.
export async function getJusteCarteAnswer(gameId) {
  const catalog = await loadCatalog();
  return catalog.find((c) => c.cardKey === gameId)?.fr ?? null;
}

// ── Classements ──────────────────────────────────────────────────

// Joueurs ayant trouvé, triés par score décroissant puis nombre de
// tentatives croissant (contrairement à Anagram, aucune notion de rang
// d'arrivée collectif : le classement de manche est purement dérivé du
// score individuel de chacun).
export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.solved)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      score: p.score,
      attempts: p.attempts,
      solvedAt: p.solvedAt,
    }))
    .sort((a, b) => b.score - a.score || a.attempts - b.attempts);
}

export async function listGamePlayersInProgress(gameId) {
  const [participants, usernames] = await Promise.all([
    hgetallJson(participantsKey(gameId)),
    hgetallRaw(usernamesKey(gameId)),
  ]);
  const solvedIds = new Set(
    Object.values(participants)
      .filter((p) => p?.solved)
      .map((p) => p.discordId),
  );
  return Object.entries(usernames)
    .filter(([discordId]) => !solvedIds.has(discordId))
    .map(([discordId, username]) => ({ discordId, username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function computeSeasonRanking(seasonId) {
  const [flat, pseudos] = await Promise.all([
    getRedis().zrange(seasonKey(seasonId), 0, -1, { rev: true, withScores: true }),
    hgetallRaw(seasonPseudosKey(seasonId)),
  ]);
  const ranking = [];
  for (let i = 0; i < flat.length; i += 2) {
    const discordId = String(flat[i]);
    const totalScore = Number(flat[i + 1]);
    ranking.push({ discordId, pseudo: pseudos?.[discordId] || discordId, totalScore });
  }
  return ranking.sort((a, b) => b.totalScore - a.totalScore || a.pseudo.localeCompare(b.pseudo));
}

// Classement avec ex-aequo ("1224") — nécessaire pour le classement de
// SAISON (ZSET, où deux joueurs peuvent cumuler le même total) ET pour le
// classement de manche (contrairement à Anagram, plusieurs joueurs peuvent
// légitimement avoir le même score sur une même manche ici).
export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
