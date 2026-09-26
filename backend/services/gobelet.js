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
const CONFIG_JSON_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "gobelet",
  "gobelet.json",
);

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
    const [next, batch] = await getRedis().scan(cursor, {
      match: pattern,
      count: 200,
    });
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
const USED_KEY = "gobelet:used";

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

// Petite Suite (16/09, retour utilisateur) : 4 valeurs CONSÉCUTIVES parmi
// les 5 dés (les autres dés sont libres, doublons compris) — pas
// nécessairement les 5 dés eux-mêmes. Seules 3 suites de 4 sont possibles
// avec des dés à 6 faces.
const SMALL_STRAIGHTS = [
  [1, 2, 3, 4],
  [2, 3, 4, 5],
  [3, 4, 5, 6],
];

function containsRun(uniqueSet, run) {
  return run.every((v) => uniqueSet.has(v));
}

// Barème complet, par ordre croissant de valeur — source unique pour le
// calcul (computeBestCombination) ET l'affichage des règles
// (formatBaremeLines), pour que les deux ne divergent jamais.
// `description` est affichée entre parenthèses dans les règles.
export const COMBINATIONS = [
  { label: "Double quelconque", description: "2 dés identiques", points: 10 },
  { label: "Brelan", description: "3 dés identiques", points: 20 },
  { label: "Carré", description: "4 dés identiques", points: 30 },
  { label: "Petite Suite", description: "4 dés qui se suivent", points: 30 },
  { label: "Pairs", description: "5 dés pairs", points: 35 },
  { label: "Impairs", description: "5 dés impairs", points: 35 },
  { label: "Full", description: "3 + 2", points: 40 },
  { label: "Somme ≤ 7", description: null, points: 45 },
  { label: "Somme ≥ 28", description: null, points: 45 },
  { label: "Grande Suite", description: "5 dés qui se suivent", points: 50 },
  { label: "Gobelet", description: "5 dés identiques", points: 60 },
];

export const NO_COMBINATION = "Aucune combinaison";

const POINTS_BY_LABEL = Object.fromEntries(
  COMBINATIONS.map((c) => [c.label, c.points]),
);

// Ordre de priorité utilisé UNIQUEMENT pour départager l'étiquette retenue
// en cas d'égalité de points entre deux catégories applicables au même
// résultat (le score retenu, lui, est toujours le maximum — voir
// computeBestCombination) — n'affecte jamais les points gagnés.
const CATEGORY_PRIORITY = [
  "Gobelet",
  "Grande Suite",
  "Somme ≥ 28",
  "Somme ≤ 7",
  "Full",
  "Pairs",
  "Impairs",
  "Carré",
  "Petite Suite",
  "Brelan",
  "Double quelconque",
];

// Lignes du barème pour l'embed Règles (jeu spécial et duel).
export function formatBaremeLines() {
  return [
    `🎲 ${NO_COMBINATION} (ou combinaison déjà réalisée) : 0 pt`,
    ...COMBINATIONS.map(
      (c) =>
        `🎯 ${c.label}${c.description ? ` (${c.description})` : ""} : ${c.points} pts`,
    ),
  ];
}

// Toutes les catégories présentes dans les dés, sans tenir compte de celles
// déjà réalisées. Les motifs "au moins N dés identiques" (Double, Brelan,
// Carré) acceptent plus de N dés : un Carré contient aussi un Brelan et un
// Double — indispensable depuis la règle d'unicité (26/09), pour qu'un
// joueur ayant déjà réalisé Carré puisse encore marquer son Brelan avec
// les mêmes dés. Le Full reste strict (exactement 3 + 2).
export function listMatchingCombinations(dice) {
  const sum = dice.reduce((total, d) => total + d, 0);
  const counts = diceCounts(dice);
  const maxCount = counts[0];
  const uniqueSorted = sortedUniqueValues(dice);
  const uniqueSet = new Set(dice);

  const labels = [];
  if (maxCount >= 2) labels.push("Double quelconque");
  if (maxCount >= 3) labels.push("Brelan");
  if (maxCount >= 4) labels.push("Carré");
  // 4 valeurs consécutives présentes parmi les dés (les autres dés sont
  // libres, doublons compris).
  if (SMALL_STRAIGHTS.some((run) => containsRun(uniqueSet, run)))
    labels.push("Petite Suite");
  if (sameCounts(counts, [3, 2])) labels.push("Full");
  if (dice.every((d) => d % 2 === 0)) labels.push("Pairs");
  if (dice.every((d) => d % 2 === 1)) labels.push("Impairs");
  if (sum <= 7) labels.push("Somme ≤ 7");
  if (sum >= 28) labels.push("Somme ≥ 28");
  // 5 valeurs distinctes consécutives (seules 1-2-3-4-5 et 2-3-4-5-6 sont
  // possibles avec des dés à 6 faces).
  if (uniqueSorted.length === 5 && uniqueSorted[4] - uniqueSorted[0] === 4)
    labels.push("Grande Suite");
  if (maxCount === 5) labels.push("Gobelet");
  return labels;
}

