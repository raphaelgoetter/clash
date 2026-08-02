// ============================================================
// robinson.js — Robinson, survie insulaire communautaire
// Couche métier : lecture de la config statique, état du jour courant,
// stocks de ressources, votes, tirages, clôture quotidienne, historique.
//
// Stockage : Upstash Redis (même instance et mêmes conventions que
// backend/services/tamagotchi.js) — espace de clés `robinson:*`.
//
// ⚠️ Différence structurelle majeure avec Aventure/Tamagotchi : chez eux,
// tout l'impact d'une journée est calculé une seule fois, séquentiellement,
// au cron. Ici, les récoltes (et le coût du Radeau) sont appliquées EN
// CONTINU pendant la journée, à chaque clic, par des membres potentiellement
// concurrents. Un blob JSON muté en lire-modifier-écrire perdrait des mises
// à jour (deux clics simultanés liraient le même stock de départ, le second
// SET écraserait le premier). Les stocks vivent donc dans des clés STRING
// numériques séparées, mutées uniquement via INCRBY/DECRBY (atomiques
// nativement côté Redis, aucune lecture intermédiaire possible) — jamais un
// GET puis un SET recalculé à la main.
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
const ROBINSON_DIR = path.resolve(__dirname, "..", "..", "data", "robinson");
const CONFIG_JSON_PATH = path.join(ROBINSON_DIR, "robinson.json");
const NARRATIFS_JSON_PATH = path.join(ROBINSON_DIR, "narratifs.json");

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

const STATE_KEY = "robinson:state";
const HISTORIQUE_KEY = "robinson:historique";
const RADEAU_POINTS_KEY = "robinson:radeau_points";
const STOCK_KEYS = {
  poisson: "robinson:stock:poisson",
  eau: "robinson:stock:eau",
  bois: "robinson:stock:bois",
};

