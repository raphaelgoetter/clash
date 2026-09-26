// ============================================================
// gobeletDuel.js — Jeu du Gobelet, duel autonome (1 à 3 joueurs, N manches),
// lancé à la demande via la commande /gobelet (rôle MINI-JEUX requis).
//
// Développé EN PARALLÈLE du jeu spécial (backend/services/gobelet.js), sans
// aucun couplage d'état : espace de clés Redis dédié `gobeletduel:*`,
// entièrement séparé de `gobelet:*`. Seules les fonctions PURES de logique
// de dés (rollDice, rerollKept, computeBestCombination, resolveJour,
// buildRanking) sont réutilisées par import direct — elles n'ont aucun
// état, les réutiliser ne crée donc aucun risque d'impact sur le jeu
// spécial. Même principe exact que blackjackDuel.js vis-à-vis de
// blackjack.js.
//
// Différences structurelles avec le jeu spécial :
// - Lobby FERMÉ (1 à 3 joueurs inscrits au lancement via le bouton Jouer,
//   pas un lobby ouvert à tous) ;
// - avancement piloté par les ACTIONS des joueurs (une manche se termine
//   dès que tous les sièges sont occupés et que chacun a terminé ses 3
//   tirages), pas par un cron quotidien ;
// - pas d'historique persistant (aucun équivalent à archiveManche /
//   writeHistoriqueEntry) ;
// - une seule partie à la fois sur tout le serveur (état global unique,
//   comme le jeu spécial) ;
// - pas de nettoyage automatique (même retour utilisateur que pour
//   Blackjack Duel : "je ne souhaite absolument pas de cron/action pour
//   cela") — une partie bloquée >2h (resetIfStale) ou dans n'importe quel
//   état se nettoie désormais À LA MAIN via `npm run gobeletduel:reset`
//   (inconditionnel) ou `npm run gobeletduel:watchdog` (respecte le seuil
//   de 2h) ; voir `npm run gobeletduel:status` pour décider.
// ============================================================

import { Redis } from "@upstash/redis";
import {
  rollDice,
  rerollKept,
  computeBestCombination,
  resolveJour,
  buildRanking,
  withUsedCategory,
  NO_COMBINATION,
} from "./gobelet.js";

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

const STATE_KEY = "gobeletduel:state";
const POINTS_KEY = "gobeletduel:points";
const USERNAMES_KEY = "gobeletduel:usernames";
const RESOLVING_KEY = "gobeletduel:resolving";
const USED_KEY = "gobeletduel:used";

function handKey(manche) {
  return `gobeletduel:hand:${manche}`;
}

// ── Délai d'inactivité avant nettoyage automatique (watchdog) ─────
const STALE_HOURS = 2;

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Mains des joueurs (une par manche, hash `gobeletduel:hand:<manche>`) ──

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

// ── Dés conservés (un champ Redis par dé, PAS un tableau dans le blob JSON
// de la main) — même correctif que le jeu spécial (gobelet.js) pour la même
// race condition : deux clics quasi simultanés sur des dés DIFFÉRENTS
// écrasaient le tableau `kept` en repartant d'une lecture antérieure à
// l'écriture de l'autre clic. Isoler chaque dé dans son propre champ de
// hash Redis élimine ce conflit.
function keptKey(manche, discordId) {
  return `gobeletduel:kept:${manche}:${discordId}`;
}

export async function readKept(manche, discordId) {
  const raw = await hgetallRaw(keptKey(manche, discordId));
  return [0, 1, 2, 3, 4].map((i) => raw[String(i)] === "1");
}

async function setKeptField(manche, discordId, index, value) {
  await getRedis().hset(keptKey(manche, discordId), { [String(index)]: value ? "1" : "0" });
}

async function resetKept(manche, discordId) {
  await getRedis().del(keptKey(manche, discordId));
}

// ── Combinaisons déjà réalisées (partie en cours) ───────────────────
// Hash `gobeletduel:used` : discordId -> tableau JSON des catégories
// marquées lors des manches déjà résolues (chaque combinaison ne rapporte
// qu'une fois par partie, voir computeBestCombination). Mis à jour
// uniquement dans resolveManche, protégé par claimResolution.