// Barème (voir CONTRIBUTING.md) : on retient la catégorie la plus valorisée
// parmi celles présentes dans les dés ET pas encore réalisées par le joueur
// lors des jours/manches précédents (`used`) — chaque combinaison ne
// rapporte qu'une seule fois par partie (règle du 26/09). Si toutes les
// catégories présentes sont déjà réalisées (ou si aucune n'est présente) :
// "Aucune combinaison", 0 pt. L'ancienne règle "Aucune combinaison = somme
// des dés" est abandonnée avec l'unicité : une main sans motif ne doit pas
// rapporter plus qu'une combinaison répétée.
export function computeBestCombination(dice, used = []) {
  const usedSet = new Set(used);
  const available = listMatchingCombinations(dice).filter(
    (label) => !usedSet.has(label),
  );
  if (available.length === 0) return { category: NO_COMBINATION, points: 0 };

  let best = available[0];
  for (const label of available) {
    const diff = POINTS_BY_LABEL[label] - POINTS_BY_LABEL[best];
    if (
      diff > 0 ||
      (diff === 0 &&
        CATEGORY_PRIORITY.indexOf(label) < CATEGORY_PRIORITY.indexOf(best))
    ) {
      best = label;
    }
  }
  return { category: best, points: POINTS_BY_LABEL[best] };
}

// Ajoute la catégorie retenue à la liste des combinaisons réalisées
// (pure). "Aucune combinaison" n'est jamais "consommée".
export function withUsedCategory(used, category) {
  if (!category || category === NO_COMBINATION || used.includes(category))
    return used;
  return [...used, category];
}

// Résout toutes les mains d'un jour. Une main encore "en_cours" à la
// clôture (joueur qui n'a pas fini ses 2 relances) est figée sur les dés
// courants plutôt qu'ignorée — un joueur qui a commencé sa main mérite
// d'être jugé sur ce qu'il a, pas exclu du classement. Fonction pure (aucun
// I/O) : appelée aussi bien pour la vraie clôture que pour un aperçu
// --dry-run.
//
// `usedByPlayer` ({ discordId: [catégories déjà réalisées] }) ne sert qu'aux
// mains figées ici : une main "termine" porte déjà sa catégorie, calculée
// au moment où le joueur l'a finie.
export function resolveJour(hands, usedByPlayer = {}) {
  return Object.entries(hands).map(([discordId, hand]) => {
    if (hand.status === "en_cours") {
      const { category, points } = computeBestCombination(
        hand.dice,
        usedByPlayer[discordId] || [],
      );
      return {
        discordId,
        username: hand.username,
        dice: hand.dice,
        category,
        points,
      };
    }
    return {
      discordId,
      username: hand.username,
      dice: hand.dice,
      category: hand.category,
      points: hand.points,
    };
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
  await getRedis().hset(keptKey(jour, discordId), {
    [String(index)]: value ? "1" : "0",
  });
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
    .map(([discordId, score]) => ({
      discordId,
      username: usernames[discordId] || null,
      points: score,
    }))
    .sort((a, b) => b.points - a.points);
}

// ── Combinaisons déjà réalisées (partie en cours) ───────────────────
// Hash `gobelet:used` : discordId -> tableau JSON des catégories marquées
// lors des jours déjà clôturés. Mis à jour uniquement à la clôture
// quotidienne (jamais en concurrence), remis à zéro avec les points.

export async function readUsedCategories(discordId) {
  return fromJson(await getRedis().hget(USED_KEY, discordId)) || [];
}

export async function readAllUsedCategories() {
  const all = await hgetallJson(USED_KEY);
  const result = {};
  for (const [discordId, used] of Object.entries(all))
    result[discordId] = used || [];
  return result;
}

export async function writeUsedCategories(discordId, used) {
  await getRedis().hset(USED_KEY, { [discordId]: toJson(used) });
}

export async function resetUsedCategories() {
  await getRedis().del(USED_KEY);
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
  await getRedis().hset(MANCHES_KEY, {
    [manche]: toJson({ manche, ...record }),
  });
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
  await getRedis().del(
    STATE_KEY,
    POINTS_KEY,
    USERNAMES_KEY,
    HISTORIQUE_KEY,
    USED_KEY,
  );
  await scanDelete("gobelet:hand:*");
  await scanDelete("gobelet:kept:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
