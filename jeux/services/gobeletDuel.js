// ============================================================
// gobeletDuel.js — Jeu du Gobelet, duel autonome (1 ou 2 joueurs, N manches),
// lancé à la demande via la commande /gobelet (rôle MINI-JEUX requis).
//
// Développé EN PARALLÈLE du jeu spécial (jeux/services/gobelet.js), sans
// aucun couplage d'état : espace de clés Redis dédié `gobeletduel:*`,
// entièrement séparé de `gobelet:*`. Seules les fonctions PURES de logique
// de dés (rollDice, rerollKept, computeBestCombination, resolveJour,
// buildRanking) sont réutilisées par import direct — elles n'ont aucun
// état, les réutiliser ne crée donc aucun risque d'impact sur le jeu
// spécial. Même principe exact que blackjackDuel.js vis-à-vis de
// blackjack.js.
//
// Différences structurelles avec le jeu spécial :
// - Lobby FERMÉ (1 ou 2 joueurs inscrits au lancement via le bouton Jouer,
//   pas un lobby ouvert à tous) ;
// - avancement piloté par les ACTIONS des joueurs (une manche se termine
//   dès que tous les sièges sont occupés et que chacun a terminé ses 3
//   tirages), pas par un cron quotidien ;
// - pas d'historique persistant (aucun équivalent à archiveManche /
//   writeHistoriqueEntry) ;
// - comme les autres duels : une partie par joueur en solo, une seule à
//   2 joueurs, chacune expirée 1 h après la dernière action (TTL Redis, ni
//   cron ni nettoyage manuel) ; `npm run gobeletduel:status` liste les
//   parties, `npm run gobeletduel:reset` les efface toutes.
// ============================================================

