// ============================================================
// robinson.js — Robinson, survie insulaire collaborative (7 jours)
// Couche métier : config, météo et prévision, résolution de la nuit
// (récoltes, repas, départ du Radeau à l'aube), votes, embarquement,
// jours joués (badge), manches. Règles : jeux/CONTRIBUTING.md, section
// « Robinson ».
//
// Stockage : Upstash Redis, espace `robinson:*`. Rien n'est appliqué au
// clic : stocks et planches vivent dans `robinson:state`, mutés uniquement
// par le cron (postRobinson), jamais en concurrence. Les clics n'écrivent
// que des HSETNX (vote du jour, embarquement), sûrs en concurrence.
//
// ⚠️ automaticDeserialization désactivée : le SDK convertirait les IDs
// Discord (17-19 chiffres) en Number JS et les corromprait.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { noterJeuSpecial } from "./passeport.js";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROBINSON_DIR = path.resolve(__dirname, "..", "data", "robinson");
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

const toJson = (value) => JSON.stringify(value);
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

const hgetallRaw = async (key) => pairsToObject((await getRedis().hgetall(key)) || []);

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

const STATE_KEY = "robinson:state";
const MANCHES_KEY = "robinson:manches";
const MANCHE_SEQ_KEY = "robinson:manche_seq";
const JOURS_JOUES_KEY = "robinson:jours_joues";
const A_BORD_KEY = "robinson:a_bord";
const USERNAMES_KEY = "robinson:usernames";
const votesKey = (jour) => `robinson:votes:${jour}`;
const voteUsernamesKey = (jour) => `robinson:vote_usernames:${jour}`;

export const RESSOURCES = ["poisson", "eau", "bois"];
// Action de récolte → ressource récoltée
export const RECOLTES = { peche: "poisson", eau: "eau", bois: "bois" };
export const ACTIONS = ["peche", "eau", "bois", "radeau"];

// ── Config (statique, jamais mutée) ─────────────────────────────────

let configCache = null;
export async function loadRobinsonConfig() {
  if (!configCache) configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf-8"));
  return configCache;
}

let narratifsCache = null;
export async function loadNarratifs() {
  if (!narratifsCache) narratifsCache = JSON.parse(await fs.readFile(NARRATIFS_JSON_PATH, "utf-8"));
  return narratifsCache;
}

// ── État (muté uniquement au cron) ──────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Météo (fonctions pures) ─────────────────────────────────────────

// Tirage pondéré par `poids` (indépendant d'un jour à l'autre).
export function tirerMeteo(config, rng = Math.random) {
  const entrees = Object.entries(config.meteos);
  const total = entrees.reduce((s, [, m]) => s + m.poids, 0);
  let x = rng() * total;
  for (const [id, m] of entrees) {
    x -= m.poids;
    if (x < 0) return id;
  }
  return entrees[entrees.length - 1][0];
}

// Prévision : la vraie météo avec la probabilité `fiabilite_prevision`,
// sinon une des autres au hasard (jamais la vraie dans ce cas).
export function prevoirMeteo(vraie, config, rng = Math.random) {
  if (rng() < config.fiabilite_prevision) return vraie;
  const autres = Object.keys(config.meteos).filter((id) => id !== vraie);
  return autres[Math.floor(rng() * autres.length)] ?? vraie;
}

// Ce que rapporte un joueur pour une action de récolte, selon la météo
export function rendement(config, meteoId, actionId) {
  const ressource = RECOLTES[actionId];
  return ressource ? (config.meteos[meteoId]?.rendements?.[ressource] ?? 0) : 0;
}

// ── Économie (fonctions pures) ──────────────────────────────────────

export function besoinNuit(V, config) {
  const r = config.repas;
  return { poisson: V * r.poisson, eau: V * r.eau, bois: Math.ceil(V / r.bois_par_joueurs) };
}

// Repas de la nuit du Jour `jour` : aucun la première nuit (vivres du navire)
export function repasDeLaNuit(jour, V, config) {
  if (V <= 0 || (jour === 1 && config.nuit1_gratuite)) return null;
  return besoinNuit(V, config);
}

export const planchesRequises = (V, config) => V * config.planches_par_joueur;

// Le Radeau peut emmener les joueurs du jour (au moins un joueur)
export const radeauPret = (planches, V, config) => V > 0 && planches >= planchesRequises(V, config);

// `counts` : votes par action, `V` : votants uniques du jour
export function recoltesDuJour(counts, meteoId, config) {
  const out = { poisson: 0, eau: 0, bois: 0 };
  for (const [actionId, ressource] of Object.entries(RECOLTES)) {
    out[ressource] = (counts[actionId] || 0) * rendement(config, meteoId, actionId);
  }
  return out;
}

