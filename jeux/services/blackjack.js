// ============================================================
// blackjack.js — Blackjack (7 jours, 1 point de victoire par jour gagné
// contre le Croupier, classement cumulé au Jour 7). Couche métier : tirage
// des cartes (sabot virtuel par joueur, probabilités d'un jeu de 52 cartes
// réinjecté), main du Croupier, résolution quotidienne, points, historique.
//
// Stockage : Upstash Redis (même instance que les autres jeux), espace de
// clés `blackjack:*`.
//
// ⚠️ automaticDeserialization désactivée volontairement : le SDK convertit
// par défaut toute valeur "numérique" en Number JS, y compris les IDs
// Discord (17-19 chiffres) qui dépassent Number.MAX_SAFE_INTEGER — ça les
// corrompt silencieusement. On sérialise/désérialise le JSON nous-mêmes.
//
// ⚠️ Sabot virtuel PAR JOUEUR (pas un deck de 52 cartes partagé qui
// s'épuiserait) : chaque tirage est un rang uniforme parmi les 13
// (probabilité 4/52 = 1/13 chacun, identique à un vrai deck), rejoué à
// l'infini. Décision explicite : un deck partagé unique imposerait un ordre
// de tirage entre joueurs concurrents (qui pioche en premier ?), sans
// bénéfice réel pour un jeu où chaque joueur affronte le Croupier seul.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { noterJeuSpecial } from "./passeport.js";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "blackjack", "blackjack.json");

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
// [champ1, valeur1, ...] et non un objet.
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

const STATE_KEY = "blackjack:state";
const POINTS_KEY = "blackjack:points";
const USERNAMES_KEY = "blackjack:usernames";
const HISTORIQUE_KEY = "blackjack:historique";
const MANCHES_KEY = "blackjack:manches";
const MANCHE_SEQ_KEY = "blackjack:manche_seq";