import { Redis } from "@upstash/redis";
import {
  rollDice,
  rerollKept,
  computeBestCombination,
  finishHand,
  pickChoice,
  resolveJour,
  buildRanking,
  withUsedCategory,
  withHandLock,
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

// ── Clés Redis : une partie par joueur en solo (`<discordId>`), une seule
// à 2 joueurs (`pvp`), comme les autres duels. Chaque écriture relance
// l'expiration : sans action pendant INACTIVITE_SECONDES, la partie
// disparaît d'elle-même (pas de cron).
export const INACTIVITE_SECONDES = 3600;

// Identifiant de la partie lancée par `discordId` avec `maxPlayers` places.
export function gameIdFor(maxPlayers, discordId) {
  return maxPlayers === 1 ? discordId : "pvp";
}

const stateKey = (gid) => `gobeletduel:${gid}:state`;
const pointsKey = (gid) => `gobeletduel:${gid}:points`;
const usernamesKey = (gid) => `gobeletduel:${gid}:usernames`;
const resolvingKey = (gid) => `gobeletduel:${gid}:resolving`;
const usedKey = (gid) => `gobeletduel:${gid}:used`;
const handKey = (gid, manche) => `gobeletduel:${gid}:hand:${manche}`;
const webhookKey = (gid, manche) => `gobeletduel:${gid}:webhook:${manche}`;
// Meilleur score final de tous les temps, un record par format (5 ou 10
// manches : des totaux non comparables). JAMAIS effacé par la remise à zéro
// d'une partie.
const HIGHSCORE_KEY = "gobeletduel:highscore";

// Webhook de la main éphémère de chaque joueur ayant fini sa manche : à la
// résolution, le bouton « Manche suivante » y est activé (jeton valable
// 15 min, au-delà le bouton Jouer du message public reste le recours).
const WEBHOOK_TTL_SECONDS = 15 * 60;

export async function saveHandWebhook(gid, manche, discordId, webhookUrl) {
  if (!webhookUrl) return;
  await getRedis().hset(webhookKey(gid, manche), { [discordId]: webhookUrl });
  await getRedis().expire(webhookKey(gid, manche), WEBHOOK_TTL_SECONDS);
}

export async function readHandWebhooks(gid, manche) {
  return hgetallRaw(webhookKey(gid, manche));
}

// ── État de la partie ──────────────────────────────────────────────

// gid absent : bouton d'un ancien message (avant les parties par joueur).
export async function readState(gid) {
  if (!gid) return null;
  return fromJson(await getRedis().get(stateKey(gid)));
}

// Relance aussi l'expiration des clés de la partie écrites plus rarement
// (points, pseudos, verrous de résolution, combinaisons réalisées), pour
// qu'elles vivent autant que l'état.
export async function writeState(gid, state) {
  await getRedis().set(stateKey(gid), toJson(state), { ex: INACTIVITE_SECONDES });
  for (const key of [pointsKey(gid), usernamesKey(gid), resolvingKey(gid), usedKey(gid)]) {
    await getRedis().expire(key, INACTIVITE_SECONDES);
  }
}

// ── Mains des joueurs (une par manche, hash `gobeletduel:<gid>:hand:<manche>`) ──

export async function readHand(gid, manche, discordId) {
  return fromJson(await getRedis().hget(handKey(gid, manche), discordId));
}

async function writeHand(gid, manche, discordId, hand) {
  await getRedis().hset(handKey(gid, manche), { [discordId]: toJson(hand) });
  await getRedis().expire(handKey(gid, manche), INACTIVITE_SECONDES);
  if (hand.username) {
    await getRedis().hset(usernamesKey(gid), { [discordId]: hand.username });
  }
}

export async function listHands(gid, manche) {
  return hgetallJson(handKey(gid, manche));
}

// ── Dés conservés (un champ Redis par dé, PAS un tableau dans le blob JSON
// de la main) — même correctif que le jeu spécial (gobelet.js) pour la même
// race condition : deux clics quasi simultanés sur des dés DIFFÉRENTS
// écrasaient le tableau `kept` en repartant d'une lecture antérieure à
// l'écriture de l'autre clic. Isoler chaque dé dans son propre champ de
// hash Redis élimine ce conflit.
function keptKey(gid, manche, discordId) {
  return `gobeletduel:${gid}:kept:${manche}:${discordId}`;
}

export async function readKept(gid, manche, discordId) {
  const raw = await hgetallRaw(keptKey(gid, manche, discordId));
  return [0, 1, 2, 3, 4].map((i) => raw[String(i)] === "1");
}

async function setKeptField(gid, manche, discordId, index, value) {
  await getRedis().hset(keptKey(gid, manche, discordId), { [String(index)]: value ? "1" : "0" });
  await getRedis().expire(keptKey(gid, manche, discordId), INACTIVITE_SECONDES);
}

async function resetKept(gid, manche, discordId) {
  await getRedis().del(keptKey(gid, manche, discordId));
}

// ── Combinaisons déjà réalisées (partie en cours) ───────────────────
// Hash `gobeletduel:<gid>:used` : discordId -> tableau JSON des catégories
// marquées lors des manches déjà résolues (chaque combinaison ne rapporte
// qu'une fois par partie, voir computeBestCombination). Mis à jour
// uniquement dans resolveManche, protégé par claimResolution.

export async function readUsedCategories(gid, discordId) {
  return fromJson(await getRedis().hget(usedKey(gid), discordId)) || [];
}

// Combinaisons déjà réalisées par les ADVERSAIRES du joueur (duel
// uniquement — pas dans le jeu spécial, où les joueurs sont trop nombreux) :
// aspect tactique, chacun voit ce que les autres ont déjà "consommé".
export async function readOpponentsUsed(state, discordId) {
  const others = state.players.filter((id) => id !== discordId);
  if (others.length === 0) return [];
  const [allUsed, usernames] = await Promise.all([hgetallJson(usedKey(state.gid)), hgetallRaw(usernamesKey(state.gid))]);
  return others.map((id) => ({ discordId: id, username: usernames[id] || null, used: allUsed[id] || [] }));
}

async function writeUsedCategories(gid, discordId, used) {
  await getRedis().hset(usedKey(gid), { [discordId]: toJson(used) });
}

// ── Points cumulés sur la partie en cours ──────────────────────────

async function addPoints(gid, discordId, amount) {
  if (amount <= 0) return;
  await getRedis().hincrby(pointsKey(gid), discordId, amount);
}

export async function readPoints(gid) {
  const raw = await hgetallRaw(pointsKey(gid));
  const result = {};
  for (const [discordId, value] of Object.entries(raw)) {
    result[discordId] = Number(value) || 0;
  }
  return result;
}

export { buildRanking };

// ── Remise à zéro ───────────────────────────────────────────────────

async function resetGame(gid) {
  await getRedis().del(stateKey(gid), pointsKey(gid), usernamesKey(gid), resolvingKey(gid), usedKey(gid));
  await scanDelete(`gobeletduel:${gid}:hand:*`);
  await scanDelete(`gobeletduel:${gid}:webhook:*`);
  await scanDelete(`gobeletduel:${gid}:kept:*`);
}

// Toutes les parties en cours (script de statut).
export async function listGames() {
  const keys = await scanKeys("gobeletduel:*:state");
  const games = [];
  for (const key of keys) {
    const state = fromJson(await getRedis().get(key));
    if (state) games.push({ gid: key.split(":")[1], state });
  }
  return games;
}

// Efface toutes les parties (y compris les clés de l'ancien format à
// partie unique), jamais le high score.
export async function resetGobeletDuel() {
  const keys = (await scanKeys("gobeletduel:*")).filter((k) => k !== HIGHSCORE_KEY);
  if (keys.length) await getRedis().del(...keys);
}

// ── Lancement d'une partie ──────────────────────────────────────────
// En solo : relancer remplace toujours sa propre partie (`replaced`, dont
// l'appelant supprime le message public). À 2 joueurs : refusé tant qu'une
// partie non terminée existe (elle expire seule après INACTIVITE_SECONDES
// sans action).

export async function startGame(channelId, discordId, { maxPlayers, totalManches }) {
  const gid = gameIdFor(maxPlayers, discordId);
  const existing = await readState(gid);
  if (existing && !existing.termine && maxPlayers > 1) {
    return { alreadyActive: true, state: existing };
  }
  const replaced = existing && !existing.termine ? existing : null;

  // Nettoie les résidus de la partie précédente (points/mains/verrous de
  // résolution) avant de repartir à zéro.
  await resetGame(gid);

  const state = {
    gid,
    ownerId: discordId,
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
  await writeState(gid, state);
  return { state, replaced };
}

// Verrou par joueur (voir withHandLock dans gobelet.js) : un clic arrivé
// pendant le traitement d'un autre renvoie { busy: true } et est ignoré.
function handLockKey(discordId) {
  return `gobeletduel:lock:${discordId}`;
}

// ── Bouton [Jouer] — inscription (si nouveau siège libre) + 1ᵉʳ tirage ──
// Idempotent comme le jeu spécial : un clic sur une main déjà distribuée
// pour la manche en cours la renvoie telle quelle sans rien muter.

// Pure : décide si un joueur peut occuper un siège (déjà inscrit, ou
// inscription libre) et calcule le roster/verrou résultant. Appelée
// uniquement quand l'appelant a déjà vérifié (I/O) qu'aucune main n'existe
// encore pour ce joueur sur la manche en cours.
export function applyJoin(state, discordId) {
  // En solo, la partie est réservée à celui qui l'a lancée.
  if (state.maxPlayers === 1 && state.ownerId && discordId !== state.ownerId) {
    return { allowed: false, notYours: true };
  }
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

export async function joinAndDeal(gid, discordId, username) {
  return withHandLock(handLockKey(discordId), () => joinAndDealUnlocked(gid, discordId, username));
}

async function joinAndDealUnlocked(gid, discordId, username) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const existingHand = await readHand(gid, manche, discordId);
  const used = await readUsedCategories(gid, discordId);
  const opponents = await readOpponentsUsed(state, discordId);
  if (existingHand) {
    const kept = existingHand.status === "en_cours" ? await readKept(gid, manche, discordId) : [false, false, false, false, false];
    return { state, hand: existingHand, kept, used, opponents, isNew: false };
  }

  const decision = applyJoin(state, discordId);
  if (decision.notYours) return { notYours: true, state };
  if (!decision.allowed) return { rosterLocked: true, state };

  const dice = rollDice(5);
  const hand = { dice, tirage: 1, status: "en_cours", category: null, points: null, username };
  await writeHand(gid, manche, discordId, hand);
  await resetKept(gid, manche, discordId);

  const newState = {
    ...state,
    players: decision.players,
    rosterLocked: decision.rosterLocked,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(gid, newState);

  return { state: newState, hand, kept: [false, false, false, false, false], used, opponents, isNew: true };
}

// ── Sélection des dés à conserver / relance ─────────────────────────

export async function toggleKept(gid, discordId, index) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(gid, manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(gid, discordId), opponents: await readOpponentsUsed(state, discordId) };

  const kept = await readKept(gid, manche, discordId);
  await setKeptField(gid, manche, discordId, index, !kept[index]);
  const updatedKept = kept.map((k, i) => (i === index ? !k : k));
  const used = await readUsedCategories(gid, discordId);
  const opponents = await readOpponentsUsed(state, discordId);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(gid, newState);

  return { state: newState, hand, kept: updatedKept, used, opponents };
}

export async function relance(gid, discordId) {
  return withHandLock(handLockKey(discordId), () => relanceUnlocked(gid, discordId));
}

async function relanceUnlocked(gid, discordId) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(gid, manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(gid, discordId), opponents: await readOpponentsUsed(state, discordId) };

  const kept = await readKept(gid, manche, discordId);
  const used = await readUsedCategories(gid, discordId);
  const opponents = await readOpponentsUsed(state, discordId);
  const dice = rerollKept(hand.dice, kept, Math.random);
  const tirage = hand.tirage + 1;
  let updated;
  let nextKept;
  if (tirage >= 3) {
    updated = finishHand({ ...hand, dice, tirage }, used);
    await resetKept(gid, manche, discordId);
    nextKept = [false, false, false, false, false];
  } else {
    updated = { ...hand, dice, tirage };
    // kept N'EST PAS réinitialisé (même retour utilisateur que le jeu
    // spécial, 16/09) : les dés déjà cochés "à garder" le restent au tirage
    // suivant.
    nextKept = kept;
  }
  await writeHand(gid, manche, discordId, updated);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(gid, newState);

  return { state: newState, hand: updated, kept: nextKept, used, opponents };
}

// Fige la main immédiatement si les dés courants forment déjà une
// combinaison (n'importe laquelle sauf "Aucune combinaison"), sans attendre
// les 2 relances — même règle que le jeu spécial (gobelet.js).
export async function valider(gid, discordId) {
  return withHandLock(handLockKey(discordId), () => validerUnlocked(gid, discordId));
}

async function validerUnlocked(gid, discordId) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(gid, manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand, used: await readUsedCategories(gid, discordId), opponents: await readOpponentsUsed(state, discordId) };

  const used = await readUsedCategories(gid, discordId);
  const opponents = await readOpponentsUsed(state, discordId);
  const { category } = computeBestCombination(hand.dice, used, { allowJoker: false });
  if (category === NO_COMBINATION) {
    const kept = await readKept(gid, manche, discordId);
    return { notEligible: true, state, hand, kept, used, opponents };
  }

  const updated = finishHand(hand, used);
  await writeHand(gid, manche, discordId, updated);
  await resetKept(gid, manche, discordId);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(gid, newState);

  return { state: newState, hand: updated, kept: [false, false, false, false, false], used, opponents };
}