// Stocks du soir (récoltes puis repas), sans plancher : une valeur
// négative = ce qui manquera. Sert à la projection et à la résolution.
export function stocksDuSoir(stocks, counts, V, jour, meteoId, config) {
  const recoltes = recoltesDuJour(counts, meteoId, config);
  const repas = repasDeLaNuit(jour, V, config);
  const soir = {};
  for (const r of RESSOURCES) soir[r] = stocks[r] + recoltes[r] - (repas?.[r] ?? 0);
  return { recoltes, repas, soir };
}

// Résolution de la nuit du Jour `jour` (pure) : récoltes, planches, repas,
// puis aube du lendemain (`meteoAube`). Issue : "victoire_radeau",
// "defaite" (cause "famine" ou "pas_de_depart") ou null (on continue).
export function resoudreNuit({ jour, stocks, planches, counts, V, nbABord, meteo, meteoAube, config }) {
  const { recoltes, repas, soir } = stocksDuSoir(stocks, counts, V, jour, meteo, config);
  const planchesSoir = planches + (counts.radeau || 0);
  const manque = RESSOURCES.filter((r) => soir[r] < 0);
  const stocksFinal = Object.fromEntries(RESSOURCES.map((r) => [r, Math.max(0, soir[r])]));
  const base = { recoltes, repas, stocks: stocksFinal, planches: planchesSoir, manque, meteoAube };
  if (manque.length) return { ...base, issue: "defaite", cause: "famine", depart: false };
  const depart =
    Boolean(config.meteos[meteoAube]?.depart) && radeauPret(planchesSoir, V, config) && nbABord > 0;
  if (depart) return { ...base, issue: "victoire_radeau", cause: null, depart: true };
  if (jour >= config.duree_jours) return { ...base, issue: "defaite", cause: "pas_de_depart", depart: false };
  return { ...base, issue: null, cause: null, depart: false };
}

// Garde-fou anti-double-avancée : un cron en retard après une relance
// manuelle clôturerait un jour tout juste ouvert.
export const MIN_HOURS_BETWEEN_CLOSURES = 8;
export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// Score d'une manche (classement des parties entre elles) : toute victoire
// bat toute défaite, un départ plus tôt bat un départ plus tard. `jour` :
// jour de l'aube du départ (2 à duree_jours + 1), ou dernier jour joué en
// cas de défaite. `victoire_jour11` (victoire par survie) n'existe plus
// mais reste dans l'archive des anciennes manches.
export function computeMancheScore(outcome, jour, dureeJours) {
  if (outcome === "victoire_radeau") return 1000 + Math.max(0, dureeJours + 2 - jour);
  if (outcome === "victoire_jour11") return 500;
  return jour;
}

// ── Votes ───────────────────────────────────────────────────────────

export const estPnj = (discordId) => String(discordId).startsWith("pnj-");

// Vote définitif (HSETNX). Au premier vote du jour : jour joué (badge),
// pseudo, passeport (sauf PNJ).
export async function recordVote(jour, discordId, actionId, username) {
  const redis = getRedis();
  const wasSet = Number(await redis.hsetnx(votesKey(jour), discordId, actionId));
  if (wasSet) {
    await redis.hincrby(JOURS_JOUES_KEY, discordId, 1);
    if (username) {
      await redis.hset(voteUsernamesKey(jour), { [discordId]: username });
      await redis.hset(USERNAMES_KEY, { [discordId]: username });
    }
    if (!estPnj(discordId)) await noterJeuSpecial(discordId, "robinson");
    return { status: "recorded" };
  }
  const existing = await redis.hget(votesKey(jour), discordId);
  return existing === actionId ? { status: "already_recorded" } : { status: "rejected", existing };
}

export async function readVote(jour, discordId) {
  return (await getRedis().hget(votesKey(jour), discordId)) ?? null;
}

export async function tallyVotes(jour) {
  const counts = {};
  for (const actionId of Object.values(await hgetallRaw(votesKey(jour)))) {
    counts[actionId] = (counts[actionId] || 0) + 1;
  }
  return counts;
}

export async function countUniqueVoters(jour) {
  return Number(await getRedis().hlen(votesKey(jour))) || 0;
}

// Détail des votants (/mini-jeux, robinson:status)
export async function listVotes(jour) {
  const [votes, usernames] = await Promise.all([hgetallRaw(votesKey(jour)), hgetallRaw(voteUsernamesKey(jour))]);
  return Object.entries(votes).map(([discordId, actionId]) => ({
    discordId,
    actionId,
    username: usernames[discordId] || null,
  }));
}

