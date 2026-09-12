// ============================================================
// blackjackDuel.js — Blackjack duel autonome (1 à 3 joueurs, N manches),
// lancé à la demande via la commande /blackjack (rôle MINI-JEUX requis).
//
// Développé EN PARALLÈLE du jeu spécial (backend/services/blackjack.js),
// sans aucun couplage d'état : espace de clés Redis dédié
// `blackjackduel:*`, entièrement séparé de `blackjack:*`. Seules les
// fonctions PURES de logique de cartes (drawCard, computeHandValue,
// dealerPlay, compareToDealer, resolveDay, buildRanking) sont réutilisées
// par import direct — elles n'ont aucun état, les réutiliser ne crée donc
// aucun risque d'impact sur le jeu spécial.
//
// Différences structurelles avec le jeu spécial :
// - Lobby FERMÉ (1 à 3 joueurs inscrits au lancement via le bouton Jouer,
//   pas un lobby ouvert à tous) ;
// - avancement piloté par les ACTIONS des joueurs (une manche se termine
//   dès que tous les joueurs inscrits ont joué), pas par un cron quotidien ;
// - pas d'historique persistant (aucun équivalent à archiveManche /
//   writeHistoriqueEntry) ;
// - une seule partie à la fois sur tout le serveur (état global unique,
//   comme le jeu spécial) ;
// - pas de nettoyage automatique (retiré le 12/09, retour utilisateur : "je
//   ne souhaite absolument pas de cron/action pour cela") — une partie
//   bloquée >24h (resetIfStale) ou dans n'importe quel état se nettoie
//   désormais À LA MAIN via `npm run blackjackduel:reset` (inconditionnel)
//   ou `npm run blackjackduel:watchdog` (respecte le seuil de 24h) ; voir
//   `npm run blackjackduel:status` pour décider.
// ============================================================

import { Redis } from "@upstash/redis";
import {
  drawCard,
  drawUniqueCard,
  computeHandValue,
  dealerPlay,
  resolveDay,
  buildRanking,
  pointsForResult,
} from "./blackjack.js";

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

const STATE_KEY = "blackjackduel:state";
const POINTS_KEY = "blackjackduel:points";
const USERNAMES_KEY = "blackjackduel:usernames";
const RESOLVING_KEY = "blackjackduel:resolving";

function handKey(manche) {
  return `blackjackduel:hand:${manche}`;
}

// Mêmes bornes que le Croupier du jeu spécial (data/blackjack/blackjack.json)
// — pas de fichier de config séparé, rien d'autre à y régler ici (le nombre
// de manches est un paramètre de commande, pas une config statique).
const DEALER_MIN = 16;
const DEALER_MAX = 21;

// ── Délai d'inactivité avant nettoyage automatique (watchdog) ─────
const STALE_HOURS = 24;

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Mains des joueurs (une par manche, hash `blackjackduel:hand:<manche>`) ──

export async function readHand(manche, discordId) {
  return fromJson(await getRedis().hget(handKey(manche), discordId));
}

async function writeHand(manche, discordId, hand) {
  await getRedis().hset(handKey(manche), { [discordId]: toJson(hand) });
  if (hand.username) {
    await getRedis().hset(USERNAMES_KEY, { [discordId]: hand.username });
  }
}

export async function listHands(manche) {
  return hgetallJson(handKey(manche));
}

// ── Points cumulés sur la partie en cours ──────────────────────────

async function addPoints(discordId, amount) {
  if (amount <= 0) return;
  await getRedis().hincrby(POINTS_KEY, discordId, amount);
}

export async function readPoints() {
  const raw = await hgetallRaw(POINTS_KEY);
  const result = {};
  for (const [discordId, value] of Object.entries(raw)) {
    result[discordId] = Number(value) || 0;
  }
  return result;
}

export { buildRanking };

// ── Remise à zéro complète (nouvelle partie / watchdog) ────────────

export async function resetBlackjackDuel() {
  await getRedis().del(STATE_KEY, POINTS_KEY, USERNAMES_KEY, RESOLVING_KEY);
  await scanDelete("blackjackduel:hand:*");
}

// ── Lancement d'une partie ──────────────────────────────────────────
// Refuse si une partie non terminée existe déjà, n'importe quel salon (une
// seule partie à la fois sur tout le serveur, comme le jeu spécial).

