// ============================================================
// draftDuel.js — Jeu Duel « Draft » (1 à 3 joueurs, 7 manches), lancé à la
// demande via la commande /draft (rôle MINI-JEUX requis). Version duel du
// jeu spécial Draft Royale, avec les MÊMES règles (pioche, marché, vœux,
// barème, deck final de 8) importées de draftroyale.js, sauf :
//   - pas de contrat (jugé trop lourd pour une partie courte) ;
//   - une manche remplace un jour : elle se résout dès que tous les joueurs
//     ont cliqué « Fin de tour » (après avoir pioché), sans cron ;
//   - le Marchand complète le marché de chaque manche avec
//     (joueurs + marchand_en_plus) cartes uniques, le solo comptant pour
//     2 joueurs : à 1 à 3 joueurs, les dépôts seuls laisseraient un marché
//     presque vide.
//
// Même structure que gobeletDuel.js / blackjackDuel.js :
// - lobby FERMÉ (1 à 3 joueurs inscrits via le bouton Jouer) ;
// - une seule partie à la fois sur tout le serveur ;
// - une partie inactive depuis `stale_heures` est close de façon
//   paresseuse (expireIfStale) ; nettoyage manuel via
//   `npm run draftduel:reset|watchdog|status`.
//
// En solo, l'adversaire est un bot (id "bot") : il joue sa manche dès
// son ouverture, sans jamais voir les choix du joueur.
// ============================================================

import { Redis } from "@upstash/redis";
import {
  loadDraftRoyaleConfig,
  loadCatalog,
  scoreDeck,
  computeFinal,
  resoudreVoeux,
  cartesSouhaitables,
  depotDuJour,
  tirerCarte,
  cardsFromKeys,
  countTheme,
  RARITIES,
} from "./draftroyale.js";

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
// Hash discordId (ou "bot") → { username, main, depots, popularite, arrivee }
const PLAYERS_KEY = "draftduel:players";
const RESOLVING_KEY = "draftduel:resolving";
// Meilleur score final de tous les temps (joueurs humains). Jamais effacé.
const HIGHSCORE_KEY = "draftduel:highscore";

// Actions de la manche : hash discordId → { pioche, depot, voeux, fini }
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

// Nombre de cartes du Marchand : le solo compte pour 2 joueurs (le bot).
export function nbCartesMarchand(maxPlayers, config) {
  return Math.max(2, maxPlayers) + config.duel.marchand_en_plus;
}

// Marché d'une manche : dépôts de la manche précédente (`copies_par_depot`
// chacun) + cartes du Marchand (1 exemplaire, sans déposant), jamais une
// carte déjà déposée.
export function construireMarche(depots, nbMarchand, catalog, rng = Math.random) {
  const marche = depots.map((d) => ({ key: d.key, discordId: d.discordId, at: d.at || null }));
  const exclues = marche.map((m) => m.key);
  for (let i = 0; i < nbMarchand; i++) {
    const key = tirerCarte(exclues, catalog, rng);
    if (!key) break;
    exclues.push(key);
    marche.push({ key, discordId: null, copies: 1 });
  }
  return marche;
}

// Valeur d'une main pour le bot : score réel + crédit partiel des thèmes
// et archétypes commencés + poids des raretés (majorités).
const RARITY_WEIGHT = { champion: 4, legendary: 1.5, epic: 0.6, rare: 0.3 };

export function valeurMain(cards, config) {
  let v = scoreDeck(cards, null, config).total;
  for (const theme of config.themes) {
    const n = countTheme(cards, theme);
    if (n < config.paliers[0]) v += theme.points[0] * (n / config.paliers[0]) * 0.6;
  }
  for (const a of config.archetypes) {
    if (a.cartes.filter((k) => cards.some((c) => c.cardKey === k)).length === 1) v += a.points * 0.3;
  }
  for (const c of cards) v += RARITY_WEIGHT[c.rarity] || 0;
  return v;
}

// Carte la moins utile d'une main (celle dont le retrait coûte le moins).
export function carteLaMoinsUtile(keys, config, catalog) {
  const base = valeurMain(cardsFromKeys(keys, catalog), config);
  let best = null;
  for (const key of keys) {
    const perte = base - valeurMain(cardsFromKeys(keys.filter((k) => k !== key), catalog), config);
    const card = catalog.get(key);
    const rang = card ? RARITIES.indexOf(card.rarity) : -1;
    if (!best || perte < best.perte || (perte === best.perte && rang < best.rang)) best = { key, perte, rang };
  }
  return best?.key ?? null;
}

