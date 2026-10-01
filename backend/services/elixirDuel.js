// ============================================================
// elixirDuel.js — Jeu Duel « Élixir » (1 à 3 joueurs, N manches), lancé à
// la demande via la commande /elixir (rôle MINI-JEUX requis).
//
// Enchères secrètes sur des cartes Clash avec un budget d'élixir fixe et
// des objectifs de collection : règles PURES dans elixirRules.js, ce
// service ne gère que l'état (Redis) et l'enchaînement des manches.
//
// Même structure que gobeletDuel.js / blackjackDuel.js :
// - lobby FERMÉ (1 à 3 joueurs inscrits via le bouton Jouer) ;
// - avancement piloté par les ACTIONS des joueurs : une manche se résout
//   dès que tous les sièges sont occupés et que chacun a validé son offre
//   (ou passé) ;
// - une seule partie à la fois sur tout le serveur ;
// - pas de cron : une partie inactive depuis STALE_HOURS est close de
//   façon paresseuse (expireIfStale) ou remplacée au prochain /elixir ;
//   nettoyage manuel via `npm run elixirduel:reset|watchdog|status`.
//
// En solo, l'adversaire est un bot (id "bot") : son offre est fixée dès
// l'ouverture de la manche, il ne voit donc jamais celle du joueur.
// ============================================================

import { Redis } from "@upstash/redis";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  STARTING_ELIXIR,
  filterCardPool,
  poolKeysFrom,
  buildDeck,
  resolveCard,
  resolveOffers,
  applyResults,
  isValidOffer,
  botOffer,
  computeFinalScores,
} from "./elixirRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");
const POOL_PATH = path.resolve(__dirname, "..", "..", "data", "elixir", "pool.json");

export const BOT_ID = "bot";
export const BOT_NAME = "Bot";

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

const STATE_KEY = "elixirduel:state";
// Hash discordId (ou "bot") → { username, stock, collection, rageNext }
const PLAYERS_KEY = "elixirduel:players";
const RESOLVING_KEY = "elixirduel:resolving";
// Meilleur score final de tous les temps, un record par format (5 ou 10
// manches). JAMAIS effacé par la remise à zéro d'une partie.
const HIGHSCORE_KEY = "elixirduel:highscore";

// Offres validées de la manche : hash discordId → { card, bid }
function offerKey(manche) {
  return `elixirduel:offer:${manche}`;
}

// Brouillon d'offre : un champ par menu (carte / mise), comme les dés
// conservés de Gobelet Duel, pour qu'un choix de carte et un choix de mise
// quasi simultanés ne s'écrasent pas.
function draftKey(manche, discordId) {
  return `elixirduel:draft:${manche}:${discordId}`;
}

const STALE_HOURS = 2;

// ── Catalogue ───────────────────────────────────────────────────────

let catalogCache = null;

export async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const [all, pool] = await Promise.all([
    fs.readFile(CARD_NAMES_PATH, "utf-8").then(JSON.parse),
    fs.readFile(POOL_PATH, "utf-8").then(JSON.parse),
  ]);
  catalogCache = new Map(filterCardPool(all, poolKeysFrom(pool)).map((c) => [c.cardKey, c]));
  return catalogCache;
}

// Cartes résolues d'une manche (null si hors partie)
export function mancheCards(state, manche, catalog) {
  const keys = state.deck?.[manche - 1];
  if (!keys) return null;
  return keys.map((k) => resolveCard(k, catalog)).filter(Boolean);
}

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

export async function readPlayers() {
  return hgetallJson(PLAYERS_KEY);
}

async function writePlayers(players) {
  const payload = {};
  for (const [id, p] of Object.entries(players)) payload[id] = toJson(p);
  if (Object.keys(payload).length) await getRedis().hset(PLAYERS_KEY, payload);
}

export async function readOffers(manche) {
  return hgetallJson(offerKey(manche));
}

async function readDraft(manche, discordId) {
  const raw = await hgetallRaw(draftKey(manche, discordId));
  return {
    card: raw.card != null && raw.card !== "" ? Number(raw.card) : null,
    bid: raw.bid != null && raw.bid !== "" ? Number(raw.bid) : null,
  };
}

function touch(state) {
  return { ...state, lastActivityAt: new Date().toISOString() };
}

// ── Remise à zéro complète ──────────────────────────────────────────

export async function resetElixirDuel() {
  await getRedis().del(STATE_KEY, PLAYERS_KEY, RESOLVING_KEY);
  await scanDelete("elixirduel:offer:*");
  await scanDelete("elixirduel:draft:*");
}

// ── Lancement d'une partie ──────────────────────────────────────────

