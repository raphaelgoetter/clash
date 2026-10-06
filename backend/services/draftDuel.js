// ============================================================
// draftDuel.js — Jeu Duel « Draft » (1 à 3 joueurs, 7 manches), lancé à la
// demande via la commande /draft (rôle MINI-JEUX requis). Version duel du
// jeu spécial Draft Royale, avec les MÊMES règles (draftRules.js : carré de
// 4 cartes identiques, échange obligatoire au marché, Joker), sauf :
//   - une manche remplace un jour : elle se résout dès que tous les joueurs
//     ont validé leur échange (« Fin de tour »), sans cron ;
//   - toujours au moins 3 joueurs : des bots complètent la table (Kévina à
//     2 joueurs, Kévina et Josette en solo).
//
// Même structure que gobeletDuel.js / blackjackDuel.js :
// - lobby FERMÉ (1 à 3 joueurs inscrits via le bouton Jouer) ;
// - une seule partie à la fois sur tout le serveur ;
// - une partie inactive depuis `stale_heures` est close de façon
//   paresseuse (expireIfStale) ; nettoyage manuel via
//   `npm run draftduel:reset|watchdog|status`.
//
// Les bots choisissent leur échange au moment de la résolution, sans
// jamais voir les choix des joueurs.
// ============================================================

import { Redis } from "@upstash/redis";
import { loadDraftRoyaleConfig, loadCatalog } from "./draftroyale.js";
import { ajouterJoueur, echangeValide, jokerValide, computeTour, classement, choixGlouton, jokerDuBot, lireBonus, voirMain as voirMainRegle, jokerCout, choisirVedettes, nbVedettes } from "./draftRules.js";

// Bots qui complètent la table jusqu'à `MIN_JOUEURS`, dans cet ordre.
export const BOTS = [
  { id: "bot", name: "Kévina (bot)" },
  { id: "bot2", name: "Josette (bot)" },
];
export const MIN_JOUEURS = 3;

export function isBot(id) {
  return BOTS.some((b) => b.id === id);
}

export function botsDeLaPartie(maxPlayers) {
  return BOTS.slice(0, Math.max(0, MIN_JOUEURS - maxPlayers));
}
// Format des parties : une partie d'un format antérieur est ignorée.
const VERSION = 2;

// Mêmes règles que le Draft Royale (réglages propres au duel sous `duel`).
export async function loadDraftDuelConfig() {
  return loadDraftRoyaleConfig();
}

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
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}

async function hgetallRaw(key) {
  return pairsToObject((await getRedis().hgetall(key)) || []);
}

async function hgetallJson(key) {
  const result = {};
  for (const [field, value] of Object.entries(await hgetallRaw(key))) result[field] = fromJson(value);
  return result;
}

async function scanDelete(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length) await getRedis().del(...keys);
}

const STATE_KEY = "draftduel:state";
// Hash discordId (ou id de bot) → { username, main, joker, points, carres, arrivee }
const PLAYERS_KEY = "draftduel:players";
const RESOLVING_KEY = "draftduel:resolving";
// Meilleur score final de tous les temps (joueurs humains). Jamais effacé.
const HIGHSCORE_KEY = "draftduel:highscore";

// Actions de la manche : hash discordId → { prise, depot, fini }
function actionKey(manche) {
  return `draftduel:action:${manche}`;
}

// Webhook de l'interaction « Fin de tour » : pour repeindre la main
// éphémère des joueurs en attente à la résolution (jeton valable 15 min).
function handKey(manche) {
  return `draftduel:hand:${manche}`;
}
const HAND_TTL_SECONDS = 15 * 60;

// ── Règles pures propres au duel ────────────────────────────────────

// Pure : tous les sièges occupés et chaque joueur humain a validé son
// échange (les bots choisissent le leur à la résolution).
// Pure : le tour peut être validé (échange au marché ou Joker complet).
export function tourJouable(action, id, players, state, config) {
  return echangeValide(action, players[id]?.main, state.marche) || jokerValide(action?.joker, id, players, config, { echangeOk: false, marche: state.marche, reserve: state.reserve, depot: action?.depot });
}

export function isMancheReady(state, actions) {
  if (state.players.length < state.maxPlayers) return false;
  return state.players.every((id) => actions[id]?.fini);
}