export async function clearVotes(jour) {
  await getRedis().del(votesKey(jour), voteUsernamesKey(jour));
}

// ── Embarquement (durable jusqu'à la fin de la partie) ──────────────

export async function embarquer(discordId, jour) {
  return Boolean(Number(await getRedis().hsetnx(A_BORD_KEY, discordId, String(jour))));
}

export async function readABord() {
  return hgetallRaw(A_BORD_KEY);
}

// ── Badge de participation ──────────────────────────────────────────

export async function readJoursJoues() {
  const raw = await hgetallRaw(JOURS_JOUES_KEY);
  return Object.fromEntries(Object.entries(raw).map(([id, n]) => [id, Number(n) || 0]));
}

export async function readUsernames() {
  return hgetallRaw(USERNAMES_KEY);
}

// Groupes du badge, du plus assidu au moins assidu : [{ jours, ids }].
// `aBord` (victoire) : sépare les partis des restés sur l'île.
export function groupesBadge(joursJoues, aBord = null) {
  const grouper = (ids) => {
    const parJours = new Map();
    for (const id of ids) {
      const n = joursJoues[id];
      if (!parJours.has(n)) parJours.set(n, []);
      parJours.get(n).push(id);
    }
    return [...parJours.entries()].sort((a, b) => b[0] - a[0]).map(([jours, liste]) => ({ jours, ids: liste }));
  };
  const joueurs = Object.keys(joursJoues).filter((id) => joursJoues[id] > 0);
  if (!aBord) return { tous: grouper(joueurs) };
  return {
    partis: grouper(joueurs.filter((id) => aBord[id] != null)),
    restes: grouper(joueurs.filter((id) => aBord[id] == null)),
  };
}

// ── PNJ (salon de test uniquement) ──────────────────────────────────

export const PNJ = ["Josette", "Gérard", "Ginette", "Jean-Mi", "Bernadette"];

// Les PNJ choisissent une action au hasard, puis embarquent une fois sur
// deux si le Radeau est prêt (planches du soir et joueurs du jour).
export async function jouerPnj(jour, planches, config, rng = Math.random) {
  for (const [i, nom] of PNJ.entries()) {
    await recordVote(jour, `pnj-${i + 1}`, ACTIONS[Math.floor(rng() * ACTIONS.length)], nom);
  }
  const counts = await tallyVotes(jour);
  const V = await countUniqueVoters(jour);
  if (!radeauPret(planches + (counts.radeau || 0), V, config)) return;
  for (let i = 0; i < PNJ.length; i++) if (rng() < 0.5) await embarquer(`pnj-${i + 1}`, jour);
}

// ── Manches ─────────────────────────────────────────────────────────
// Archive permanente (une partie = une manche), jamais effacée par un reset
// normal ; `--manches` l'efface (tests).

export async function archiveManche(record) {
  const manche = Number(await getRedis().incr(MANCHE_SEQ_KEY));
  await getRedis().hset(MANCHES_KEY, { [manche]: toJson({ manche, ...record }) });
  return manche;
}

export async function listManches({ limit = 10 } = {}) {
  return Object.values(await hgetallRaw(MANCHES_KEY))
    .map(fromJson)
    .filter(Boolean)
    .sort((a, b) => b.manche - a.manche)
    .slice(0, limit);
}

// ── Remise à zéro ───────────────────────────────────────────────────

// Début d'une partie (passage au Jour 1) : badge et embarquement.
export async function resetPartie() {
  await getRedis().del(JOURS_JOUES_KEY, A_BORD_KEY, USERNAMES_KEY);
  await scanDelete("robinson:votes:*");
  await scanDelete("robinson:vote_usernames:*");
}

// Efface aussi les clés de l'ancienne version du jeu (stocks séparés,
// constructions, épuisement…), sans effet si elles n'existent plus.
export async function resetRobinson({ clearManches = false } = {}) {
  await getRedis().del(
    STATE_KEY,
    JOURS_JOUES_KEY,
    A_BORD_KEY,
    USERNAMES_KEY,
    "robinson:historique",
    "robinson:radeau_points",
    "robinson:stock:poisson",
    "robinson:stock:eau",
    "robinson:stock:bois",
  );
  for (const motif of [
    "robinson:votes:*",
    "robinson:vote_usernames:*",
    "robinson:vote_details:*",
    "robinson:zones:*",
    "robinson:radeau_jour:*",
    "robinson:construction:*",
  ]) {
    await scanDelete(motif);
  }
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
