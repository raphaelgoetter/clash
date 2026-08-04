// ============================================================
// bossraid.js — Boss Raid, score attack communautaire contre un Boss
// Colossal. Couche métier : lecture de la config statique, état de la
// partie (phase/jour/posture du Boss/score cumulé), votes, clôture
// quotidienne, historique.
//
// Stockage : Upstash Redis (mêmes conventions que robinson.js/aventure.js)
// — espace de clés `bossraid:*`.
//
// ⚠️ Différence structurelle avec Robinson : ici le vote est MODIFIABLE
// jusqu'au cron (comme Aventure — HSET écrasable, pas HSETNX) et AUCUN
// tirage aléatoire n'a lieu au clic. Toute la logique de dégâts/événements/
// All-In est calculée UNE SEULE FOIS à la clôture, dans computeCloture() —
// une fonction pure. Conséquence directe : la posture du Boss
// (Défense/Résistance) et le score cumulé vivent dans le même blob JSON
// `bossraid:state` qu'Aventure/Tamagotchi (mutés uniquement au cron), PAS
// dans des clés atomiques séparées comme les stocks de Robinson — il n'y a
// jamais d'écriture concurrente à sécuriser puisque rien n'est écrit avant
// la clôture.
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
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "bossraid", "boss_raid.json");

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

const STATE_KEY = "bossraid:state";
const DERNIER_ROLE_KEY = "bossraid:dernier_role";
const HISTORIQUE_KEY = "bossraid:historique";