// ── État de la partie ──────────────────────────────────────────────

// Une partie d'un format antérieur (ancien Draft à combinaisons) est
// ignorée, comme s'il n'y en avait pas.
export async function readState() {
  const state = fromJson(await getRedis().get(STATE_KEY));
  return state?.version === VERSION ? state : null;
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

export async function readPlayers() {
  return hgetallJson(PLAYERS_KEY);
}

async function writePlayer(id, player) {
  await getRedis().hset(PLAYERS_KEY, { [id]: toJson(player) });
}

export async function readActions(manche) {
  return hgetallJson(actionKey(manche));
}

async function readAction(manche, discordId) {
  return fromJson(await getRedis().hget(actionKey(manche), discordId)) || {};
}

async function updateAction(manche, discordId, patch) {
  const updated = { ...(await readAction(manche, discordId)), ...patch };
  await getRedis().hset(actionKey(manche), { [discordId]: toJson(updated) });
  return updated;
}

export async function readHandWebhooks(manche) {
  return hgetallRaw(handKey(manche));
}

function touch(state) {
  return { ...state, lastActivityAt: new Date().toISOString() };
}

export async function resetDraftDuel() {
  await getRedis().del(STATE_KEY, PLAYERS_KEY, RESOLVING_KEY);
  await scanDelete("draftduel:action:*");
  await scanDelete("draftduel:hand:*");
}

// ── Lancement et inscription ────────────────────────────────────────

function nouveauJoueur(username, arrivee, main) {
  return { username, main, joker: 0, points: 0, carres: 0, arrivee };
}

export async function startGame(channelId, { maxPlayers }, rng = Math.random) {
  const existing = await readState();
  if (existing && !existing.termine && !isStale(existing, Date.now(), existing.staleHours)) {
    return { alreadyActive: true, state: existing };
  }
  await resetDraftDuel();
  const [config, catalog] = await Promise.all([loadDraftDuelConfig(), loadCatalog()]);
  let state = {
    version: VERSION,
    channelId,
    messageId: null,
    maxPlayers,
    totalManches: config.duel.manches,
    staleHours: config.duel.stale_heures,
    manche: 1,
    players: [],
    rosterLocked: false,
    // Cartes en jeu, marché et exemplaires à l'écart : ils grandissent à
    // chaque arrivée (bots compris)
    familles: [],
    marche: [],
    reserve: [],
    lastRecap: null,
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  for (const [i, bot] of botsDeLaPartie(maxPlayers).entries()) {
    const arrivee = ajouterJoueur({ ...state, nbJoueursAvant: i, config, catalog, rng });
    await writePlayer(bot.id, nouveauJoueur(bot.name, 99 + i, arrivee.main));
    state = { ...state, familles: arrivee.familles, marche: arrivee.marche, reserve: arrivee.reserve };
  }
  await writeState(state);
  return { state };
}

// Pure : décide si un joueur peut occuper un siège (même logique que les
// autres duels).
export function applyJoin(state, discordId) {
  const isSeated = state.players.includes(discordId);
  if (!isSeated && (state.rosterLocked || state.players.length >= state.maxPlayers)) return { allowed: false };
  const players = isSeated ? state.players : [...state.players, discordId];
  return { allowed: true, isSeated, players, rosterLocked: state.rosterLocked || players.length >= state.maxPlayers };
}

// Inscription : le joueur tire sa main dans le marché.
export async function joinGame(discordId, username, rng = Math.random) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  const decision = applyJoin(state, discordId);
  if (!decision.allowed) return { rosterLocked: true, state };
  if (decision.isSeated) return { state, isNew: false };

  const [config, catalog, players] = await Promise.all([loadDraftDuelConfig(), loadCatalog(), readPlayers()]);
  const arrivee = ajouterJoueur({ ...state, nbJoueursAvant: Object.keys(players).length, config, catalog, rng });
  await writePlayer(discordId, nouveauJoueur(username, state.players.length, arrivee.main));
  const newState = touch({
    ...state,
    familles: arrivee.familles,
    marche: arrivee.marche,
    reserve: arrivee.reserve,
    players: decision.players,
    rosterLocked: decision.rosterLocked,
    // Cartes vedettes tirées une fois tous les joueurs arrivés (cartes en
    // jeu définitives)
    vedettes: decision.rosterLocked ? choisirVedettes(arrivee.familles, nbVedettes(Object.keys(players).length + 1, config), {}, rng) : [],
  });
  await writeState(newState);
  return { state: newState, isNew: true };
}

// ── Vue d'un joueur (main éphémère) ─────────────────────────────────

export async function readPlayerView(state, discordId) {
  const [config, catalog, players, action] = await Promise.all([
    loadDraftDuelConfig(),
    loadCatalog(),
    readPlayers(),
    readAction(state.manche, discordId),
  ]);
  const me = players[discordId] || null;
  return { state, discordId, config, catalog, players, me, action, pret: !!me && tourJouable(action, discordId, players, state, config) };
}

// Préconditions communes : partie active, joueur inscrit, tous les
// joueurs arrivés (le marché ne bouge plus), tour pas fini.
async function guardTurn(discordId) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  if (!state.players.includes(discordId)) return { notSeated: true, state };
  const action = await readAction(state.manche, discordId);
  if (action.fini || !state.rosterLocked) return { alreadyDone: true, state, view: await readPlayerView(state, discordId) };
  return { state, action };
}