// Combinaison choisie dans le select de fin de main (main en statut
// "choix", voir finishHand dans gobelet.js). Un choix invalide (ancien
// message, main déjà figée) renvoie simplement l'état réel.
export async function choisir(gid, discordId, category) {
  return withHandLock(handLockKey(discordId), () => choisirUnlocked(gid, discordId, category));
}

async function choisirUnlocked(gid, discordId, category) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(gid, manche, discordId);
  if (!hand) return { noHand: true, state };

  const used = await readUsedCategories(gid, discordId);
  const opponents = await readOpponentsUsed(state, discordId);
  const updated = pickChoice(hand, used, category);
  if (!updated) return { alreadyDone: true, state, hand, used, opponents };

  await writeHand(gid, manche, discordId, updated);
  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(gid, newState);

  return { state: newState, hand: updated, kept: [false, false, false, false, false], used, opponents };
}

// ── Résolution de fin de manche (concurrence) ───────────────────────
// Même idiome que assignSeasonMancheNumber (anagrams.js/frames.js/zoom.js) :
// HSETNX atomique, seul le 1er appelant qui réussit exécute la résolution —
// évite une double résolution si les 2 derniers joueurs cliquent au même
// instant. Les appels perdants ont déjà sauvegardé leur main avant ce
// check, rien n'est perdu.
async function claimResolution(gid, manche) {
  const claimed = Number(await getRedis().hsetnx(resolvingKey(gid), String(manche), "1"));
  return claimed === 1;
}