export async function readUsedCategories(discordId) {
  return fromJson(await getRedis().hget(USED_KEY, discordId)) || [];
}

async function writeUsedCategories(discordId, used) {
  await getRedis().hset(USED_KEY, { [discordId]: toJson(used) });
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

export async function resetGobeletDuel() {
  await getRedis().del(STATE_KEY, POINTS_KEY, USERNAMES_KEY, RESOLVING_KEY, USED_KEY);
  await scanDelete("gobeletduel:hand:*");
  await scanDelete("gobeletduel:kept:*");
}

// ── Lancement d'une partie ──────────────────────────────────────────
// Refuse si une partie non terminée existe déjà, n'importe quel salon (une
// seule partie à la fois sur tout le serveur, comme le jeu spécial).

export async function startGame(channelId, { maxPlayers, totalManches }) {
  const existing = await readState();
  // Une partie inactive depuis STALE_HOURS (ex. un joueur seul qui attend un
  // adversaire jamais venu, voir isMancheReady) est considérée abandonnée :
  // relancer la commande la remplace, sans cron de nettoyage.
  const hoursSince = existing ? (Date.now() - new Date(existing.lastActivityAt).getTime()) / 3_600_000 : 0;
  if (existing && !existing.termine && hoursSince < STALE_HOURS) {
    return { alreadyActive: true, state: existing };
  }

  // Nettoie les résidus d'une éventuelle partie précédente déjà terminée
  // (points/mains/verrous de résolution) avant de repartir à zéro.
  await resetGobeletDuel();

  const state = {
    channelId,
    messageId: null,
    maxPlayers,
    totalManches,
    manche: 1,
    players: [],
    rosterLocked: false,
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  await writeState(state);
  return { state };
}

// ── Bouton [Jouer] — inscription (si nouveau siège libre) + 1ᵉʳ tirage ──
// Idempotent comme le jeu spécial : un clic sur une main déjà distribuée
// pour la manche en cours la renvoie telle quelle sans rien muter.

// Pure : décide si un joueur peut occuper un siège (déjà inscrit, ou
// inscription libre) et calcule le roster/verrou résultant. Appelée
// uniquement quand l'appelant a déjà vérifié (I/O) qu'aucune main n'existe
// encore pour ce joueur sur la manche en cours.
export function applyJoin(state, discordId) {
  const isSeated = state.players.includes(discordId);
  // Nouveau joueur : refusé si les inscriptions sont verrouillées (tous les
  // sièges pris). Aucune manche n'est résolue tant que le roster est
  // incomplet (voir isMancheReady), le verrou ne tombe donc qu'une fois
  // toutes les places occupées.
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
  const used = await readUsedCategories(discordId);
  if (existingHand) {
    const kept = existingHand.status === "en_cours" ? await readKept(manche, discordId) : [false, false, false, false, false];
    return { state, hand: existingHand, kept, used, isNew: false };
  }

  const decision = applyJoin(state, discordId);
  if (!decision.allowed) return { rosterLocked: true, state };

  const dice = rollDice(5);
  const hand = { dice, tirage: 1, status: "en_cours", category: null, points: null, username };
  await writeHand(manche, discordId, hand);
  await resetKept(manche, discordId);

  const newState = {
    ...state,
    players: decision.players,
    rosterLocked: decision.rosterLocked,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(newState);

  return { state: newState, hand, kept: [false, false, false, false, false], used, isNew: true };
}

// ── Sélection des dés à conserver / relance ─────────────────────────

export async function toggleKept(discordId, index) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(discordId) };

  const kept = await readKept(manche, discordId);
  await setKeptField(manche, discordId, index, !kept[index]);
  const updatedKept = kept.map((k, i) => (i === index ? !k : k));
  const used = await readUsedCategories(discordId);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(newState);

  return { state: newState, hand, kept: updatedKept, used };
}

export async function relance(discordId) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(discordId) };

  const kept = await readKept(manche, discordId);
  const used = await readUsedCategories(discordId);
  const dice = rerollKept(hand.dice, kept, Math.random);
  const tirage = hand.tirage + 1;
  let updated;
  let nextKept;
  if (tirage >= 3) {
    const { category, points } = computeBestCombination(dice, used);
    updated = { ...hand, dice, tirage, status: "termine", category, points };
    await resetKept(manche, discordId);
    nextKept = [false, false, false, false, false];
  } else {
    updated = { ...hand, dice, tirage };
    // kept N'EST PAS réinitialisé (même retour utilisateur que le jeu
    // spécial, 16/09) : les dés déjà cochés "à garder" le restent au tirage
    // suivant.
    nextKept = kept;
  }
  await writeHand(manche, discordId, updated);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(newState);

  return { state: newState, hand: updated, kept: nextKept, used };
}

