// ============================================================
// blackjackDuel.js — Blackjack duel autonome (1 ou 2 joueurs, N manches),
// lancé à la demande via la commande /blackjack (rôle MINI-JEUX requis).
//
// Développé EN PARALLÈLE du jeu spécial (jeux/services/blackjack.js),
// sans aucun couplage d'état : espace de clés Redis dédié
// `blackjackduel:*`, entièrement séparé de `blackjack:*`. Seules les
// fonctions PURES de logique de cartes (drawCard, computeHandValue,
// dealerPlay, compareToDealer, resolveDay, buildRanking, isDealerRevealed)
// sont réutilisées par import direct — elles n'ont aucun état, les
// réutiliser ne crée donc aucun risque d'impact sur le jeu spécial.
//
// Différences structurelles avec le jeu spécial :
// - Lobby FERMÉ (1 ou 2 joueurs inscrits au lancement via le bouton Jouer,
//   pas un lobby ouvert à tous) ;
// - avancement piloté par les ACTIONS des joueurs (une manche se termine
//   dès que tous les sièges sont occupés et que chacun a joué), pas par un
//   cron quotidien ;
// - pas d'historique persistant (aucun équivalent à archiveManche /
//   writeHistoriqueEntry) ;
// - comme les autres duels : une partie par joueur contre Kévina (le Croupier),
//   une seule à 2 joueurs, chacune expirée 1 h après la dernière action
//   (TTL Redis, ni cron ni nettoyage manuel) ; `npm run blackjackduel:status`
//   liste les parties, `npm run blackjackduel:reset` les efface toutes.
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
  isDealerRevealed,
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

// ── Clés Redis : une partie par joueur contre Kévina (`<discordId>`),
// une seule à 2 joueurs (`pvp`), comme les autres duels. Chaque écriture
// relance l'expiration : sans action pendant INACTIVITE_SECONDES, la partie
// disparaît d'elle-même (pas de cron).
export const INACTIVITE_SECONDES = 3600;

// Identifiant de la partie lancée par `discordId` avec `maxPlayers` places.
export function gameIdFor(maxPlayers, discordId) {
  return maxPlayers === 1 ? discordId : "pvp";
}

const stateKey = (gid) => `blackjackduel:${gid}:state`;
const pointsKey = (gid) => `blackjackduel:${gid}:points`;
const usernamesKey = (gid) => `blackjackduel:${gid}:usernames`;
const resolvingKey = (gid) => `blackjackduel:${gid}:resolving`;
const handKey = (gid, manche) => `blackjackduel:${gid}:hand:${manche}`;
const webhookKey = (gid, manche) => `blackjackduel:${gid}:webhook:${manche}`;
// Meilleur score final de tous les temps, un record par format (5 ou 10
// manches : des totaux non comparables). JAMAIS effacé par la remise à zéro
// d'une partie.
const HIGHSCORE_KEY = "blackjackduel:highscore";

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

// Mêmes bornes que le Croupier du jeu spécial (jeux/data/blackjack/blackjack.json)
// — pas de fichier de config séparé, rien d'autre à y régler ici (le nombre
// de manches est un paramètre de commande, pas une config statique).
const DEALER_MIN = 16;
const DEALER_MAX = 21;

// ── État de la partie ──────────────────────────────────────────────

// gid absent : bouton d'un ancien message (avant les parties par joueur).
export async function readState(gid) {
  if (!gid) return null;
  return fromJson(await getRedis().get(stateKey(gid)));
}

// Relance aussi l'expiration des clés de la partie écrites plus rarement
// (points, pseudos, verrous de résolution), pour qu'elles vivent autant que l'état.
export async function writeState(gid, state) {
  await getRedis().set(stateKey(gid), toJson(state), { ex: INACTIVITE_SECONDES });
  for (const key of [pointsKey(gid), usernamesKey(gid), resolvingKey(gid)]) {
    await getRedis().expire(key, INACTIVITE_SECONDES);
  }
}

// ── Mains des joueurs (une par manche, hash `blackjackduel:<gid>:hand:<manche>`) ──

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