// Vœux du bot : les cartes souhaitables qui améliorent le plus sa main.
export function voeuxDuBot(keys, souhaitables, config, catalog) {
  const base = valeurMain(cardsFromKeys(keys, catalog), config);
  return souhaitables
    .map((key) => ({ key, gain: valeurMain(cardsFromKeys([...keys, key], catalog), config) - base }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, config.nb_voeux)
    .map((v) => v.key);
}

// Pure : tous les sièges occupés et chaque joueur humain a fini son tour
// (le bot joue dès l'ouverture de la manche).
export function isMancheReady(state, actions) {
  if (state.players.length < state.maxPlayers) return false;
  return state.players.every((id) => actions[id]?.fini);
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

function nouveauJoueur(username, arrivee, config, catalog, rng) {
  const main = [];
  for (let i = 0; i < config.cartes_depart; i++) {
    const key = tirerCarte(main, catalog, rng);
    if (key) main.push(key);
  }
  return { username, main, depots: [], popularite: 0, arrivee };
}

export async function startGame(channelId, { maxPlayers }, rng = Math.random) {
  const existing = await readState();
  if (existing && !existing.termine && !isStale(existing, Date.now(), existing.staleHours)) {
    return { alreadyActive: true, state: existing };
  }
  await resetDraftDuel();
  const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
  const state = {
    channelId,
    messageId: null,
    maxPlayers,
    totalManches: config.duel.manches,
    staleHours: config.duel.stale_heures,
    manche: 1,
    players: [],
    rosterLocked: false,
    // Marché ouvert aux vœux pendant la manche en cours (vide en manche 1 :
    // les vœux supposent un dépôt à la manche précédente)
    marche: [],
    lastRecap: null,
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  await writeState(state);
  if (maxPlayers === 1) {
    await writePlayer(BOT_ID, nouveauJoueur(BOT_NAME, 99, config, catalog, rng));
    await playBotTurn(state, rng);
  }
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

export async function joinGame(discordId, username, rng = Math.random) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  const decision = applyJoin(state, discordId);
  if (!decision.allowed) return { rosterLocked: true, state };
  if (decision.isSeated) return { state, isNew: false };

  const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
  await writePlayer(discordId, nouveauJoueur(username, state.players.length, config, catalog, rng));
  const newState = touch({ ...state, players: decision.players, rosterLocked: decision.rosterLocked });
  await writeState(newState);
  return { state: newState, isNew: true };
}

// ── Vue d'un joueur (main éphémère) ─────────────────────────────────

export async function readPlayerView(state, discordId) {
  const [config, catalog, players, action] = await Promise.all([
    loadDraftRoyaleConfig(),
    loadCatalog(),
    readPlayers(),
    readAction(state.manche, discordId),
  ]);
  const me = players[discordId] || null;
  const depotVeille = me ? depotDuJour(me, state.manche - 1) : null;
  return {
    state,
    config,
    catalog,
    players,
    me,
    action,
    depotVeille,
    souhaitables: me && depotVeille ? cartesSouhaitables(state.marche || [], me, state.manche) : [],
  };
}

// Préconditions communes : partie active, joueur inscrit, tour pas fini.
async function guardTurn(discordId) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };
  if (!state.players.includes(discordId)) return { notSeated: true, state };
  const action = await readAction(state.manche, discordId);
  if (action.fini) return { alreadyDone: true, state, view: await readPlayerView(state, discordId) };
  return { state, action };
}

async function afterAction(state, discordId, extra = {}) {
  const newState = touch(state);
  await writeState(newState);
  return { state: newState, view: await readPlayerView(newState, discordId), ...extra };
}

export async function piocher(discordId, rng = Math.random) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state, action } = guard;
  if (action.pioche) return { ...(await afterAction(state, discordId)), invalid: true };
  const [catalog, players] = await Promise.all([loadCatalog(), readPlayers()]);
  const me = players[discordId];
  const key = tirerCarte([...me.main, ...me.depots.map((d) => d.key)], catalog, rng);
  if (key) await writePlayer(discordId, { ...me, main: [...me.main, key] });
  await updateAction(state.manche, discordId, { pioche: key || "aucune" });
  return afterAction(state, discordId, { pioche: key });
}

export async function deposer(discordId, key) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state, action } = guard;
  const [config, players] = await Promise.all([loadDraftRoyaleConfig(), readPlayers()]);
  const me = players[discordId];
  if (action.depot || state.manche > config.jour_dernier_depot || !me.main.includes(key)) {
    return { ...(await afterAction(state, discordId)), invalid: true };
  }
  await writePlayer(discordId, {
    ...me,
    main: me.main.filter((k) => k !== key),
    depots: [...me.depots, { key, jour: state.manche, at: new Date().toISOString() }],
  });
  await updateAction(state.manche, discordId, { depot: key });
  return afterAction(state, discordId);
}

export async function enregistrerVoeu(discordId, rang, key) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state, action } = guard;
  const config = await loadDraftRoyaleConfig();
  const view = await readPlayerView(state, discordId);
  if (!view.souhaitables.includes(key) || rang < 1 || rang > config.nb_voeux) return { ...(await afterAction(state, discordId)), invalid: true };
  const voeux = Array.from({ length: config.nb_voeux }, (_, i) => action.voeux?.[i] ?? null).map((k) => (k === key ? null : k));
  voeux[rang - 1] = key;
  await updateAction(state.manche, discordId, { voeux });
  return afterAction(state, discordId);
}