function votesKey(jour) {
  return `robinson:votes:${jour}`;
}
function voteDetailsKey(jour) {
  return `robinson:vote_details:${jour}`;
}
function voteUsernamesKey(jour) {
  return `robinson:vote_usernames:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadRobinsonConfig() {
  if (configCache) return configCache;
  const txt = await fs.readFile(CONFIG_JSON_PATH, "utf-8");
  configCache = JSON.parse(txt);
  return configCache;
}

// Pools de textes narratifs (variantes par état de stock + phrases de
// clôture citant les votants) — séparés de tamagotchi.json car purement
// cosmétiques, n'affectent jamais la logique de jeu. Même principe que
// data/tamagotchi/narratifs.json.
let narratifsCache = null;

export async function loadNarratifs() {
  if (narratifsCache) return narratifsCache;
  const txt = await fs.readFile(NARRATIFS_JSON_PATH, "utf-8");
  narratifsCache = JSON.parse(txt);
  return narratifsCache;
}

// ── État séquentiel (muté uniquement au cron, jamais en concurrence) ──

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Économie (stocks + points de radeau) — clés atomiques ──────────

export async function initEconomy(stocksInitiaux) {
  await Promise.all([
    getRedis().set(STOCK_KEYS.poisson, String(stocksInitiaux.poisson)),
    getRedis().set(STOCK_KEYS.eau, String(stocksInitiaux.eau)),
    getRedis().set(STOCK_KEYS.bois, String(stocksInitiaux.bois)),
    getRedis().set(RADEAU_POINTS_KEY, "0"),
  ]);
}

export async function readStocks() {
  const [poisson, eau, bois] = await Promise.all([
    getRedis().get(STOCK_KEYS.poisson),
    getRedis().get(STOCK_KEYS.eau),
    getRedis().get(STOCK_KEYS.bois),
  ]);
  return {
    poisson: Number(poisson) || 0,
    eau: Number(eau) || 0,
    bois: Number(bois) || 0,
  };
}

export async function readRadeauPoints() {
  return Number(await getRedis().get(RADEAU_POINTS_KEY)) || 0;
}

// Récolte : jamais d'échec possible, un simple INCRBY atomique suffit.
export async function harvestResource(resourceId, amount) {
  if (amount <= 0) return;
  await getRedis().incrby(STOCK_KEYS[resourceId], amount);
}

// Coût du Radeau — le seul cas qui peut échouer (stock de Bois insuffisant).
// Pattern "décrémenter puis vérifier, compenser si négatif" : sûr sans
// script Lua, car personne d'autre ne lit robinson:stock:bois de façon
// atomiquement sensible entre les deux appels de ce même flux logique.
export async function attemptRaftContribution(boisCost) {
  const redis = getRedis();
  const nouveauStock = Number(await redis.decrby(STOCK_KEYS.bois, boisCost));
  if (nouveauStock < 0) {
    await redis.incrby(STOCK_KEYS.bois, boisCost); // compensation
    return { success: false };
  }
  const points = Number(await redis.incrby(RADEAU_POINTS_KEY, 1));
  return { success: true, boisRestant: nouveauStock, points };
}

// Consommation quotidienne — contrairement au Radeau, on veut vraiment
// plafonner à 0 (pas annuler l'opération) : DECRBY puis SET 0 si négatif.
async function decrementFlooredAtZero(key, amount) {
  if (amount <= 0) return Number(await getRedis().get(key)) || 0;
  const redis = getRedis();
  const nouveauStock = Number(await redis.decrby(key, amount));
  if (nouveauStock < 0) {
    await redis.set(key, "0");
    return 0;
  }
  return nouveauStock;
}

// ── Votes ──────────────────────────────────────────────────────────
// HSETNX (pas HGET puis HSET comme Tamagotchi) : il faut pouvoir libérer une
// réservation ratée (Radeau refusé pour stock insuffisant) sans risque de
// course avec un double-clic concurrent du même joueur.

export async function recordVote(jour, discordId, actionId, username) {
  const redis = getRedis();
  const wasSet = Number(await redis.hsetnx(votesKey(jour), discordId, actionId));
  if (wasSet) {
    if (username) await redis.hset(voteUsernamesKey(jour), { [discordId]: username });
    return { status: "recorded" };
  }
  const existing = await redis.hget(votesKey(jour), discordId);
  return existing === actionId ? { status: "already_recorded" } : { status: "rejected", existing };
}

// Uniquement appelé quand le Radeau échoue (stock insuffisant) — le joueur
// n'a alors pas réellement voté, il doit pouvoir réessayer plus tard.
export async function releaseVoteSlot(jour, discordId) {
  await getRedis().hdel(votesKey(jour), discordId);
}

export async function writeVoteDetail(jour, discordId, detail) {
  await getRedis().hset(voteDetailsKey(jour), { [discordId]: toJson(detail) });
}

export async function getVoteDetail(jour, discordId) {
  return fromJson(await getRedis().hget(voteDetailsKey(jour), discordId));
}

export async function tallyVotes(jour) {
  const raw = await hgetallRaw(votesKey(jour));
  const counts = {};
  for (const actionId of Object.values(raw)) {
    counts[actionId] = (counts[actionId] || 0) + 1;
  }
  return counts;
}

export async function countUniqueVoters(jour) {
  return Number(await getRedis().hlen(votesKey(jour))) || 0;
}

// Détail des votants (discordId, actionId, pseudo) — utilisé uniquement par
// scripts/robinsonStatus.js pour l'affichage admin en terminal.
export async function listVotes(jour) {
  const [votes, usernames] = await Promise.all([
    hgetallRaw(votesKey(jour)),
    hgetallRaw(voteUsernamesKey(jour)),
  ]);
  return Object.entries(votes).map(([discordId, actionId]) => ({
    discordId,
    actionId,
    username: usernames[discordId] || null,
  }));
}

async function clearVotes(jour) {
  await getRedis().del(votesKey(jour), voteDetailsKey(jour), voteUsernamesKey(jour));
}

// ── Fonctions pures de logique de jeu (aucun I/O, testées unitairement) ──

// Tirage normal 0/1/2/3, 25% chacun.
export function rollHarvestAmount(rng = Math.random) {
  return Math.floor(rng() * 4);
}

// Tirage dédié des jours Canicule/Ouragan pour la ressource plafonnée —
// 0 ou 1, 50/50 (décision explicite : pas un simple min(tirage normal, 1)).
export function rollCappedEventAmount(rng = Math.random) {
  return Math.floor(rng() * 2);
}

// Explorer : toujours 3 unités d'une seule et même ressource, tirée au
// hasard (pas une répartition entre les 3) — jamais affecté par
// Canicule/Ouragan (seules Eau / Pêche+Bois le sont).
export function rollExplorerYield(rng = Math.random) {
  const resources = ["poisson", "eau", "bois"];
  const picked = resources[Math.floor(rng() * 3)];
  const yields = { poisson: 0, eau: 0, bois: 0 };
  yields[picked] = 3;
  return yields;
}

// L'action est-elle plafonnée par l'événement du jour ?
export function harvestCapForEvent(event, actionId) {
  if (!event) return false;
  if (event.id === "canicule") return actionId === "eau";
  if (event.id === "ouragan") return actionId === "peche" || actionId === "bois";
  return false;
}

export function isExplorerDisabled(event) {
  return event?.id === "gobelins";
}

export function computeDailyConsumption(V) {
  return { poisson: V, eau: V, bois: Math.ceil(V / 2) };
}

// Soustrait la consommation, plancher 0 — pure, utilisée par le dry-run pour
// simuler la clôture sans jamais toucher Redis.
export function applyFlooredDelta(stocks, consumption) {
  const out = {};
  for (const key of Object.keys(stocks)) {
    out[key] = Math.max(0, stocks[key] - (consumption[key] || 0));
  }
  return out;
}

const ZERO_STREAK_LIMIT = 2;

// Cœur de la détection de défaite : incrémente le compteur d'une ressource
// tombée à 0, le remet à 0 sinon. Défaite dès qu'un compteur atteint 2.
export function updateZeroStreaks(prevStreaks, stocksAfter) {
  const streaks = {};
  let defeated = false;
  for (const key of Object.keys(stocksAfter)) {
    if (stocksAfter[key] <= 0) {
      streaks[key] = (prevStreaks?.[key] || 0) + 1;
      if (streaks[key] >= ZERO_STREAK_LIMIT) defeated = true;
    } else {
      streaks[key] = 0;
    }
  }
  return { streaks, defeated };
}

export function computeGobelinsTheft(boisApresConsommation, threshold = 5) {
  return boisApresConsommation < threshold;
}

export function computeRaftSections(points, pointsParSection) {
  return Math.floor(points / pointsParSection);
}

export function isRaftVictory(points, config) {
  return computeRaftSections(points, config.points_par_section) >= config.radeau_sections_max;
}

export function isSurvivalVictory(jour, dureeJours) {
  return jour > dureeJours;
}

export function eventForDay(jour, evenements) {
  return evenements.find((e) => e.jour === jour) ?? null;
}

// ── Historique (bilans quotidiens) ────────────────────────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

// Trié du jour le plus récent au plus ancien.
export async function listHistorique({ limit = 10, offset = 0 } = {}) {
  const all = await hgetallJson(HISTORIQUE_KEY);
  const entries = Object.entries(all)
    .map(([jour, record]) => ({ jour: Number(jour), ...record }))
    .sort((a, b) => b.jour - a.jour);
  const hasMore = entries.length > offset + limit;
  return { entries: entries.slice(offset, offset + limit), hasMore };
}

// ── Résolution/clôture du jour courant ──────────────────────────────
// Appelée uniquement par postRobinson() (api/discord/handlers/robinson.js)
// au moment du cron quotidien.

async function computeClosure(state, config, { write }) {
  const radeauPoints = await readRadeauPoints();

  // La victoire par Radeau court-circuite tout : aucune consommation ni
  // vérification de défaite ce jour-là (décision explicite validée).
  if (isRaftVictory(radeauPoints, config)) {
    const stocks = await readStocks();
    const record = {
      V: await countUniqueVoters(state.jour),
      stocksAvant: stocks,
      stocksApres: stocks,
      consumption: null,
      gobelinsVoleur: false,
      event: state.event ?? null,
      outcome: "victoire_radeau",
      resolvedAt: new Date().toISOString(),
    };
    if (write) {
      await writeHistoriqueEntry(state.jour, record);
      await clearVotes(state.jour);
    }
    return { outcome: "victoire_radeau", stocksApres: stocks, radeauPoints, zeroStreaksApres: state.zeroStreaks };
  }

  const [V, voters] = await Promise.all([countUniqueVoters(state.jour), listVotes(state.jour)]);
  const stocksAvant = await readStocks();
  const consumption = computeDailyConsumption(V);

  let stocksApres;
  if (write) {
    stocksApres = {
      poisson: await decrementFlooredAtZero(STOCK_KEYS.poisson, consumption.poisson),
      eau: await decrementFlooredAtZero(STOCK_KEYS.eau, consumption.eau),
      bois: await decrementFlooredAtZero(STOCK_KEYS.bois, consumption.bois),
    };
  } else {
    stocksApres = applyFlooredDelta(stocksAvant, consumption);
  }

  let gobelinsVoleur = false;
  if (state.event?.id === "gobelins") {
    gobelinsVoleur = computeGobelinsTheft(stocksApres.bois);
    if (gobelinsVoleur) {
      stocksApres = {
        ...stocksApres,
        poisson: write
          ? await decrementFlooredAtZero(STOCK_KEYS.poisson, 5)
          : Math.max(0, stocksApres.poisson - 5),
      };
    }
  }

  const { streaks, defeated } = updateZeroStreaks(state.zeroStreaks, stocksApres);
  const outcome = defeated ? "defaite" : null;

  if (write) {
    await writeHistoriqueEntry(state.jour, {
      V,
      stocksAvant,
      stocksApres,
      consumption,
      gobelinsVoleur,
      event: state.event ?? null,
      outcome,
      resolvedAt: new Date().toISOString(),
    });
    await clearVotes(state.jour);
  }

  return { outcome, stocksApres, radeauPoints, zeroStreaksApres: streaks, V, voters };
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run,
// qui ne doit jamais faire avancer la partie ni consommer les votes du jour.
export async function previewCloseDay(state, config) {
  return computeClosure(state, config, { write: false });
}

export async function closeDayAndAdvance(state, config) {
  return computeClosure(state, config, { write: true });
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetRobinson() {
  await getRedis().del(STATE_KEY, HISTORIQUE_KEY, RADEAU_POINTS_KEY, ...Object.values(STOCK_KEYS));
  await scanDelete("robinson:votes:*");
  await scanDelete("robinson:vote_details:*");
  await scanDelete("robinson:vote_usernames:*");
}