async function afterAction(state, discordId, extra = {}) {
  const newState = touch(state);
  await writeState(newState);
  return { state: newState, view: await readPlayerView(newState, discordId), ...extra };
}

// `champ` : "prise" (carte du marché), "depot" (carte de la main) ou
// "annuler" (efface les deux), modifiable jusqu'à la fin de tour.
export async function choisir(discordId, champ, key) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state } = guard;
  if (champ === "annuler") {
    await updateAction(state.manche, discordId, { prise: null, depot: null });
    return afterAction(state, discordId);
  }
  const players = await readPlayers();
  const valide = champ === "prise" ? state.marche.includes(key) : champ === "depot" && players[discordId].main.includes(key);
  if (!valide) return { ...(await afterAction(state, discordId)), invalid: true };
  await updateAction(state.manche, discordId, { [champ]: key });
  return afterAction(state, discordId);
}

// Bonus Joker de la manche (valeur du menu, voir lireBonus).
export async function choisirJoker(discordId, valeur) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state } = guard;
  const [config, players] = await Promise.all([loadDraftDuelConfig(), readPlayers()]);
  const r = lireBonus(valeur, { id: discordId, joueurs: players, marche: state.marche, reserve: state.reserve, config });
  if (r.erreur) return { ...(await afterAction(state, discordId)), invalid: true };
  await updateAction(state.manche, discordId, { joker: r.joker });
  return afterAction(state, discordId);
}

// Espionner : instantané, payé tout de suite (une fois par manche).
export async function voirMain(discordId, cible) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state } = guard;
  const [config, players, actions] = await Promise.all([loadDraftDuelConfig(), readPlayers(), readActions(state.manche)]);
  const r = voirMainRegle({ id: discordId, cible, joueurs: players, actions, config });
  if (r.erreur) return { ...(await afterAction(state, discordId)), invalid: true };
  await writePlayer(discordId, { ...players[discordId], joker: players[discordId].joker - jokerCout("espionner", config) });
  await updateAction(state.manche, discordId, { vu: r.vu });
  return afterAction(state, discordId);
}

// Fin de tour : définitive, il faut un échange au marché complet ou une
// action Joker complète (le Joker seul suffit à jouer le tour). Le webhook est
// enregistré AVANT le drapeau `fini` : le joueur qui complète la manche le
// trouve forcément, même en cas de fins de tour simultanées.
export async function finirTour(discordId, webhookUrl) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state, action } = guard;
  const players = await readPlayers();
  if (!tourJouable(action, discordId, players, state, await loadDraftDuelConfig())) return { ...(await afterAction(state, discordId)), invalid: true };
  if (webhookUrl) {
    await getRedis().hset(handKey(state.manche), { [discordId]: webhookUrl });
    await getRedis().expire(handKey(state.manche), HAND_TTL_SECONDS);
  }
  await updateAction(state.manche, discordId, { fini: true });
  return afterAction(state, discordId);
}

// ── Résolution de fin de manche ─────────────────────────────────────
// Gel HSETNX par manche, même idiome que les autres duels.

async function claimResolution(manche) {
  return Number(await getRedis().hsetnx(RESOLVING_KEY, String(manche), "1")) === 1;
}