function votesKey(jour) {
  return `bossraid:votes:${jour}`;
}
function voteAtKey(jour) {
  return `bossraid:vote_at:${jour}`;
}
function voteUsernamesKey(jour) {
  return `bossraid:vote_usernames:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadBossRaidConfig() {
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

// ── Votes ──────────────────────────────────────────────────────────
// HSET écrasable (comme aventure.js, PAS HSETNX comme robinson.js) : le vote
// est modifiable jusqu'au cron, aucune notion de "slot réservé" à libérer.
// vote_at (horodatage de la DERNIÈRE mise à jour) sert uniquement à
// départager l'ordre de protection Chevalier quand les distants sont plus
// nombreux que les slots disponibles (voir computeProtection).

export async function recordVote(jour, discordId, roleId, username) {
  const redis = getRedis();
  await redis.hset(votesKey(jour), { [discordId]: roleId });
  await redis.hset(voteAtKey(jour), { [discordId]: new Date().toISOString() });
  if (username) {
    await redis.hset(voteUsernamesKey(jour), { [discordId]: username });
  }
}

export async function tallyVotes(jour) {
  const raw = await hgetallRaw(votesKey(jour));
  const counts = {};
  for (const roleId of Object.values(raw)) {
    counts[roleId] = (counts[roleId] || 0) + 1;
  }
  return counts;
}

export async function countUniqueVoters(jour) {
  return Number(await getRedis().hlen(votesKey(jour))) || 0;
}

// Détail des votants (discordId, roleId, pseudo) — utilisé uniquement par
// scripts/bossRaidStatus.js pour l'affichage admin en terminal.
export async function listVotes(jour) {
  const [votes, usernames] = await Promise.all([
    hgetallRaw(votesKey(jour)),
    hgetallRaw(voteUsernamesKey(jour)),
  ]);
  return Object.entries(votes).map(([discordId, roleId]) => ({
    discordId,
    roleId,
    username: usernames[discordId] || null,
  }));
}

async function clearVotes(jour) {
  await getRedis().del(votesKey(jour), voteAtKey(jour), voteUsernamesKey(jour));
}

// Dernier rôle FINALISÉ de chaque membre (muté uniquement au cron) — sert à
// la contrainte "pas Chevalier 2 jours de suite". Comparé au choix courant
// au moment du clic, jamais au sein de la même journée (un membre peut
// changer d'avis plusieurs fois le même jour sans pénalité).
export async function readDernierRole(discordId) {
  return await getRedis().hget(DERNIER_ROLE_KEY, discordId);
}

// ── Fonctions pures de logique de jeu (aucun I/O, testées unitairement) ──

// Répartit les slots de protection Chevalier (2 par Chevalier) entre les
// votants à distance (Sorcier/Archères). Si leur nombre dépasse la
// capacité, les slots vont aux votants dont le vote a été fixé/mis à jour
// le plus tôt ce jour-là (tri par vote_at croissant) — approximation la
// plus fidèle d'un "ordre d'arrivée" alors que les votes sont modifiables
// jusqu'au cron.
export function computeProtection(nbChevaliers, distantVoters, protectionSlotsParChevalier) {
  const capacite = nbChevaliers * protectionSlotsParChevalier;
  if (distantVoters.length <= capacite) {
    return {
      capacite,
      protectedIds: new Set(distantVoters.map((v) => v.discordId)),
      tousProteges: true,
    };
  }
  const tries = [...distantVoters].sort((a, b) => (a.votedAt < b.votedAt ? -1 : a.votedAt > b.votedAt ? 1 : 0));
  return {
    capacite,
    protectedIds: new Set(tries.slice(0, capacite).map((v) => v.discordId)),
    tousProteges: false,
  };
}

// All-In : le premier rôle d'attaque à dépasser STRICTEMENT 50% de
// l'ensemble des votes du jour (les 5 rôles votables inclus, Chevalier et
// Espion comptent dans le dénominateur) déclenche son Ultime. Un seul rôle
// peut mathématiquement dépasser 50%, pas d'ambiguïté d'ordre de test.
export function detectAllIn(voteCounts, totalVotes) {
  if (!totalVotes) return null;
  for (const roleId of ["archeres", "sorcier", "voleuse"]) {
    if ((voteCounts[roleId] || 0) > totalVotes / 2) return roleId;
  }
  return null;
}

// Lookup exact (pas de condition comme Robinson) — un seul événement par
// jour, jours 3/6/9 dans la config fournie.
export function activeEventForDay(jour, evenementsBoss) {
  return evenementsBoss.find((e) => e.jour === jour) ?? null;
}

export function rollDamageInRange(min, max, rng = Math.random) {
  return Math.floor(min + rng() * (max - min + 1));
}

// 25% de chance de déclenchement (r < 0.25), puis 50/50 Défense/Résistance
// à l'intérieur de cette tranche (r < 0.125 → Défense, sinon Résistance).
export function rollVoleuseDebuff(rng = Math.random) {
  const r = rng();
  if (r >= 0.25) return null;
  return r < 0.125 ? "defense" : "resistance";
}

export function applyStatReduction(baseDamage, statValue) {
  const clamped = Math.min(10, Math.max(0, statValue));
  return baseDamage * (1 - clamped * 0.1);
}

// Protégé : jamais de malus, même pendant Frappe Léthale. Non protégé :
// -50% normalement, -100% (0 dégât) si Frappe Léthale est active ce jour-là.
export function protectionMultiplier(protege, frappeLethaleActive) {
  if (protege) return 1;
  return frappeLethaleActive ? 0 : 0.5;
}

// Jamais réduite par la Résistance/Défense du Boss, jamais affectée par la
// protection Chevalier (la Voleuse n'est pas une unité "à distance").
export function computeVoleuseDamage(base) {
  return base;
}

export function computeSorcierDamage({ base, resistance, protege, frappeLethaleActive, surchargeArcaneActive, miroirManaActive }) {
  let degats = applyStatReduction(base, resistance);
  degats *= protectionMultiplier(protege, frappeLethaleActive);
  if (surchargeArcaneActive) degats *= 2; // All-In Sorcier : x2
  if (miroirManaActive) degats *= 0.5; // Miroir de Mana : réduction supplémentaire de 50%
  return degats;
}

// `defense` doit déjà intégrer l'effet Bouclier d'Acier (Défense effective
// = 10 ce jour-là) — calculé par l'appelant, pas ici. Volée Céleste (All-In
// Archères) est testée EN PREMIER et l'emporte totalement sur Bouclier
// d'Acier : ignore Défense ET protection, 100% dégâts pour tous les votants
// Archères ce jour-là (protégés ou non).
export function computeArcheresDamage({ base, defense, protege, frappeLethaleActive, voleeCelesteActive }) {
  if (voleeCelesteActive) return base;
  let degats = applyStatReduction(base, defense);
  degats *= protectionMultiplier(protege, frappeLethaleActive);
  return degats;
}

// Nouvelle posture du Boss pour le lendemain. Coup à la Gorge (All-In
// Voleuse) écrase tout à {0,0} INCONDITIONNELLEMENT, même si des debuffs
// individuels ont été tirés le même jour (ils restent visibles dans le
// bilan mais n'influencent jamais le résultat final, jamais recalculés en
// silence).
export function computeBossStatsNextDay(bossStatsAvant, voleuseDebuffs, allIn) {
  if (allIn === "voleuse") return { defense: 0, resistance: 0 };
  let defense = bossStatsAvant.defense;
  let resistance = bossStatsAvant.resistance;
  for (const stat of voleuseDebuffs) {
    if (stat === "defense") defense = Math.max(0, defense - 1);
    else if (stat === "resistance") resistance = Math.max(0, resistance - 1);
  }
  return { defense, resistance };
}

// `dernierRole` = dernier rôle FINALISÉ du membre (jour précédent), ou
// null/undefined s'il n'a jamais voté ou n'a pas voté Chevalier hier.
export function isChevalierVoteAllowed(dernierRole) {
  return dernierRole !== "chevalier";
}

// ── Orchestrateur pur — cœur de la clôture (aucun I/O) ──────────────
// Reproduit fidèlement l'algorithme de clôture fourni par l'utilisateur :
// protection → All-In → dégâts par votant → debuffs Voleuse → nouvelle
// posture → cumul. `rng` injectable pour les tests.

export function computeCloture({ jour, votesRaw, voteAtRaw, bossStatsAvant, totalDegatsAvant, config, rng = Math.random }) {
  const entries = Object.entries(votesRaw);
  const totalVotes = entries.length;

  const chevaliers = entries.filter(([, roleId]) => roleId === "chevalier");
  const distants = entries
    .filter(([, roleId]) => roleId === "sorcier" || roleId === "archeres")
    .map(([discordId]) => ({ discordId, votedAt: voteAtRaw[discordId] || "" }));

  const protectionSlots = config.roles.chevalier.protection_slots;
  const protection = computeProtection(chevaliers.length, distants, protectionSlots);

  const voteCounts = {};
  for (const [, roleId] of entries) voteCounts[roleId] = (voteCounts[roleId] || 0) + 1;
  const allIn = detectAllIn(voteCounts, totalVotes);

  const event = activeEventForDay(jour, config.evenements_boss);
  const frappeLethaleActive = event?.id === "frappe_lethale";
  const bouclierAcierActive = event?.id === "bouclier_acier";
  const miroirManaActive = event?.id === "miroir_mana";
  const voleeCelesteActive = allIn === "archeres";
  const surchargeArcaneActive = allIn === "sorcier";

  const defenseEffective = bouclierAcierActive ? 10 : bossStatsAvant.defense;

  let totalDamageDuJour = 0;
  const perVoteDetails = [];
  const voleuseDebuffs = [];

  for (const [discordId, roleId] of entries) {
    if (roleId === "chevalier" || roleId === "espion") {
      perVoteDetails.push({ discordId, roleId, degats: 0 });
      continue;
    }
    if (roleId === "voleuse") {
      const { degats_min, degats_max } = config.roles.voleuse;
      const base = rollDamageInRange(degats_min, degats_max, rng);
      const degats = Math.round(computeVoleuseDamage(base));
      totalDamageDuJour += degats;
      perVoteDetails.push({ discordId, roleId, degats });
      const debuff = rollVoleuseDebuff(rng);
      if (debuff) voleuseDebuffs.push({ discordId, stat: debuff });
      continue;
    }
    if (roleId === "sorcier") {
      const { degats_min, degats_max } = config.roles.sorcier;
      const base = rollDamageInRange(degats_min, degats_max, rng);
      const protege = protection.protectedIds.has(discordId);
      const degats = Math.round(
        computeSorcierDamage({
          base,
          resistance: bossStatsAvant.resistance,
          protege,
          frappeLethaleActive,
          surchargeArcaneActive,
          miroirManaActive,
        }),
      );
      totalDamageDuJour += degats;
      perVoteDetails.push({ discordId, roleId, degats, protege });
      continue;
    }
    if (roleId === "archeres") {
      const { degats_min, degats_max } = config.roles.archeres;
      const base = rollDamageInRange(degats_min, degats_max, rng);
      const protege = protection.protectedIds.has(discordId);
      const degats = Math.round(
        computeArcheresDamage({ base, defense: defenseEffective, protege, frappeLethaleActive, voleeCelesteActive }),
      );
      totalDamageDuJour += degats;
      perVoteDetails.push({ discordId, roleId, degats, protege });
    }
  }

  const bossStatsApres = computeBossStatsNextDay(
    bossStatsAvant,
    voleuseDebuffs.map((d) => d.stat),
    allIn,
  );
  const totalDegatsApres = totalDegatsAvant + totalDamageDuJour;

  return {
    voteCounts,
    totalVotes,
    protection,
    allIn,
    event,
    perVoteDetails,
    totalDamageDuJour,
    totalDegatsApres,
    voleuseDebuffs,
    bossStatsApres,
  };
}

// ── Wrappers I/O — appelés uniquement par postBossRaid()/handleEspion() ──

async function loadCloture(jour, config) {
  const [votesRaw, voteAtRaw, state] = await Promise.all([
    hgetallRaw(votesKey(jour)),
    hgetallRaw(voteAtKey(jour)),
    readState(),
  ]);
  return computeCloture({
    jour,
    votesRaw,
    voteAtRaw,
    bossStatsAvant: state.bossStats,
    totalDegatsAvant: state.totalDegatsCumules,
    config,
    rng: Math.random,
  });
}

// Lecture seule (aucune écriture Redis) — utilisée par le bouton Espion
// (projection live sur le jour EN COURS de vote) ET par la branche --dry-run
// de postBossRaid.js. Les deux appellent littéralement la même fonction.
export async function previewCloture(jour, config) {
  return loadCloture(jour, config);
}

// Écrit l'historique, met à jour le dernier rôle finalisé des votants du
// jour, purge les clés de vote du jour. Appelée uniquement au cron réel.
export async function closeDayAndAdvance(jour, config) {
  const votesRaw = await hgetallRaw(votesKey(jour));
  const result = await loadCloture(jour, config);
  const state = await readState();

  await writeHistoriqueEntry(jour, {
    voteCounts: result.voteCounts,
    totalVotes: result.totalVotes,
    protection: {
      capacite: result.protection.capacite,
      protectedCount: result.protection.protectedIds.size,
      tousProteges: result.protection.tousProteges,
    },
    allIn: result.allIn,
    event: result.event,
    totalDamageDuJour: result.totalDamageDuJour,
    totalDegatsApres: result.totalDegatsApres,
    bossStatsAvant: state.bossStats,
    bossStatsApres: result.bossStatsApres,
    voleuseDebuffs: result.voleuseDebuffs,
    resolvedAt: new Date().toISOString(),
  });
  if (Object.keys(votesRaw).length) {
    await getRedis().hset(DERNIER_ROLE_KEY, votesRaw);
  }
  await clearVotes(jour);

  return result;
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

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetBossRaid() {
  await getRedis().del(STATE_KEY, DERNIER_ROLE_KEY, HISTORIQUE_KEY);
  await scanDelete("bossraid:votes:*");
  await scanDelete("bossraid:vote_at:*");
  await scanDelete("bossraid:vote_usernames:*");
}