function handKey(jour) {
  return `blackjack:hand:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadBlackjackConfig() {
  if (configCache) return configCache;
  const txt = await fs.readFile(CONFIG_JSON_PATH, "utf-8");
  configCache = JSON.parse(txt);
  return configCache;
}

// ── État de la partie (muté uniquement au cron, jamais en concurrence) ──

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// Garde-fou anti-double-avancée (même incident/pattern que Robinson/Quiz,
// 26-27/08) : un cron `schedule` en retard peut encore se déclencher après
// qu'un admin a relancé le jour à la main entretemps — sans ce filet, les
// deux appels à postBlackjack() clôtureraient chacun un jour d'affilée.
// MIN_HOURS_BETWEEN_CLOSURES reste très en dessous du cycle normal (~24h),
// donc sans impact sur le fonctionnement quotidien légitime.
export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  const hoursSince = (now - new Date(publishedAt).getTime()) / 3_600_000;
  return hoursSince < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── Cartes — fonctions pures de logique de jeu (testées unitairement) ──

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠️", "♥️", "♦️", "♣️"];
const FACE_VALUES = { A: 11, J: 10, Q: 10, K: 10 };

function rankValue(rank) {
  return FACE_VALUES[rank] ?? Number(rank);
}

// Rang uniforme parmi les 13 (chacun a exactement 4 exemplaires sur 52,
// donc 4/52 = 1/13 — un tirage uniforme du rang reproduit fidèlement la
// probabilité d'un vrai deck sans avoir à modéliser les 52 cartes une à
// une). La couleur, elle, est purement cosmétique (aucun impact sur le
// score) et tirée indépendamment.
export function drawCard(rng = Math.random) {
  const rank = RANKS[Math.floor(rng() * RANKS.length)];
  const suit = SUITS[Math.floor(rng() * SUITS.length)];
  return { rank, suit, value: rankValue(rank) };
}

function cardSignature(card) {
  return `${card.rank}${card.suit}`;
}

// Comme drawCard, mais exclut les cartes (rang+couleur EXACTS) déjà
// présentes dans la main — un rang qui revient est normal (4 exemplaires
// sur 52, voir drawCard ci-dessus), mais la carte identique (ex. deux As de
// Pique) n'existe qu'en un seul exemplaire dans un vrai deck. Le tirage du
// RANG reste uniforme (aucun rang n'est exclu, seule la combinaison
// rang+couleur déjà vue est réessayée) — la distribution des rangs n'est
// donc pas affectée par ce garde-fou. `attempts` borné : filet de sécurité
// théorique, jamais atteint en pratique (52 combinaisons possibles pour une
// main d'une poignée de cartes).
export function drawUniqueCard(existingCards, rng = Math.random) {
  const used = new Set(existingCards.map(cardSignature));
  let card;
  let attempts = 0;
  do {
    card = drawCard(rng);
    attempts += 1;
  } while (used.has(cardSignature(card)) && attempts < 100);
  return card;
}

// As compté à 11 par défaut, ramené à 1 tant que le total dépasse 21 et
// qu'il reste un As encore compté à 11 ("main dure" une fois tous les As
// ramenés à 1, ou s'il n'y en a aucun).
export function computeHandValue(cards) {
  let total = cards.reduce((sum, c) => sum + c.value, 0);
  let acesAsEleven = cards.filter((c) => c.rank === "A").length;
  while (total > 21 && acesAsEleven > 0) {
    total -= 10;
    acesAsEleven -= 1;
  }
  return total;
}

// ── Règles officielles (Croupier, Blackjack naturel, Doubler) ──────────
// Simulées avant adoption : jeux/outils/blackjack-simulation/simulation.mjs.

// Blackjack naturel : 21 avec les 2 cartes de départ (jamais après Doubler,
// qui ajoute une 3ᵉ carte).
export function isNatural(cards) {
  return Array.isArray(cards) && cards.length === 2 && computeHandValue(cards) === 21;
}

// Croupier officiel : 2 cartes (la première visible, la seconde cachée),
// puis il pioche jusqu'à 17 et reste sur tout 17, souple compris. Sa main
// est tirée en entier à l'ouverture (sabot infini, indépendant des joueurs)
// et dévoilée après les joueurs. Il peut dépasser 21.
export function dealerPlay(rng = Math.random) {
  const cards = [drawCard(rng)];
  cards.push(drawUniqueCard(cards, rng));
  while (computeHandValue(cards) < 17) cards.push(drawUniqueCard(cards, rng));
  return { cards, score: computeHandValue(cards) };
}

export function dealerHasNatural(dealer) {
  return Boolean(dealer) && isNatural(dealer.cards);
}

// Issue d'une main face au Croupier : `blackjack` (naturel du joueur seul),
// `win`, `push` ou `lose`. Un dépassement du joueur perd toujours, même si
// le Croupier dépasse aussi. Naturel contre naturel : égalité.
export function compareToDealer(hand, dealer) {
  if (hand.status === "bust" || hand.score > 21) return "lose";
  const joueurNaturel = isNatural(hand.cards) && !hand.double;
  const croupierNaturel = dealerHasNatural(dealer);
  if (joueurNaturel && croupierNaturel) return "push";
  if (joueurNaturel) return "blackjack";
  if (croupierNaturel) return "lose";
  if (dealer.score > 21 || hand.score > dealer.score) return "win";
  if (hand.score === dealer.score) return "push";
  return "lose";
}

// Barème : victoire 2, égalité 1 (une égalité ne compte pas comme une
// défaite), Blackjack naturel 3 (le « paie 3 pour 2 »), défaite 0. Une main
// doublée compte double (victoire 4, égalité 2).
export function pointsForResult(result, double = false) {
  const base = { blackjack: 3, win: 2, push: 1 }[result] ?? 0;
  return double ? base * 2 : base;
}

// Main de départ : 2 cartes. Elle s'arrête d'office sur un 21, ou si le
// Croupier a un Blackjack (il le vérifie avant que les joueurs jouent :
// aucune décision ne changerait l'issue). `dealer` null en 1v1.
export function dealHand(username, dealer, rng = Math.random) {
  const first = drawCard(rng);
  const cards = [first, drawUniqueCard([first], rng)];
  const score = computeHandValue(cards);
  const status = score === 21 || dealerHasNatural(dealer) ? "stand" : "en_cours";
  return { cards, score, status, username };
}

// Doubler : seulement sur les 2 cartes de départ.
export function canDouble(hand) {
  return hand.status === "en_cours" && hand.cards.length === 2 && !hand.double;
}

// Action sur une main en cours : `piocher`, `arreter` ou `doubler` (une
// seule carte de plus, puis la main s'arrête ; points doublés). Pure.
export function applyHandAction(hand, action, rng = Math.random) {
  if (action === "arreter") return { ...hand, status: "stand" };
  if (action === "doubler" && !canDouble(hand)) return hand;
  const cards = [...hand.cards, drawUniqueCard(hand.cards, rng)];
  const score = computeHandValue(cards);
  const double = action === "doubler" || Boolean(hand.double);
  const status = score > 21 ? "bust" : action === "doubler" || score === 21 ? "stand" : "en_cours";
  return { ...hand, cards, score, status, ...(double ? { double: true } : {}) };
}

// Résout toutes les mains d'un jour face à la main du Croupier de ce
// jour-là. Une main encore "en_cours" à la clôture (joueur qui n'a jamais
// cliqué Arrêter) est figée sur son score courant plutôt qu'ignorée — un
// joueur qui a commencé sa main mérite d'être jugé sur ce qu'il a, pas
// exclu du classement. Fonction pure (aucun I/O) : appelée aussi bien pour
// la vraie clôture que pour un aperçu --dry-run.
export function resolveDay(hands, dealer) {
  return Object.entries(hands).map(([discordId, hand]) => {
    const finalStatus = hand.status === "en_cours" ? "stand" : hand.status;
    const result = compareToDealer({ ...hand, status: finalStatus }, dealer);
    return {
      discordId,
      username: hand.username,
      cards: hand.cards,
      score: hand.score,
      status: finalStatus,
      result,
      ...(hand.double ? { double: true } : {}),
    };
  });
}

// ── Mains des joueurs (une par jour, hash `blackjack:hand:<jour>`) ────

export async function readHand(jour, discordId) {
  return fromJson(await getRedis().hget(handKey(jour), discordId));
}

export async function writeHand(jour, discordId, hand) {
  await getRedis().hset(handKey(jour), { [discordId]: toJson(hand) });
  if (hand.username) {
    await getRedis().hset(USERNAMES_KEY, { [discordId]: hand.username });
  }
  await noterJeuSpecial(discordId, "blackjack");
}

export async function listHands(jour) {
  return hgetallJson(handKey(jour));
}

// ── Points cumulés (manche en cours) ──────────────────────────────────
// +2/+1/+0 selon pointsForResult() ci-dessus — remis à zéro à chaque
// nouveau Jour 1 (voir postBlackjack), pas seulement par un reset admin.

export async function addPoints(discordId, amount) {
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

export async function resetPoints() {
  await getRedis().del(POINTS_KEY);
}

export async function readUsername(discordId) {
  return getRedis().hget(USERNAMES_KEY, discordId);
}

export async function readUsernames() {
  return hgetallRaw(USERNAMES_KEY);
}

// Classement trié par points décroissants — les usernames stockés ne sont
// qu'un repli d'affichage (voir resolveDisplayName côté handler), jamais la
// source de vérité du pseudo actuel.
//
// À points égaux, départage par nombre de cartes piochées sur la manche
// (16/09, retour utilisateur) : moins de cartes piochées = mieux classé
// (main jugée "meilleure" — plus proche de 21 dès le départ). `cardsDrawn`
// est optionnel (défaut : aucun départage, ordre stable) — voir
// sumCardsPerPlayer() ci-dessous pour le calculer.
export function buildRanking(points, usernames = {}, cardsDrawn = {}) {
  return Object.entries(points)
    .map(([discordId, score]) => ({
      discordId,
      username: usernames[discordId] || null,
      points: score,
      cards: cardsDrawn[discordId] ?? 0,
    }))
    .sort((a, b) => b.points - a.points || a.cards - b.cards);
}

// ── Historique (bilans quotidiens) ────────────────────────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

// Trié du jour le plus récent au plus ancien.
export async function listHistorique({ limit = 10 } = {}) {
  const all = await hgetallJson(HISTORIQUE_KEY);
  return Object.values(all)
    .sort((a, b) => b.jour - a.jour)
    .slice(0, limit);
}

// Total de cartes piochées par joueur sur tous les jours déjà résolus de la
// manche en cours — utilisé uniquement pour départager les ex-æquo au
// classement (voir buildRanking). Ne compte que les jours CLÔTURÉS
// (historique) : le jour actif, pas encore résolu, n'est pas inclus, comme
// les points eux-mêmes.
export async function sumCardsPerPlayer() {
  const all = await hgetallJson(HISTORIQUE_KEY);
  const totals = {};
  for (const entry of Object.values(all)) {
    addResultsCardsToTotals(totals, entry.results ?? []);
  }
  return totals;
}

// Ajoute les cartes d'un jour aux totaux déjà lus — muté sur place,
// réutilisé pour projeter --dry-run le jour en cours de résolution avant
// qu'il ne soit écrit dans l'historique (voir postBlackjack).
export function addResultsCardsToTotals(totals, results) {
  for (const r of results) {
    totals[r.discordId] = (totals[r.discordId] || 0) + (r.cards?.length || 0);
  }
  return totals;
}

// ── Manches (bilans de fin de partie) ────────────────────────────
// Le jeu est destiné à être rejoué plusieurs fois : HASH permanent indexé
// par un numéro de manche strictement croissant (INCR atomique), jamais
// nettoyé par resetBlackjack() — seul un reset explicite (--manches) l'efface.

export async function archiveManche(record) {
  const manche = Number(await getRedis().incr(MANCHE_SEQ_KEY));
  await getRedis().hset(MANCHES_KEY, { [manche]: toJson({ manche, ...record }) });
  return manche;
}

// Trié de la manche la plus récente à la plus ancienne.
export async function listManches({ limit = 10 } = {}) {
  const all = await hgetallJson(MANCHES_KEY);
  return Object.values(all)
    .sort((a, b) => b.manche - a.manche)
    .slice(0, limit);
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetBlackjack({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, POINTS_KEY, USERNAMES_KEY, HISTORIQUE_KEY);
  await scanDelete("blackjack:hand:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