export { buildRanking, isDealerRevealed, pointsForResult };

// ── Remise à zéro ───────────────────────────────────────────────────

async function resetGame(gid) {
  await getRedis().del(stateKey(gid), pointsKey(gid), usernamesKey(gid), resolvingKey(gid));
  await scanDelete(`blackjackduel:${gid}:hand:*`);
  await scanDelete(`blackjackduel:${gid}:webhook:*`);
}

// Toutes les parties en cours (script de statut).
export async function listGames() {
  const keys = await scanKeys("blackjackduel:*:state");
  const games = [];
  for (const key of keys) {
    const state = fromJson(await getRedis().get(key));
    if (state) games.push({ gid: key.split(":")[1], state });
  }
  return games;
}

// Efface toutes les parties (y compris les clés de l'ancien format à
// partie unique), jamais le high score.
export async function resetBlackjackDuel() {
  const keys = (await scanKeys("blackjackduel:*")).filter((k) => k !== HIGHSCORE_KEY);
  if (keys.length) await getRedis().del(...keys);
}

// ── Lancement d'une partie ──────────────────────────────────────────
// Contre Kévina : relancer remplace toujours sa propre partie
// (`replaced`, dont l'appelant supprime le message public). À 2 joueurs :
// refusé tant qu'une partie non terminée existe (elle expire seule après
// INACTIVITE_SECONDES sans action).

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

  // Croupier uniquement en solo (1 joueur) — à 2 joueurs, pas de
  // Croupier : les joueurs s'affrontent directement (voir resolvePvP), le
  // jeu redevient un vrai "duel" plutôt qu'un multi-solo côte à côte.
  const dealer = maxPlayers === 1 ? dealerPlay(Math.random, DEALER_MIN, DEALER_MAX) : null;
  const state = {
    gid,
    ownerId: discordId,
    channelId,
    messageId: null,
    maxPlayers,
    totalManches,
    manche: 1,
    dealer,
    players: [],
    rosterLocked: false,
    // Historique des manches résolues (mains, scores, points) — affiché en
    // intégralité dans le récapitulatif final (voir buildFinalEmbed).
    history: [],
    lastActivityAt: new Date().toISOString(),
    termine: false,
  };
  await writeState(gid, state);
  return { state, replaced };
}

// ── Bouton [Jouer] — inscription (si nouveau siège libre) + distribution ──
// Idempotent comme le jeu spécial : un clic sur une main déjà distribuée
// pour la manche en cours la renvoie telle quelle sans rien muter.