export async function startGame(channelId, { maxPlayers, totalManches }) {
  const existing = await readState();
  if (existing && !existing.termine && !isStale(existing)) {
    return { alreadyActive: true, state: existing };
  }

  await resetElixirDuel();

  const catalog = await loadCatalog();
  const deck = buildDeck([...catalog.values()], { totalManches, maxPlayers });
  const state = {
    channelId,
    messageId: null,
    maxPlayers,
    totalManches,
    manche: 1,
    deck,
    players: [],
    rosterLocked: false,
    lastResults: null,
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  await writeState(state);

  if (maxPlayers === 1) {
    const bot = { username: BOT_NAME, stock: STARTING_ELIXIR, collection: [], rageNext: false };
    await writePlayers({ [BOT_ID]: bot });
    await placeBotOffer(state, { [BOT_ID]: bot }, catalog);
  }
  return { state };
}

// Offre secrète du bot pour la manche en cours (solo uniquement)
async function placeBotOffer(state, players, catalog) {
  const bot = players[BOT_ID];
  if (!bot) return;
  const cards = mancheCards(state, state.manche, catalog);
  const opponents = Object.entries(players)
    .filter(([id]) => id !== BOT_ID)
    .map(([, p]) => p.collection);
  const offer = botOffer(cards, bot, opponents, {
    manchesLeft: state.totalManches - state.manche + 1,
    totalManches: state.totalManches,
    catalog,
  });
  await getRedis().hset(offerKey(state.manche), { [BOT_ID]: toJson(offer) });
}

// ── Inscription (bouton Jouer) ──────────────────────────────────────

// Pure : décide si un joueur peut occuper un siège et calcule le roster
// résultant (même logique que les autres duels).
export function applyJoin(state, discordId) {
  const isSeated = state.players.includes(discordId);
  if (!isSeated && (state.rosterLocked || state.players.length >= state.maxPlayers)) {
    return { allowed: false };
  }
  const players = isSeated ? state.players : [...state.players, discordId];
  const rosterLocked = state.rosterLocked || players.length >= state.maxPlayers;
  return { allowed: true, isSeated, players, rosterLocked };
}

export async function joinGame(discordId, username) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const decision = applyJoin(state, discordId);
  if (!decision.allowed) return { rosterLocked: true, state };
  if (decision.isSeated) return { state, isNew: false };

  const player = { username, stock: STARTING_ELIXIR, collection: [], rageNext: false };
  await writePlayers({ [discordId]: player });
  const newState = touch({ ...state, players: decision.players, rosterLocked: decision.rosterLocked });
  await writeState(newState);
  return { state: newState, isNew: true };
}

// ── Vue d'un joueur (pour la main éphémère) ─────────────────────────

export async function readPlayerView(state, discordId) {
  const [players, offers, draft, catalog] = await Promise.all([
    readPlayers(),
    readOffers(state.manche),
    readDraft(state.manche, discordId),
    loadCatalog(),
  ]);
  return {
    state,
    me: players[discordId] || null,
    players,
    offer: offers[discordId] || null,
    draft,
    cards: mancheCards(state, state.manche, catalog),
    catalog,
  };
}

// Préconditions communes aux actions sur l'offre : partie active, joueur
// inscrit, offre de la manche pas encore validée.
async function guardOfferAction(discordId) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  if (!state.players.includes(discordId)) return { notSeated: true, state };
  const offers = await readOffers(state.manche);
  if (offers[discordId]) return { alreadyDone: true, state, view: await readPlayerView(state, discordId) };
  return { state };
}

// Choix de la carte : la mise est réinitialisée au coût de la carte (offre
// validable d'un clic), ou effacée si le joueur n'a pas assez d'élixir.
export async function selectCard(discordId, cardIndex) {
  const guard = await guardOfferAction(discordId);
  if (!guard.state || guard.alreadyDone || guard.notSeated) return guard;
  const { state } = guard;

  const [catalog, players] = await Promise.all([loadCatalog(), readPlayers()]);
  const cards = mancheCards(state, state.manche, catalog);
  const card = cards[cardIndex];
  if (!card) return { invalid: true, state, view: await readPlayerView(state, discordId) };

  const stock = players[discordId]?.stock ?? 0;
  const fields = { card: String(cardIndex), bid: card.minBid <= stock ? String(card.minBid) : "" };
  await getRedis().hset(draftKey(state.manche, discordId), fields);

  const newState = touch(state);
  await writeState(newState);
  return { state: newState, view: await readPlayerView(newState, discordId) };
}

export async function selectBid(discordId, bid) {
  const guard = await guardOfferAction(discordId);
  if (!guard.state || guard.alreadyDone || guard.notSeated) return guard;
  const { state } = guard;

  // Garde-fou : le menu ne propose que des mises valides, mais un clic sur
  // un ancien menu (stock modifié depuis) ne doit pas enregistrer une mise
  // impossible
  const view = await readPlayerView(state, discordId);
  if (view.draft.card == null || !isValidOffer(view.cards, { card: view.draft.card, bid }, view.me?.stock ?? 0)) {
    return { invalid: true, state, view };
  }
  await getRedis().hset(draftKey(state.manche, discordId), { bid: String(bid) });
  const newState = touch(state);
  await writeState(newState);
  return { state: newState, view: await readPlayerView(newState, discordId) };
}

export async function validateOffer(discordId) {
  const guard = await guardOfferAction(discordId);
  if (!guard.state || guard.alreadyDone || guard.notSeated) return guard;
  const { state } = guard;

  const view = await readPlayerView(state, discordId);
  const offer = { card: view.draft.card, bid: view.draft.bid };
  if (offer.card == null || !isValidOffer(view.cards, offer, view.me?.stock ?? 0)) {
    return { invalid: true, state, view };
  }
  return lockOffer(state, discordId, offer);
}