export async function checkAndResolveManche(rng = Math.random) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  const actions = await readActions(state.manche);
  if (!isMancheReady(state, actions)) return { resolved: false, state };
  if (!(await claimResolution(state.manche))) return { resolved: false, alreadyResolving: true, state };
  return { resolved: true, ...(await resolveManche(state, actions, rng)) };
}

// Pure : résolution d'une manche (échanges des bots compris).
export function computeMancheDuel({ state, joueursAvant, actions, config, rng = Math.random }) {
  const toutes = { ...actions };
  for (const id of Object.keys(joueursAvant).filter(isBot)) {
    const choix = choixGlouton(joueursAvant[id].main, state.marche, rng, state.vedettes || []);
    toutes[id] = { ...choix, joker: jokerDuBot(id, joueursAvant, choix?.prise, config) };
  }
  const dernier = state.manche >= state.totalManches;
  const tour = computeTour({
    joueursAvant,
    actions: toutes,
    marche: state.marche,
    reserve: state.reserve,
    familles: state.familles,
    vedettes: state.vedettes || [],
    config,
    dernier,
    rng,
  });
  return { ...tour, actions: toutes, final: dernier ? classement(tour.joueurs) : null };
}

async function resolveManche(state, actions, rng) {
  const [config, joueursAvant] = await Promise.all([loadDraftDuelConfig(), readPlayers()]);
  const tour = computeMancheDuel({ state, joueursAvant, actions, config, rng });
  for (const [id, j] of Object.entries(tour.joueurs)) await writePlayer(id, j);

  const lastRecap = { manche: state.manche, lignes: tour.lignes, carres: tour.carres, scores: tour.scores, nouvellesVedettes: tour.nouvellesVedettes };
  if (tour.final) {
    const newState = touch({ ...state, marche: tour.marche, reserve: tour.reserve, vedettes: tour.vedettes, termine: true, lastRecap, finalRanking: tour.final });
    await writeState(newState);
    const highScore = await updateHighScore(tour.final);
    return { final: true, ranking: tour.final, highScore, state: newState };
  }
  const newState = touch({ ...state, manche: state.manche + 1, marche: tour.marche, reserve: tour.reserve, vedettes: tour.vedettes, lastRecap });
  await writeState(newState);
  return { final: false, state: newState };
}

// ── High score (joueurs humains uniquement) ─────────────────────────

export function isNewHighScore(current, points) {
  return points > 0 && (!current || points > current.points);
}

async function updateHighScore(ranking) {
  const current = await readHighScore();
  const top = ranking?.find((r) => !isBot(r.discordId));
  if (!top || !isNewHighScore(current, top.score)) return current;
  const record = { discordId: top.discordId, username: top.username || null, points: top.score, at: new Date().toISOString() };
  await getRedis().set(HIGHSCORE_KEY, toJson(record));
  return record;
}

export async function readHighScore() {
  return fromJson(await getRedis().get(HIGHSCORE_KEY));
}

// ── Inactivité ──────────────────────────────────────────────────────

function hoursSinceActivity(state, now) {
  return (now - new Date(state.lastActivityAt).getTime()) / 3_600_000;
}

export function isStale(state, now = Date.now(), staleHours = state?.staleHours ?? 2) {
  return !!state && !state.termine && hoursSinceActivity(state, now) >= staleHours;
}

// Clôture paresseuse (sans cron), appelée à chaque interaction : une partie
// inactive est marquée terminée, classée sur les mains du moment. Pas de
// high score, la partie n'est pas allée au bout.
export async function expireIfStale(now = Date.now()) {
  const state = await readState();
  if (!isStale(state, now)) return { expired: false };
  const ranking = classement(await readPlayers());
  const newState = { ...state, termine: true, expired: true, finalRanking: ranking };
  await writeState(newState);
  return { expired: true, state: newState, ranking };
}

export async function resetIfStale(now = Date.now()) {
  const state = await readState();
  if (!state || state.termine) return { skipped: true };
  const hoursSince = hoursSinceActivity(state, now);
  if (hoursSince < (state.staleHours ?? 2)) return { skipped: true, hoursSince };
  await resetDraftDuel();
  return { reset: true, hoursSince, previousState: state };
}