// Pure : décide si un joueur peut occuper un siège (déjà inscrit, ou
// inscription libre) et calcule le roster/verrou résultant. Appelée
// uniquement quand l'appelant a déjà vérifié (I/O) qu'aucune main n'existe
// encore pour ce joueur sur la manche en cours.
export function applyJoin(state, discordId) {
  // Contre Kévina, la partie est réservée à celui qui l'a lancée.
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
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const existingHand = await readHand(gid, manche, discordId);
  if (existingHand) {
    return { state, hand: existingHand, isNew: false };
  }

  const decision = applyJoin(state, discordId);
  if (decision.notYours) return { notYours: true, state };
  if (!decision.allowed) return { rosterLocked: true, state };

  const first = drawCard();
  const cards = [first, drawUniqueCard([first])];
  const score = computeHandValue(cards);
  const status = score === 21 ? "stand" : "en_cours";
  const hand = { cards, score, status, username };
  await writeHand(gid, manche, discordId, hand);

  const newState = {
    ...state,
    players: decision.players,
    rosterLocked: decision.rosterLocked,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(gid, newState);

  return { state: newState, hand, isNew: true };
}

// ── Boutons [Piocher] / [Arrêter] ────────────────────────────────────

export async function drawOrStand(gid, discordId, { draw }) {
  const state = await readState(gid);
  if (!state || state.termine) return { inactive: true };

  const manche = state.manche;
  const hand = await readHand(gid, manche, discordId);
  if (!hand) return { noHand: true, state };
  if (hand.status !== "en_cours") return { alreadyDone: true, state, hand };

  const cards = draw ? [...hand.cards, drawUniqueCard(hand.cards)] : hand.cards;
  const score = computeHandValue(cards);
  const status = !draw ? "stand" : score > 21 ? "bust" : score === 21 ? "stand" : "en_cours";
  const updated = { ...hand, cards, score, status };
  await writeHand(gid, manche, discordId, updated);

  const newState = { ...state, lastActivityAt: new Date().toISOString() };
  await writeState(gid, newState);

  return { state: newState, hand: updated };
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
  return state.players.every((id) => hands[id] && hands[id].status !== "en_cours");
}

// Appelée après CHAQUE action qui termine une main (Jouer avec 21 naturel,
// Piocher jusqu'au bust, Arrêter) : vérifie si tous les joueurs inscrits ont
// fini leur main pour la manche en cours, et résout si c'est le cas.
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

// Pure : résout une manche à 2 joueurs SANS Croupier — la meilleure main
// non bust l'emporte (2 points, comme une victoire face au Croupier) ; en
// cas d'égalité au sommet, tous les joueurs à égalité se partagent 1 point
// chacun (même barème qu'une égalité face au Croupier — voir
// pointsForResult) ; si tout le monde bust, personne ne gagne la manche.
export function resolvePvP(hands) {
  const entries = Object.entries(hands).map(([discordId, hand]) => {
    const finalStatus = hand.status === "en_cours" ? "stand" : hand.status;
    return {
      discordId,
      username: hand.username,
      cards: hand.cards,
      score: hand.score,
      status: finalStatus,
    };
  });
  const valid = entries.filter((e) => e.status !== "bust");
  const maxScore = valid.length ? Math.max(...valid.map((e) => e.score)) : null;
  const topCount = valid.filter((e) => e.score === maxScore).length;
  return entries.map((e) => {
    if (e.status === "bust" || e.score !== maxScore) return { ...e, result: "lose" };
    return { ...e, result: topCount > 1 ? "push" : "win" };
  });
}

// Pure : calcule les résultats de la manche (face au Croupier en solo,
// entre les 2 joueurs) et le classement mis à jour, sans écrire dans Redis
// (le tirage du prochain Croupier, lui, reste dans le caller I/O
// ci-dessous — pas besoin de le prédire pour décider si la partie est finie).
export function computeMancheOutcome(state, hands, currentPoints) {
  const results = state.maxPlayers === 1 ? resolveDay(hands, state.dealer) : resolvePvP(hands);
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

async function resolveManche(gid, state, hands) {
  const currentPoints = await readPoints(gid);
  const outcome = computeMancheOutcome(state, hands, currentPoints);

  for (const r of outcome.results) {
    await addPoints(gid, r.discordId, pointsForResult(r.result));
  }

  // Historique complet (mains, scores, points) de la manche qui vient de se
  // résoudre — affiché en intégralité dans le récapitulatif final, voir
  // buildFinalEmbed côté handler. Le Croupier n'y figure que pour les
  // manches solo (null en duel à 2 joueurs, voir resolvePvP).
  const mancheRecord = {
    manche: state.manche,
    dealer: state.maxPlayers === 1 ? state.dealer : null,
    results: outcome.results,
  };
  const history = [...(state.history || []), mancheRecord];

  if (outcome.estFinDePartie) {
    const newState = { ...state, history, lastActivityAt: new Date().toISOString(), termine: true };
    await writeState(gid, newState);
    const highScore = await updateHighScore(gid, state.totalManches, outcome.ranking);
    return {
      final: true,
      highScore,
      dealer: state.dealer,
      results: outcome.results,
      ranking: outcome.ranking,
      state: newState,
    };
  }

  const nextDealer = state.maxPlayers === 1 ? dealerPlay(Math.random, DEALER_MIN, DEALER_MAX) : null;
  const newState = {
    ...state,
    manche: outcome.mancheSuivante,
    dealer: nextDealer,
    history,
    lastActivityAt: new Date().toISOString(),
  };
  await writeState(gid, newState);
  return { final: false, dealer: state.dealer, results: outcome.results, state: newState };
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