// Fin de tour : définitif, il faut avoir pioché. Le webhook est enregistré
// AVANT le drapeau `fini` : le joueur qui complète la manche le trouve
// forcément, même en cas de fins de tour simultanées.
export async function finirTour(discordId, webhookUrl) {
  const guard = await guardTurn(discordId);
  if (!guard.action) return guard;
  const { state, action } = guard;
  if (!action.pioche) return { ...(await afterAction(state, discordId)), invalid: true };
  if (webhookUrl) {
    await getRedis().hset(handKey(state.manche), { [discordId]: webhookUrl });
    await getRedis().expire(handKey(state.manche), HAND_TTL_SECONDS);
  }
  await updateAction(state.manche, discordId, { fini: true });
  return afterAction(state, discordId);
}

// ── Tour du bot (solo) ──────────────────────────────────────────────

async function playBotTurn(state, rng = Math.random) {
  const [config, catalog, players] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readPlayers()]);
  const bot = players[BOT_ID];
  if (!bot) return;
  const main = [...bot.main];
  const pioche = tirerCarte([...main, ...bot.depots.map((d) => d.key)], catalog, rng);
  if (pioche) main.push(pioche);
  const action = { pioche: pioche || "aucune", fini: true };

  if (depotDuJour(bot, state.manche - 1)) {
    action.voeux = voeuxDuBot(main, cartesSouhaitables(state.marche || [], { ...bot, main }, state.manche), config, catalog);
  }
  const depots = [...bot.depots];
  if (state.manche <= config.jour_dernier_depot && main.length > 1) {
    const key = carteLaMoinsUtile(main, config, catalog);
    main.splice(main.indexOf(key), 1);
    depots.push({ key, jour: state.manche, at: new Date().toISOString() });
    action.depot = key;
  }
  await writePlayer(BOT_ID, { ...bot, main, depots });
  await getRedis().hset(actionKey(state.manche), { [BOT_ID]: toJson(action) });
}

// ── Résolution de fin de manche ─────────────────────────────────────
// Verrou HSETNX par manche, même idiome que les autres duels.

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

// Pure : résolution d'une manche (vœux, marché suivant, classement final).
export function computeMancheDuel({ state, joueursAvant, actions, config, catalog, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j, main: [...(j.main || [])], depots: [...(j.depots || [])] };
  const lignes = resoudreVoeux({ jour: state.manche, joueurs, actionsRaw: actions, marcheVeille: state.marche || [], config, rng });

  if (state.manche >= state.totalManches) {
    return { joueurs, lignes, final: computeFinal({ joueurs, config, catalog }), marche: [] };
  }
  const depots = Object.entries(joueurs)
    .map(([discordId, j]) => ({ discordId, depot: depotDuJour(j, state.manche) }))
    .filter(({ depot }) => depot)
    .map(({ discordId, depot }) => ({ key: depot.key, discordId, at: depot.at }));
  const marche = construireMarche(depots, nbCartesMarchand(state.maxPlayers, config), catalog, rng);
  return { joueurs, lignes, final: null, marche };
}

async function resolveManche(state, actions, rng) {
  const [config, catalog, joueursAvant] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readPlayers()]);
  const { joueurs, lignes, final, marche } = computeMancheDuel({ state, joueursAvant, actions, config, catalog, rng });
  for (const [id, j] of Object.entries(joueurs)) await writePlayer(id, j);

  const lastRecap = { manche: state.manche, lignes, actions };
  if (final) {
    const newState = touch({ ...state, termine: true, lastRecap, finalRanking: final });
    await writeState(newState);
    const highScore = await updateHighScore(final);
    return { final: true, ranking: final, highScore, state: newState };
  }
  const newState = touch({ ...state, manche: state.manche + 1, marche, lastRecap });
  await writeState(newState);
  await playBotTurn(newState, rng);
  return { final: false, state: newState };
}

// Score provisoire d'un joueur (hors majorités, popularité comprise).
export function scoreProvisoire(player, config, catalog) {
  const { details, total } = scoreDeck(cardsFromKeys(player.main, catalog), null, config);
  const pop = Math.min(config.popularite_max, player.popularite || 0);
  return { details, total: total + pop, popularite: pop };
}

// ── High score (joueurs humains uniquement) ─────────────────────────

export function isNewHighScore(current, points) {
  return points > 0 && (!current || points > current.points);
}

async function updateHighScore(ranking) {
  const current = await readHighScore();
  const top = ranking?.find((r) => r.discordId !== BOT_ID);
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
  const [config, catalog, joueurs] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readPlayers()]);
  const ranking = computeFinal({ joueurs, config, catalog });
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
