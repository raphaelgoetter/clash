// ============================================================
// tamagotchi.js — Tamagotchi communautaire "Bébé Dragon Lilith"
// Couche métier : lecture de la config statique, état des jauges/du jour
// courant, votes, formule d'impact, notation du jour, historique.
//
// Stockage : Upstash Redis (même instance et mêmes conventions que
// backend/services/aventure.js) — espace de clés `tamagotchi:*`, totalement
// séparé de `frame:*`/`anagram:*`/`aventure:*`.
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
const TAMAGOTCHI_DIR = path.resolve(__dirname, "..", "..", "data", "tamagotchi");
const CONFIG_JSON_PATH = path.join(TAMAGOTCHI_DIR, "tamagotchi.json");
const NARRATIFS_JSON_PATH = path.join(TAMAGOTCHI_DIR, "narratifs.json");

// Construction paresseuse (pas au chargement du module) : avec les imports
// ES hoistés, "import ... from tamagotchi.js" s'exécute avant le
// dotenv.config() du script appelant — construire le client ici en top-level
// figerait des variables d'env pas encore chargées.
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

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau
// plat [champ1, valeur1, champ2, valeur2, ...] et non un objet.
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

const STATE_KEY = "tamagotchi:state";
const HISTORIQUE_KEY = "tamagotchi:historique";

function votesKey(jour) {
  return `tamagotchi:votes:${jour}`;
}

