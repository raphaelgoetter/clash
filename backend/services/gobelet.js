// ============================================================
// gobelet.js — Jeu du Gobelet (7 jours, dés façon Yahtzee, classement
// cumulé au Jour 7). Pas d'adversaire : chaque jour, le joueur lance 5 dés,
// peut en conserver 0 à 5 et relancer les autres, deux fois de suite (3
// tirages au total), puis la meilleure combinaison possible sur le résultat
// final lui rapporte des points selon le barème (voir computeBestCombination
// ci-dessous). Couche métier : tirage des dés, résolution de combinaison,
// résolution quotidienne, points, historique.
//
// Stockage : Upstash Redis (même instance que les autres jeux), espace de
// clés `gobelet:*`.
//
// ⚠️ automaticDeserialization désactivée volontairement : le SDK convertit
// par défaut toute valeur "numérique" en Number JS, y compris les IDs
// Discord (17-19 chiffres) qui dépassent Number.MAX_SAFE_INTEGER — ça les
// corrompt silencieusement. On sérialise/désérialise le JSON nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "gobelet", "gobelet.json");

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

const STATE_KEY = "gobelet:state";
const POINTS_KEY = "gobelet:points";
const USERNAMES_KEY = "gobelet:usernames";
const HISTORIQUE_KEY = "gobelet:historique";
const MANCHES_KEY = "gobelet:manches";
const MANCHE_SEQ_KEY = "gobelet:manche_seq";