// Pure : une manche n'est résolue que si toutes les places sont occupées
// ET que chaque joueur inscrit a fini sa main. Un joueur seul sur 2 places
// qui termine sa main attend donc son adversaire au lieu de résoudre la
// manche seul.
export function isMancheReady(state, hands) {
  if (state.players.length < state.maxPlayers) return false;
  // Une main en attente de choix ("choix") n'est pas finie : la manche
  // attend que le joueur choisisse sa combinaison.
  return state.players.every((id) => hands[id] && hands[id].status === "termine");
}

// Appelée après CHAQUE action qui termine une main (3ᵉ tirage atteint) :
// vérifie si tous les joueurs inscrits ont fini leur main pour la manche en
// cours, et résout si c'est le cas.
export async function checkAndResolveManche(gid) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hands = await listHands(gid, manche);
  if (!isMancheReady(state, hands)) return { resolved: false, state };

  const claimed = await claimResolution(gid, manche);
  if (!claimed) return { resolved: false, alreadyResolving: true, state };

  const outcome = await resolveManche(gid, state, hands);
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

async function resolveManche(gid, state, hands) {
  const currentPoints = await readPoints(gid);
  const outcome = computeMancheOutcome(state, hands, currentPoints);

  for (const r of outcome.results) {
    await addPoints(gid, r.discordId, r.points);
    const used = await readUsedCategories(gid, r.discordId);
    const nextUsed = withUsedCategory(used, r.category);
    if (nextUsed !== used) await writeUsedCategories(gid, r.discordId, nextUsed);
  }

  if (outcome.estFinDePartie) {
    const newState = { ...state, lastActivityAt: new Date().toISOString(), termine: true };
    await writeState(gid, newState);
    const highScore = await updateHighScore(gid, state.totalManches, outcome.ranking);
    return {
      final: true,
      highScore,
      results: outcome.results,
      ranking: outcome.ranking,
      state: newState,
    };
  }

  const newState = {
    ...state,
    manche: outcome.mancheSuivante,
    // Conservé pour réafficher le bilan de la manche précédente à chaque
    // rafraîchissement du message public (pas seulement à la résolution).
    lastResults: outcome.results,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(gid, newState);
  return { final: false, results: outcome.results, state: newState };
}

// ── High score (record par format de partie) ─────────────────────────

// Pure : strictement supérieur à l'ancien record (une égalité ne détrône
// pas le détenteur), jamais un score nul.
export function isNewHighScore(current, points) {
  return points > 0 && (!current || points > current.points);
}

async function updateHighScore(gid, totalManches, ranking) {
  const field = String(totalManches);
  const current = fromJson(await getRedis().hget(HIGHSCORE_KEY, field));
  const top = ranking?.[0];
  if (!top || !isNewHighScore(current, top.points)) return current;
  const username = await getRedis().hget(usernamesKey(gid), top.discordId);
  const record = { discordId: top.discordId, username: username || null, points: top.points, at: new Date().toISOString() };
  await getRedis().hset(HIGHSCORE_KEY, { [field]: toJson(record) });
  return record;
}