export async function passOffer(discordId) {
  const guard = await guardOfferAction(discordId);
  if (!guard.state || guard.alreadyDone || guard.notSeated) return guard;
  return lockOffer(guard.state, discordId, { card: null, bid: 0 });
}

async function lockOffer(state, discordId, offer) {
  await getRedis().hset(offerKey(state.manche), { [discordId]: toJson(offer) });
  await getRedis().del(draftKey(state.manche, discordId));
  const newState = touch(state);
  await writeState(newState);
  return { state: newState, view: await readPlayerView(newState, discordId) };
}

// ── Résolution de fin de manche ─────────────────────────────────────
// Verrou HSETNX par manche, même idiome que les autres duels : seul le 1er
// appelant résout, les autres ont déjà enregistré leur offre.

async function claimResolution(manche) {
  const claimed = Number(await getRedis().hsetnx(RESOLVING_KEY, String(manche), "1"));
  return claimed === 1;
}

// Pure : tous les sièges occupés et chaque joueur humain a validé ou passé
// (l'offre du bot est posée dès l'ouverture de la manche).
export function isMancheReady(state, offers) {
  if (state.players.length < state.maxPlayers) return false;
  return state.players.every((id) => offers[id]);
}

export async function checkAndResolveManche() {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const offers = await readOffers(state.manche);
  if (!isMancheReady(state, offers)) return { resolved: false, state };

  const claimed = await claimResolution(state.manche);
  if (!claimed) return { resolved: false, alreadyResolving: true, state };

  return { resolved: true, ...(await resolveManche(state, offers)) };
}

async function resolveManche(state, offers) {
  const [catalog, players] = await Promise.all([loadCatalog(), readPlayers()]);
  const cards = mancheCards(state, state.manche, catalog);
  const results = resolveOffers(cards, offers, players);
  const nextPlayers = applyResults(players, results);
  await writePlayers(nextPlayers);

  // Bilan conservé dans l'état pour réafficher la manche précédente à
  // chaque rafraîchissement du message public
  const lastResults = { manche: state.manche, results, offers };

  if (state.manche >= state.totalManches) {
    const ranking = computeFinalScores(nextPlayers, catalog, state.totalManches);
    const newState = touch({ ...state, termine: true, lastResults, finalRanking: ranking });
    await writeState(newState);
    const highScore = await updateHighScore(state.totalManches, ranking);
    return { final: true, ranking, highScore, state: newState };
  }

  const newState = touch({ ...state, manche: state.manche + 1, lastResults });
  await writeState(newState);
  await placeBotOffer(newState, nextPlayers, catalog);
  return { final: false, state: newState };
}

// Scores projetés (comme si la partie s'arrêtait maintenant)
export async function readCurrentScores(state) {
  const [catalog, players] = await Promise.all([loadCatalog(), readPlayers()]);
  return computeFinalScores(players, catalog, state.totalManches);
}

// ── High score (record par format, joueurs humains uniquement) ────────

export function isNewHighScore(current, points) {
  return points > 0 && (!current || points > current.points);
}

async function updateHighScore(totalManches, ranking) {
  const field = String(totalManches);
  const current = fromJson(await getRedis().hget(HIGHSCORE_KEY, field));
  const top = ranking?.find((r) => r.id !== BOT_ID);
  if (!top || !isNewHighScore(current, top.total)) return current;
  const record = { discordId: top.id, username: top.username || null, points: top.total, at: new Date().toISOString() };
  await getRedis().hset(HIGHSCORE_KEY, { [field]: toJson(record) });
  return record;
}

export async function readHighScore(totalManches) {
  return fromJson(await getRedis().hget(HIGHSCORE_KEY, String(totalManches)));
}

// ── Inactivité ──────────────────────────────────────────────────────

function hoursSinceActivity(state, now) {
  return (now - new Date(state.lastActivityAt).getTime()) / 3_600_000;
}

export function isStale(state, now = Date.now()) {
  return !!state && !state.termine && hoursSinceActivity(state, now) >= STALE_HOURS;
}

// Clôture paresseuse (sans cron), appelée à chaque interaction : une partie
// inactive depuis STALE_HOURS est marquée terminée avec les scores figés.
// Pas de high score, la partie n'est pas allée au bout.
export async function expireIfStale(now = Date.now()) {
  const state = await readState();
  if (!isStale(state, now)) return { expired: false };

  const ranking = await readCurrentScores(state);
  const newState = { ...state, termine: true, expired: true, finalRanking: ranking };
  await writeState(newState);
  return { expired: true, state: newState, ranking };
}

export async function resetIfStale(now = Date.now()) {
  const state = await readState();
  if (!state || state.termine) return { skipped: true };

  const hoursSince = hoursSinceActivity(state, now);
  if (hoursSince < STALE_HOURS) return { skipped: true, hoursSince };

  await resetElixirDuel();
  return { reset: true, hoursSince, previousState: state };
}