function handKey(jour) {
  return `gobelet:hand:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadGobeletConfig() {
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

// Garde-fou anti-double-avancée (même pattern que les autres jeux à cron du
// repo — Blackjack, Robinson, Quiz… — copié ici plutôt qu'importé : chaque
// jeu a sa propre copie, aucun partage inter-jeux de ce garde-fou dans le
// repo) : un cron `schedule` en retard peut encore se déclencher après
// qu'un admin a relancé le jour à la main entretemps — sans ce filet, les
// deux appels à postGobelet() clôtureraient chacun un jour d'affilée.
// MIN_HOURS_BETWEEN_CLOSURES reste très en dessous du cycle normal (~24h),
// donc sans impact sur le fonctionnement quotidien légitime.
export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  const hoursSince = (now - new Date(publishedAt).getTime()) / 3_600_000;
  return hoursSince < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── Dés — fonctions pures de logique de jeu (testées unitairement) ────

export function rollDie(rng = Math.random) {
  return 1 + Math.floor(rng() * 6);
}

export function rollDice(n = 5, rng = Math.random) {
  return Array.from({ length: n }, () => rollDie(rng));
}

// Relance uniquement les dés non conservés (kept[i] === false) — les dés
// conservés gardent exactement leur valeur courante.
export function rerollKept(dice, kept, rng = Math.random) {
  return dice.map((value, i) => (kept[i] ? value : rollDie(rng)));
}

function diceCounts(dice) {
  const byValue = {};
  for (const d of dice) byValue[d] = (byValue[d] || 0) + 1;
  return Object.values(byValue).sort((a, b) => b - a);
}

function sameCounts(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sortedUniqueValues(dice) {
  return [...new Set(dice)].sort((a, b) => a - b);
}

// Ordre de priorité utilisé UNIQUEMENT pour départager l'étiquette affichée
// en cas d'égalité de points entre deux catégories applicables au même
// résultat (le score retenu, lui, est toujours le maximum — voir
// computeBestCombination) — n'affecte jamais les points gagnés.
const CATEGORY_PRIORITY = [
  "Gobelet",
  "Grande Suite",
  "Petite Suite",
  "Full",
  "Carré",
  "Brelan",
  "Somme ≥ 28",
  "Somme ≤ 7",
  "Aucune combinaison",
];

// Barème (voir CONTRIBUTING.md) : on évalue TOUTES les catégories
// applicables au résultat final et on retient la plus valorisée — pas un
// ordre de priorité fixe. Ex. un Carré de 6 (6,6,6,6,5, somme=29) matche à
// la fois Carré (30 pts) et Somme ≥ 28 (40 pts) : on retient 40.
export function computeBestCombination(dice) {
  const sum = dice.reduce((total, d) => total + d, 0);
  const counts = diceCounts(dice);
  const uniqueSorted = sortedUniqueValues(dice);

  const candidates = [{ label: "Aucune combinaison", points: sum }];
  if (sameCounts(counts, [3, 1, 1])) candidates.push({ label: "Brelan", points: 20 });
  if (sameCounts(counts, [4, 1])) candidates.push({ label: "Carré", points: 30 });
  if (sameCounts(counts, [3, 2])) candidates.push({ label: "Full", points: 40 });
  if (sum <= 7) candidates.push({ label: "Somme ≤ 7", points: 40 });
  if (sum >= 28) candidates.push({ label: "Somme ≥ 28", points: 40 });
  if (uniqueSorted.length === 5 && uniqueSorted[0] === 1 && uniqueSorted[4] === 5) {
    candidates.push({ label: "Petite Suite", points: 45 });
  }
  if (uniqueSorted.length === 5 && uniqueSorted[0] === 2 && uniqueSorted[4] === 6) {
    candidates.push({ label: "Grande Suite", points: 50 });
  }
  if (sameCounts(counts, [5])) candidates.push({ label: "Gobelet", points: 60 });

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.points > best.points) {
      best = candidate;
    } else if (
      candidate.points === best.points &&
      CATEGORY_PRIORITY.indexOf(candidate.label) < CATEGORY_PRIORITY.indexOf(best.label)
    ) {
      best = candidate;
    }
  }
  return { category: best.label, points: best.points };
}

// Résout toutes les mains d'un jour. Une main encore "en_cours" à la
// clôture (joueur qui n'a pas fini ses 2 relances) est figée sur les dés
// courants plutôt qu'ignorée — un joueur qui a commencé sa main mérite
// d'être jugé sur ce qu'il a, pas exclu du classement. Fonction pure (aucun
// I/O) : appelée aussi bien pour la vraie clôture que pour un aperçu
// --dry-run.
export function resolveJour(hands) {
  return Object.entries(hands).map(([discordId, hand]) => {
    if (hand.status === "en_cours") {
      const { category, points } = computeBestCombination(hand.dice);
      return { discordId, username: hand.username, dice: hand.dice, category, points };
    }
    return { discordId, username: hand.username, dice: hand.dice, category: hand.category, points: hand.points };
  });
}

// ── Mains des joueurs (une par jour, hash `gobelet:hand:<jour>`) ──────

export async function readHand(jour, discordId) {
  return fromJson(await getRedis().hget(handKey(jour), discordId));
}

export async function writeHand(jour, discordId, hand) {
  await getRedis().hset(handKey(jour), { [discordId]: toJson(hand) });
  if (hand.username) {
    await getRedis().hset(USERNAMES_KEY, { [discordId]: hand.username });
  }
}

export async function listHands(jour) {
  return hgetallJson(handKey(jour));
}

// ── Dés conservés (un champ Redis par dé, PAS un tableau dans le blob JSON
// de la main) ──────────────────────────────────────────────────────
// Bug constaté le 16/09 : en stockant `kept` comme tableau dans le même
// blob JSON que le reste de la main, deux clics quasi simultanés sur des
// dés DIFFÉRENTS se marchaient dessus — chaque clic fait un
// lecture-puis-écriture de LA MAIN ENTIÈRE, donc le second clic écrasait le
// premier s'il repartait d'une lecture antérieure à l'écriture du premier
// (plusieurs dés cochés "à garder" perdus, relancés par erreur). En
// isolant chaque dé dans son propre champ de hash Redis, deux HSET sur des
// champs distincts n'entrent jamais en conflit, même simultanés — seul un
// double-clic sur EXACTEMENT le même dé reste théoriquement racy, sans
// conséquence grave (un des deux clics est simplement perdu, l'état reste
// cohérent).
function keptKey(jour, discordId) {
  return `gobelet:kept:${jour}:${discordId}`;
}

export async function readKept(jour, discordId) {
  const raw = await hgetallRaw(keptKey(jour, discordId));
  return [0, 1, 2, 3, 4].map((i) => raw[String(i)] === "1");
}

export async function setKeptField(jour, discordId, index, value) {
  await getRedis().hset(keptKey(jour, discordId), { [String(index)]: value ? "1" : "0" });
}

export async function resetKept(jour, discordId) {
  await getRedis().del(keptKey(jour, discordId));
}

// ── Points cumulés (manche en cours) ──────────────────────────────────
// Le score gagné chaque jour est directement le nombre de points de la
// catégorie retenue (voir computeBestCombination) — remis à zéro à chaque
// nouveau Jour 1 (voir postGobelet), pas seulement par un reset admin.

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

// Classement trié par points décroissants — les usernames stockés ne sont
// qu'un repli d'affichage (voir resolveDisplayName côté handler), jamais la
// source de vérité du pseudo actuel.
export function buildRanking(points, usernames = {}) {
  return Object.entries(points)
    .map(([discordId, score]) => ({ discordId, username: usernames[discordId] || null, points: score }))
    .sort((a, b) => b.points - a.points);
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

// ── Manches (bilans de fin de partie) ────────────────────────────
// Le jeu est destiné à être rejoué plusieurs fois : HASH permanent indexé
// par un numéro de manche strictement croissant (INCR atomique), jamais
// nettoyé par resetGobelet() — seul un reset explicite (--manches) l'efface.

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

export async function resetGobelet({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, POINTS_KEY, USERNAMES_KEY, HISTORIQUE_KEY);
  await scanDelete("gobelet:hand:*");
  await scanDelete("gobelet:kept:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