// Fige la main immédiatement si les dés courants forment déjà une
// combinaison (n'importe laquelle sauf "Aucune combinaison"), sans attendre
// les 2 relances — même règle que le jeu spécial (gobelet.js).
export async function valider(discordId) {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(discordId) };

  const used = await readUsedCategories(discordId);
  const { category, points } = computeBestCombination(hand.dice, used);
  if (category === NO_COMBINATION) {
    const kept = await readKept(manche, discordId);
    return { notEligible: true, state, hand, kept, used };
  }

  const updated = { ...hand, status: "termine", category, points };
  await writeHand(manche, discordId, updated);
  await resetKept(manche, discordId);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(newState);

  return { state: newState, hand: updated, kept: [false, false, false, false, false], used };
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

// Pure : une manche n'est résolue que si toutes les places sont occupées
// ET que chaque joueur inscrit a fini sa main. Un joueur seul sur 2 places
// qui termine sa main attend donc son adversaire au lieu de résoudre la
// manche seul.
export function isMancheReady(state, hands) {
  if (state.players.length < state.maxPlayers) return false;
  return state.players.every((id) => hands[id] && hands[id].status !== "en_cours");
}

// Appelée après CHAQUE action qui termine une main (3ᵉ tirage atteint) :
// vérifie si tous les joueurs inscrits ont fini leur main pour la manche en
// cours, et résout si c'est le cas.
export async function checkAndResolveManche() {
  const state = await readState();
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hands = await listHands(manche);
  if (!isMancheReady(state, hands)) return { resolved: false, state };

  const claimed = await claimResolution(manche);
  if (!claimed) return { resolved: false, alreadyResolving: true, state };

  const outcome = await resolveManche(state, hands);
  return { resolved: true, ...outcome };
}

// Pure : calcule les résultats de la manche et le classement mis à jour,
// sans écrire dans Redis.
export function computeMancheOutcome(state, hands, currentPoints) {
  const results = resolveJour(hands);
  const pointsAfter = { ...currentPoints };
  for (const r of results) {
    pointsAfter[r.discordId] = (pointsAfter[r.discordId] || 0) + r.points;
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
    await addPoints(r.discordId, r.points);
    const used = await readUsedCategories(r.discordId);
    const nextUsed = withUsedCategory(used, r.category);
    if (nextUsed !== used) await writeUsedCategories(r.discordId, nextUsed);
  }

  if (outcome.estFinDePartie) {
    const newState = { ...state, lastActivityAt: new Date().toISOString(), termine: true };
    await writeState(newState);
    return {
      final: true,
      results: outcome.results,
      ranking: outcome.ranking,
      state: newState,
    };
  }

  const newState = {
    ...state,
    manche: outcome.mancheSuivante,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(newState);
  return { final: false, results: outcome.results, state: newState };
}

// ── Watchdog anti-blocage ────────────────────────────────────────────
// Une partie où plus personne n'agit (manche bloquée en attente d'un
// joueur, ou partie jamais reprise) est nettoyée après STALE_HOURS. Un seul
// horodatage (lastActivityAt, mis à jour à chaque action) suffit à couvrir
// les deux cas.

export async function resetIfStale(now = Date.now()) {
  const state = await readState();
  if (!state || state.termine) return { skipped: true };

  const hoursSince = (now - new Date(state.lastActivityAt).getTime()) / 3_600_000;
  if (hoursSince < STALE_HOURS) return { skipped: true, hoursSince };

  await resetGobeletDuel();
  return { reset: true, hoursSince, previousState: state };
}