function voteUsernamesKey(jour) {
  return `tamagotchi:vote_usernames:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadTamagotchiConfig() {
  if (configCache) return configCache;
  const txt = await fs.readFile(CONFIG_JSON_PATH, "utf-8");
  configCache = JSON.parse(txt);
  return configCache;
}

// Pools de textes narratifs (variantes par état de jauge + phrases de
// clôture/lore inutile) — séparés de tamagotchi.json car purement
// cosmétiques, n'affectent jamais la logique de jeu.
let narratifsCache = null;

export async function loadNarratifs() {
  if (narratifsCache) return narratifsCache;
  const txt = await fs.readFile(NARRATIFS_JSON_PATH, "utf-8");
  narratifsCache = JSON.parse(txt);
  return narratifsCache;
}

// ── État courant ───────────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Votes ──────────────────────────────────────────────────────────
// Contrairement à Aventure (revoter écrase le choix précédent), le vote
// Tamagotchi n'est PAS modifiable une fois posé : revoter la MÊME action est
// un no-op idempotent ("already_recorded"), voter une action DIFFÉRENTE est
// rejeté sans écriture ("rejected"). Le pseudo est stocké à part, uniquement
// pour l'affichage (scripts/tamagotchiStatus.js et texte narratif), jamais
// utilisé pour la logique de vote elle-même.

export async function recordVote(jour, discordId, actionId, username) {
  const existing = await getRedis().hget(votesKey(jour), discordId);
  if (existing == null) {
    await getRedis().hset(votesKey(jour), { [discordId]: actionId });
    if (username) {
      await getRedis().hset(voteUsernamesKey(jour), { [discordId]: username });
    }
    return { status: "recorded" };
  }
  if (existing === actionId) {
    return { status: "already_recorded" };
  }
  return { status: "rejected", existing };
}

export async function tallyVotes(jour) {
  const raw = await hgetallRaw(votesKey(jour));
  const counts = {};
  for (const actionId of Object.values(raw)) {
    counts[actionId] = (counts[actionId] || 0) + 1;
  }
  return counts;
}

// Détail des votants (discordId, actionId, pseudo) — utilisé uniquement par
// scripts/tamagotchiStatus.js pour l'affichage admin en terminal.
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
  await getRedis().del(votesKey(jour), voteUsernamesKey(jour));
}

// ── Fonctions pures de logique de jeu (aucun I/O, testées unitairement) ──

export function clampGauge(value) {
  return Math.max(0, Math.min(100, value));
}

// Moyenne pondérée par part de votes : chaque action votée contribue à
// l'impact du jour proportionnellement à sa part des votes exprimés. Sans
// vote, l'impact est nul (l'événement du jour, s'il y en a un, s'applique
// quand même séparément). Ainsi l'amplitude de l'impact d'une journée reste
// toujours bornée par l'amplitude d'une seule action, quel que soit le
// nombre de votants.
export function computeDayImpact(voteCounts, actionsConfig) {
  const actionIds = Object.keys(actionsConfig).filter(
    (id) => !actionsConfig[id].is_info_action,
  );
  const total = actionIds.reduce((sum, id) => sum + (voteCounts[id] || 0), 0);
  const impact = { estomac: 0, energie: 0, moral: 0 };
  if (total === 0) return impact;
  for (const id of actionIds) {
    const share = (voteCounts[id] || 0) / total;
    const actionImpact = actionsConfig[id].impact || {};
    for (const gauge of Object.keys(impact)) {
      impact[gauge] += share * (actionImpact[gauge] || 0);
    }
  }
  return impact;
}

export function applyGaugeDelta(gauges, delta) {
  const out = {};
  for (const gauge of Object.keys(gauges)) {
    out[gauge] = clampGauge(Math.round(gauges[gauge] + (delta[gauge] || 0)));
  }
  return out;
}

export function rateDay(gaugesAfter, zonesIdeales) {
  const { min, max } = zonesIdeales;
  const outCount = Object.values(gaugesAfter).filter((v) => v < min || v > max).length;
  if (outCount === 0) return { rating: "parfaite", starDelta: 1 };
  if (outCount === 1) return { rating: "moyenne", starDelta: 0 };
  return { rating: "catastrophe", starDelta: -1 };
}

// Ordre fixe du cahier des charges : le 1er événement arrive Jour 3, le 2e
// Jour 6, le 3e Jour 9. Tout autre jour : pas d'événement.
const EVENT_DAY_INDEX = { 3: 0, 6: 1, 9: 2 };

export function eventForDay(jour, evenementsPossibles) {
  const idx = EVENT_DAY_INDEX[jour];
  return idx != null ? evenementsPossibles[idx] ?? null : null;
}

export function computeFinalTier(starTotal) {
  if (starTotal >= 8) return "S";
  if (starTotal >= 4) return "B";
  return "F";
}

// ── Historique (bilans quotidiens) ────────────────────────────────
// Bookkeeping interne uniquement (récap final, texte narratif) — pas de
// bouton Discord dédié pour ce jeu, contrairement à l'Historique d'Aventure.

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  const raw = await getRedis().hget(HISTORIQUE_KEY, String(jour));
  return fromJson(raw);
}

// ── Résolution/clôture du jour courant ──────────────────────────────
// Appelée uniquement par postTamagotchi() (api/discord/handlers/tamagotchi.js)
// au moment du cron quotidien. Toute la logique métier vit ici, jamais dans
// le handler ni dans interactions.js.

async function computeClosure(state, config) {
  const [voteCounts, voters] = await Promise.all([
    tallyVotes(state.jour),
    listVotes(state.jour),
  ]);
  const impact = computeDayImpact(voteCounts, config.actions);
  const gaugesClosing = applyGaugeDelta(state.gauges, impact);
  const rating = rateDay(gaugesClosing, config.zones_ideales);
  return { voteCounts, voters, impact, gaugesClosing, rating };
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run,
// qui ne doit jamais faire avancer la partie ni consommer les votes du jour
// actif.
export async function previewCloseDay(state, config) {
  return computeClosure(state, config);
}

export async function closeDayAndAdvance(state, config) {
  const { voteCounts, voters, impact, gaugesClosing, rating } = await computeClosure(state, config);
  const starTotalApres = state.starTotal + rating.starDelta;

  await writeHistoriqueEntry(state.jour, {
    gaugesAvant: state.gauges,
    gaugesApres: gaugesClosing,
    voteCounts,
    voters,
    totalVotes: Object.values(voteCounts).reduce((a, b) => a + b, 0),
    impact,
    event: state.lastEvent ?? null,
    rating: rating.rating,
    starDelta: rating.starDelta,
    starTotalApres,
    resolvedAt: new Date().toISOString(),
  });
  await clearVotes(state.jour);

  return { gaugesClosing, rating, starTotalApres, voteCounts, voters };
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetTamagotchi() {
  await getRedis().del(STATE_KEY, HISTORIQUE_KEY);
  await scanDelete("tamagotchi:votes:*");
  await scanDelete("tamagotchi:vote_usernames:*");
}