export async function startGame(channelId, { maxPlayers, totalManches }) {
  const existing = await readState();
  if (existing && !existing.termine) {
    return { alreadyActive: true, state: existing };
  }

  // Nettoie les résidus d'une éventuelle partie précédente déjà terminée
  // (points/mains/verrous de résolution) avant de repartir à zéro.
  await resetBlackjackDuel();

  const dealer = dealerPlay(Math.random, DEALER_MIN, DEALER_MAX);
  const state = {
    channelId,
    messageId: null,
    maxPlayers,
    totalManches,
    manche: 1,
    dealer,
    players: [],
    rosterLocked: false,
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  await writeState(state);
  return { state };
}

// ── Bouton [Jouer] — inscription (si nouveau siège libre) + distribution ──
// Idempotent comme le jeu spécial : un clic sur une main déjà distribuée
// pour la manche en cours la renvoie telle quelle sans rien muter.

// Pure : décide si un joueur peut occuper un siège (déjà inscrit, ou
// inscription libre) et calcule le roster/verrou résultant. Appelée
// uniquement quand l'appelant a déjà vérifié (I/O) qu'aucune main n'existe
// encore pour ce joueur sur la manche en cours.
export function applyJoin(state, discordId) {
  const isSeated = state.players.includes(discordId);
  // Nouveau joueur : refusé si les inscriptions sont verrouillées (tous les
  // sièges pris, ou une manche a déjà été résolue avec un roster incomplet
  // — voir resolveManche ci-dessous).
  if (!isSeated && (state.rosterLocked || state.players.length >= state.maxPlayers)) {
    return { allowed: false };
  }
  const players = isSeated ? state.players : [...state.players, discordId];
  const rosterLocked = state.rosterLocked || players.length >= state.maxPlayers;
  return { allowed: true, isSeated, players, rosterLocked };
}

export async function joinAndDeal(discordId, username) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const existingHand = await readHand(manche, discordId);
  if (existingHand) {
    return { state, hand: existingHand, isNew: false };
  }

  const decision = applyJoin(state, discordId);
  if (!decision.allowed) return { rosterLocked: true, state };

  const first = drawCard();
  const cards = [first, drawUniqueCard([first])];
  const score = computeHandValue(cards);
  const status = score === 21 ? "stand" : "en_cours";
  const hand = { cards, score, status, username };
  await writeHand(manche, discordId, hand);

  const newState = {
    ...state,
    players: decision.players,
    rosterLocked: decision.rosterLocked,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(newState);

  return { state: newState, hand, isNew: true };
}

// ── Boutons [Piocher] / [Arrêter] ────────────────────────────────────

export async function drawOrStand(discordId, { draw }) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand };

  const cards = draw ? [...hand.cards, drawUniqueCard(hand.cards)] : hand.cards;
  const score = computeHandValue(cards);
  const status = !draw ? "stand" : score > 21 ? "bust" : score === 21 ? "stand" : "en_cours";
  const updated = { ...hand, cards, score, status };
  await writeHand(manche, discordId, updated);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(newState);

  return { state: newState, hand: updated };
}

// ── Résolution de fin de manche (concurrence) ───────────────────────
// Même idiome que assignSeasonMancheNumber (anagrams.js/frames.js/zoom.js) :
// HSETNX atomique, seul le 1er appelant qui réussit exécute la résolution —
// évite une double résolution si les 2 derniers joueurs cliquent au même
// instant. Les appels perdants ont déjà sauvegardé leur main avant ce
// check, rien n'est perdu.
async function claimResolution(manche) {
  const claimed = Number(await getRedis().hsetnx(RESOLVING_KEY, String(manche), "1"));
  return claimed === 1;
}

// Appelée après CHAQUE action qui termine une main (Jouer avec 21 naturel,
// Piocher jusqu'au bust, Arrêter) : vérifie si tous les joueurs inscrits ont
// fini leur main pour la manche en cours, et résout si c'est le cas.
export async function checkAndResolveManche() {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hands = await listHands(manche);
  const pending = state.players.filter((id) => !hands[id] || hands[id].status === "en_cours");

  if (pending.length > 0) return { resolved: false, pending, state };

  const claimed = await claimResolution(manche);
  if (!claimed) return { resolved: false, alreadyResolving: true, state };

  const outcome = await resolveManche(state, hands);
  return { resolved: true, ...outcome };
}

// Pure : calcule les résultats de la manche face au Croupier et le
// classement mis à jour, sans écrire dans Redis (le tirage du prochain
// Croupier, lui, reste dans le caller I/O ci-dessous — pas besoin de le
// prédire pour décider si la partie est finie).
export function computeMancheOutcome(state, hands, currentPoints) {
  const results = resolveDay(hands, state.dealer);
  const pointsAfter = { ...currentPoints };
  for (const r of results) {
    const pts = pointsForResult(r.result);
    if (pts > 0) pointsAfter[r.discordId] = (pointsAfter[r.discordId] || 0) + pts;
  }
  const mancheSuivante = state.manche + 1;
  const estFinDePartie = mancheSuivante > state.totalManches;
  const ranking = estFinDePartie ? buildRanking(pointsAfter) : null;
  return { results, pointsAfter, mancheSuivante, estFinDePartie, ranking };
}

async function resolveManche(state, hands) {
  const currentPoints = await readPoints();
  const outcome = computeMancheOutcome(state, hands, currentPoints);

  for (const r of outcome.results) {
    await addPoints(r.discordId, pointsForResult(r.result));
  }

  if (outcome.estFinDePartie) {
    const newState = { ...state, lastActivityAt: new Date().toISOString(), termine: true };
    await writeState(newState);
    return {
      final: true,
      dealer: state.dealer,
      results: outcome.results,
      ranking: outcome.ranking,
      state: newState,
    };
  }

  const nextDealer = dealerPlay(Math.random, DEALER_MIN, DEALER_MAX);
  const newState = {
    ...state,
    manche: outcome.mancheSuivante,
    dealer: nextDealer,
    // Verrou définitif dès qu'une manche est résolue, même si le roster
    // était incomplet (moins de joueurs que maxPlayers) — confirmé : un
    // nouveau joueur ne peut plus jamais rejoindre après ce point.
    rosterLocked: true,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(newState);
  return { final: false, dealer: state.dealer, results: outcome.results, state: newState };
}

// ── Watchdog anti-blocage ────────────────────────────────────────────
// Une partie où plus personne n'agit (manche bloquée en attente d'un
// joueur, ou partie jamais reprise) est nettoyée après STALE_HOURS. Un seul
// horodatage (lastActivityAt, mis à jour à chaque action) suffit à couvrir
// les deux cas demandés ("partie non finie après 24h" et "joueur inactif
// 24h") : tant qu'un joueur en attente n'agit pas, la manche ne peut pas se
// résoudre, donc aucune autre activité n'a lieu non plus.

export async function resetIfStale(now = Date.now()) {
  const state = await readState();
  if (!state || state.termine) return { skipped: true };

  const hoursSince = (now - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  if (hoursSince < STALE_HOURS) return { skipped: true, hoursSince };

  await resetBlackjackDuel();
  return { reset: true, hoursSince, previousState: state };
}
