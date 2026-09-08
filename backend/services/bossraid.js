// ============================================================
// bossraid.js — Boss Raid, score attack communautaire contre un Boss
// Colossal. Couche métier : lecture de la config statique, état de la
// partie (phase/jour/score cumulé), votes, clôture quotidienne, historique.
//
// Stockage : Upstash Redis (mêmes conventions que robinson.js)
// — espace de clés `bossraid:*`.
//
// ⚠️ Refonte stratégique (voir CONTRIBUTING.md) : AUCUN aléatoire nulle part
// dans le jeu — tous les dégâts sont fixes, le débuff Voleuse est
// déterministe (-1 Défense/vote), il n'y a plus d'Ultimes/All-In ni de
// régénération nocturne. Chaque jour repart de la même posture de base
// (`boss_stats_base`, éventuellement modifiée par l'événement du jour) —
// aucune valeur de Défense/Résistance ne persiste d'un jour à l'autre. Le
// jeu devient un pur problème d'optimisation combinatoire : à nombre de
// votants fixé, quelle répartition entre les 4 rôles d'action maximise les
// dégâts du jour (`computeBestCombo()`) ? Le score (SS/S/A/B/C/D) compare
// les dégâts réels du jour à ce plafond théorique.
//
// ⚠️ Comme Robinson : le vote est définitif (HSETNX), pas modifiable une
// fois posé. Toute la logique de dégâts/protection/événements est calculée
// UNE SEULE FOIS à la clôture, dans computeCloture() — une fonction pure.
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
const BOSSRAID_DIR = path.resolve(__dirname, "..", "..", "data", "bossraid");
const CONFIG_JSON_PATH = path.join(BOSSRAID_DIR, "boss_raid.json");
const NARRATIFS_JSON_PATH = path.join(BOSSRAID_DIR, "narratifs.json");

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
const MANCHES_KEY = "bossraid:manches";
const MANCHE_SEQ_KEY = "bossraid:manche_seq";

function votesKey(jour) {
  return `bossraid:votes:${jour}`;
}
function voteAtKey(jour) {
  return `bossraid:vote_at:${jour}`;
}
function voteUsernamesKey(jour) {
  return `bossraid:vote_usernames:${jour}`;
}

// Les 5 rôles "d'action" — participent au problème de combinaison optimale
// (l'Espion historique n'existe plus : la Princesse inflige désormais un
// dégât fixe elle aussi, en plus de son rôle d'info). Chevalier (0 dégât
// direct, mais compte dans la combinaison car son allocation a un coût
// d'opportunité) et Princesse (dégât fixe, jamais réduit ni protégé — voir
// computeComboDamage) sont deux façons différentes de "ne pas dépendre de
// la posture du Boss", mais Princesse compte bien dans le dénominateur et
// candidate à la meilleure combinaison, contrairement à l'ancien Espion.
export const ACTION_ROLES = ["chevalier", "voleuse", "sorcier", "archeres", "princesse"];

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadBossRaidConfig() {
  if (configCache) return configCache;
  const txt = await fs.readFile(CONFIG_JSON_PATH, "utf-8");
  configCache = JSON.parse(txt);
  return configCache;
}

// Pools de textes narratifs (variantes par posture du Boss + rôle dominant
// de la veille) — séparés de boss_raid.json car purement cosmétiques,
// n'affectent jamais la logique de jeu. Même principe que
// data/robinson/narratifs.json et data/tamagotchi/narratifs.json.
let narratifsCache = null;

export async function loadNarratifs() {
  if (narratifsCache) return narratifsCache;
  const txt = await fs.readFile(NARRATIFS_JSON_PATH, "utf-8");
  narratifsCache = JSON.parse(txt);
  return narratifsCache;
}

// ── État de la partie (muté uniquement au cron, jamais en concurrence) ──

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Votes ──────────────────────────────────────────────────────────
// HSETNX (comme robinson.js) : le vote n'est PAS modifiable une fois posé.
// Revoter le MÊME rôle est un no-op ("already_recorded"), voter un rôle
// différent est rejeté ("rejected") — aucune notion de "slot réservé" à
// libérer, un vote ne peut jamais échouer techniquement, il est juste
// définitif.
// vote_at (horodatage du vote, posé une seule fois) sert à départager
// l'ordre de protection Chevalier quand les distants sont plus nombreux que
// les slots disponibles (voir computeProtection) — un vrai ordre d'arrivée
// maintenant que le vote est verrouillé.

export async function recordVote(jour, discordId, roleId, username) {
  const redis = getRedis();
  const wasSet = Number(await redis.hsetnx(votesKey(jour), discordId, roleId));
  if (!wasSet) {
    const existing = await redis.hget(votesKey(jour), discordId);
    return existing === roleId
      ? { status: "already_recorded" }
      : { status: "rejected", existing };
  }
  await redis.hset(voteAtKey(jour), { [discordId]: new Date().toISOString() });
  if (username) {
    await redis.hset(voteUsernamesKey(jour), { [discordId]: username });
  }
  return { status: "recorded" };
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

// Répartit les slots de protection Chevalier entre les votants à distance
// (Sorcier/Archères) RÉELS d'une journée. Si leur nombre dépasse la
// capacité, les slots vont aux votants dont le vote a été posé le plus tôt
// ce jour-là (tri par vote_at croissant) — vote_at n'étant écrit qu'une
// seule fois (vote verrouillé, voir recordVote), c'est un vrai ordre
// d'arrivée. Utilisée uniquement pour la clôture RÉELLE — la recherche de
// meilleure combinaison hypothétique utilise sa propre allocation optimale
// (voir allocateOptimalProtection).
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

// Lookup exact (pas de condition comme Robinson) — un seul événement par
// jour. Jour 1 volontairement sans événement (aucune entrée dans la config).
export function activeEventForDay(jour, evenementsBoss) {
  return evenementsBoss.find((e) => e.jour === jour) ?? null;
}

// Résout les paramètres effectifs d'une journée : posture de base du Boss
// (`boss_stats_base`, TOUJOURS la même, aucune persistance d'un jour à
// l'autre) modulée par les effets de l'événement du jour éventuel. Aucun
// aléatoire, aucun état — une pure fonction de (jour, config).
export function resolveDayParams(jour, config) {
  const event = activeEventForDay(jour, config.evenements_boss);
  const effects = event?.effects || {};
  return {
    event,
    defense: effects.defense_override ?? config.boss_stats_base.defense,
    resistance: effects.resistance_override ?? config.boss_stats_base.resistance,
    protectionSlots: effects.protection_slots_override ?? config.roles.chevalier.protection_slots,
    malusMultiplier: effects.malus_multiplier_override ?? 0.5,
    sorcierMultiplier: effects.sorcier_multiplier ?? 1,
    archeresMultiplier: effects.archeres_multiplier ?? 1,
    voleuseDebuffDisabled: Boolean(effects.voleuse_debuff_disabled),
  };
}

export function applyStatReduction(baseDamage, statValue) {
  const clamped = Math.min(10, Math.max(0, statValue));
  return baseDamage * (1 - clamped * 0.1);
}

// Protégé : jamais de malus, quel que soit l'événement. Non protégé :
// malus du jour (0.5 par défaut, ex. 0 lors de Frappe Léthale, voir
// resolveDayParams).
export function protectionMultiplier(protege, malusMultiplier) {
  return protege ? 1 : malusMultiplier;
}

export function computeSorcierDamage({ base, resistance, protege, malusMultiplier, sorcierMultiplier }) {
  let degats = applyStatReduction(base, resistance);
  degats *= protectionMultiplier(protege, malusMultiplier);
  degats *= sorcierMultiplier;
  return degats;
}

// `defense` doit déjà intégrer le débuff Voleuse du jour (défense effective
// = defense_du_jour - nb_voleuses × debuff_defense_par_vote, plancher 0),
// calculé par l'appelant (computeComboDamage), pas ici.
export function computeArcheresDamage({ base, defense, protege, malusMultiplier, archeresMultiplier }) {
  let degats = applyStatReduction(base, defense);
  degats *= protectionMultiplier(protege, malusMultiplier);
  degats *= archeresMultiplier;
  return degats;
}

// `dernierRole` = dernier rôle FINALISÉ du membre (jour précédent), ou
// null/undefined s'il n'a jamais voté ou n'a pas voté Chevalier hier.
export function isChevalierVoteAllowed(dernierRole) {
  return dernierRole !== "chevalier";
}

// Décompte des votes sur les 5 rôles d'action.
export function computeActionCounts(votesRaw) {
  const counts = { chevalier: 0, voleuse: 0, sorcier: 0, archeres: 0, princesse: 0 };
  for (const roleId of Object.values(votesRaw)) {
    if (roleId in counts) counts[roleId] += 1;
  }
  return counts;
}

// Règle "rôles identiques limités à 10" : au-delà de 10 votes pour un MÊME
// rôle, les votes supplémentaires (11e et suivants) n'ont plus aucun effet
// — ni dégât, ni capacité de protection (Chevalier), ni débuff Défense
// (Voleuse). Le compteur affiché sur les boutons/le bilan reste le compte
// RÉEL (jamais tronqué) — seul l'EFFET est plafonné, appliqué au plus près
// du calcul de dégâts/protection (computeComboDamage, computeDefenseEffective,
// et la capacité de protection dans evaluateCandidateCombo/computeCloture).
// Plafond dur sur les dégâts théoriques atteignables : 5 rôles × 10 = 50
// votes utiles au maximum par jour, au-delà tout vote supplémentaire (quel
// que soit le rôle choisi) est strictement gâché.
export const MAX_VOTES_PAR_ROLE = 10;

// Défense effective du jour après débuff Voleuse : -1 point par vote
// Voleuse (déterministe, aucun tirage, plafonné à MAX_VOTES_PAR_ROLE votes
// effectifs), plancher 0. Neutralisé par l'événement Rage du Boss
// (`voleuseDebuffDisabled`) — la Voleuse ne conserve alors que son dégât fixe.
export function computeDefenseEffective(nbVoleuses, dayParams, config) {
  if (dayParams.voleuseDebuffDisabled) return dayParams.defense;
  const effectiveVoleuses = Math.min(nbVoleuses, MAX_VOTES_PAR_ROLE);
  const debuff = config.roles.voleuse.debuff_defense_par_vote || 0;
  return Math.max(0, dayParams.defense - effectiveVoleuses * debuff);
}

// Dégâts totaux d'une combinaison (répartition de votes sur les 5 rôles
// d'action), étant donné combien de Sorciers/Archères sont protégés parmi
// eux. Fonction commune aux deux usages : clôture RÉELLE (protection
// dérivée de l'ordre d'arrivée réel, computeProtection) et recherche de
// MEILLEURE combinaison hypothétique (protection allouée de façon optimale,
// voir allocateOptimalProtection) — jamais deux formules de dégâts
// différentes.
//
// Princesse : dégât fixe (`config.roles.princesse.degats`), jamais réduit
// ni protégé — insensible à la Défense/Résistance du Boss, au malus de
// non-protection et aux multiplicateurs d'événement (`sorcierMultiplier`/
// `archeresMultiplier`, qui ne la concernent pas). Contrairement à
// Voleuse/Sorcier/Archères, son unique levier d'équilibrage est la valeur
// fixe elle-même (voir CONTRIBUTING.md, section Princesse) : sans coût
// d'investissement (pas de Chevalier nécessaire), la moindre valeur trop
// haute la rend strictement dominante à tout N.
export function computeComboDamage(counts, dayParams, config, { protectedSorcier, protectedArcheres }) {
  // Plafond "rôles identiques limités à 10" (MAX_VOTES_PAR_ROLE) — les
  // votes au-delà du plafond, pour un même rôle, sont ignorés ici. Pour
  // Sorcier/Archères, `protectedSorcier`/`protectedArcheres` DOIVENT déjà
  // avoir été calculés sur cette même population plafonnée par l'appelant
  // (evaluateCandidateCombo / computeCloture), sous peine de décompte
  // négatif de non-protégés.
  const voleuseCount = Math.min(counts.voleuse, MAX_VOTES_PAR_ROLE);
  const princesseCount = Math.min(counts.princesse || 0, MAX_VOTES_PAR_ROLE);
  const sorcierCount = Math.min(counts.sorcier, MAX_VOTES_PAR_ROLE);
  const archeresCount = Math.min(counts.archeres, MAX_VOTES_PAR_ROLE);

  const voleuseTotal = voleuseCount * config.roles.voleuse.degats;
  const princesseTotal = princesseCount * config.roles.princesse.degats;
  const defenseEffective = computeDefenseEffective(counts.voleuse, dayParams, config);

  const sorcierProtUnit = Math.round(
    computeSorcierDamage({
      base: config.roles.sorcier.degats,
      resistance: dayParams.resistance,
      protege: true,
      malusMultiplier: dayParams.malusMultiplier,
      sorcierMultiplier: dayParams.sorcierMultiplier,
    }),
  );
  const sorcierUnprotUnit = Math.round(
    computeSorcierDamage({
      base: config.roles.sorcier.degats,
      resistance: dayParams.resistance,
      protege: false,
      malusMultiplier: dayParams.malusMultiplier,
      sorcierMultiplier: dayParams.sorcierMultiplier,
    }),
  );
  const archeresProtUnit = Math.round(
    computeArcheresDamage({
      base: config.roles.archeres.degats,
      defense: defenseEffective,
      protege: true,
      malusMultiplier: dayParams.malusMultiplier,
      archeresMultiplier: dayParams.archeresMultiplier,
    }),
  );
  const archeresUnprotUnit = Math.round(
    computeArcheresDamage({
      base: config.roles.archeres.degats,
      defense: defenseEffective,
      protege: false,
      malusMultiplier: dayParams.malusMultiplier,
      archeresMultiplier: dayParams.archeresMultiplier,
    }),
  );

  const sorcierUnprotectedCount = sorcierCount - protectedSorcier;
  const archeresUnprotectedCount = archeresCount - protectedArcheres;
  const sorcierTotal = sorcierProtUnit * protectedSorcier + sorcierUnprotUnit * sorcierUnprotectedCount;
  const archeresTotal = archeresProtUnit * protectedArcheres + archeresUnprotUnit * archeresUnprotectedCount;

  return {
    total: voleuseTotal + princesseTotal + sorcierTotal + archeresTotal,
    breakdown: { voleuse: voleuseTotal, princesse: princesseTotal, sorcier: sorcierTotal, archeres: archeresTotal },
    defenseEffective,
  };
}

// Répartit la capacité de protection disponible entre Sorcier/Archères de
// façon à MAXIMISER les dégâts — au profit du rôle dont la protection
// rapporte le plus (delta protégé/non-protégé le plus élevé) en premier.
// Purement hypothétique (aucune notion d'ordre d'arrivée réel) : utilisée
// uniquement par computeBestCombo() pour établir le plafond théorique du
// jour, jamais pour la clôture réelle (qui utilise computeProtection).
export function allocateOptimalProtection(nSorcier, nArcheres, capacite, deltaSorcier, deltaArcheres) {
  let remaining = Math.min(capacite, nSorcier + nArcheres);
  let protectedSorcier = 0;
  let protectedArcheres = 0;
  const order = deltaSorcier >= deltaArcheres ? ["sorcier", "archeres"] : ["archeres", "sorcier"];
  for (const role of order) {
    const available = role === "sorcier" ? nSorcier : nArcheres;
    const take = Math.min(available, remaining);
    if (role === "sorcier") protectedSorcier = take;
    else protectedArcheres = take;
    remaining -= take;
  }
  return { protectedSorcier, protectedArcheres };
}

function evaluateCandidateCombo(counts, dayParams, config) {
  // Chevalier/Sorcier/Archères plafonnés à MAX_VOTES_PAR_ROLE AVANT
  // l'allocation de protection — indispensable : sans ce plafond ici,
  // `protectedSorcier`/`protectedArcheres` pourraient dépasser le compte
  // effectif (capé) utilisé ensuite par computeComboDamage, et produire un
  // nombre de non-protégés négatif.
  const chevalierCount = Math.min(counts.chevalier, MAX_VOTES_PAR_ROLE);
  const sorcierCount = Math.min(counts.sorcier, MAX_VOTES_PAR_ROLE);
  const archeresCount = Math.min(counts.archeres, MAX_VOTES_PAR_ROLE);
  const capacite = chevalierCount * dayParams.protectionSlots;
  const defenseEffective = computeDefenseEffective(counts.voleuse, dayParams, config);
  const sorcierProtUnit = computeSorcierDamage({
    base: config.roles.sorcier.degats,
    resistance: dayParams.resistance,
    protege: true,
    malusMultiplier: dayParams.malusMultiplier,
    sorcierMultiplier: dayParams.sorcierMultiplier,
  });
  const sorcierUnprotUnit = computeSorcierDamage({
    base: config.roles.sorcier.degats,
    resistance: dayParams.resistance,
    protege: false,
    malusMultiplier: dayParams.malusMultiplier,
    sorcierMultiplier: dayParams.sorcierMultiplier,
  });
  const archeresProtUnit = computeArcheresDamage({
    base: config.roles.archeres.degats,
    defense: defenseEffective,
    protege: true,
    malusMultiplier: dayParams.malusMultiplier,
    archeresMultiplier: dayParams.archeresMultiplier,
  });
  const archeresUnprotUnit = computeArcheresDamage({
    base: config.roles.archeres.degats,
    defense: defenseEffective,
    protege: false,
    malusMultiplier: dayParams.malusMultiplier,
    archeresMultiplier: dayParams.archeresMultiplier,
  });

  const { protectedSorcier, protectedArcheres } = allocateOptimalProtection(
    sorcierCount,
    archeresCount,
    capacite,
    sorcierProtUnit - sorcierUnprotUnit,
    archeresProtUnit - archeresUnprotUnit,
  );

  return computeComboDamage(counts, dayParams, config, { protectedSorcier, protectedArcheres });
}

// Recherche EXHAUSTIVE (force brute) de la répartition des `totalVotes`
// votants d'un jour entre les 5 rôles d'action qui maximise les dégâts —
// le "plafond théorique" du jour, servant de référence au score. O(N⁴/24)
// combinaisons : encore négligeable pour plusieurs dizaines de votants
// (quelques centaines de ms au pire, N=50), pas besoin d'heuristique plus
// fine. Princesse ajoutée comme 5ᵉ variable (le reliquat après les 4
// autres) plutôt qu'en 1ʳᵉ position : son coût nul (pas de protection à
// dimensionner) en fait un candidat "par défaut" pour tout surplus de
// votes que les 4 autres rôles ne rentabiliseraient pas mieux.
export function computeBestCombo(totalVotes, dayParams, config) {
  let best = { counts: { chevalier: 0, voleuse: 0, sorcier: 0, archeres: 0, princesse: 0 }, total: 0, breakdown: {} };
  for (let chevalier = 0; chevalier <= totalVotes; chevalier++) {
    for (let voleuse = 0; voleuse <= totalVotes - chevalier; voleuse++) {
      for (let sorcier = 0; sorcier <= totalVotes - chevalier - voleuse; sorcier++) {
        for (let archeres = 0; archeres <= totalVotes - chevalier - voleuse - sorcier; archeres++) {
          const princesse = totalVotes - chevalier - voleuse - sorcier - archeres;
          const counts = { chevalier, voleuse, sorcier, archeres, princesse };
          const result = evaluateCandidateCombo(counts, dayParams, config);
          if (result.total > best.total) {
            best = { counts, total: result.total, breakdown: result.breakdown };
          }
        }
      }
    }
  }
  return { counts: best.counts, damage: best.total, breakdown: best.breakdown };
}

// Note de combinaison (SS/S/A/B/C/D) — compare les dégâts obtenus au
// plafond théorique du jour (computeBestCombo). Seuils arbitraires mais
// tunables ici, indépendamment du reste du moteur.
export function gradeForRatio(ratio) {
  if (ratio >= 0.98) return "SS";
  if (ratio >= 0.9) return "S";
  if (ratio >= 0.8) return "A";
  if (ratio >= 0.6) return "B";
  if (ratio >= 0.5) return "C";
  return "D";
}

// Score cumulé affiché en permanence dans l'embed/Journal : compare le
// cumul RÉEL de dégâts au cumul du plafond théorique jour par jour (pas une
// simple moyenne des lettres quotidiennes, qui pondérerait injustement un
// jour à faible participation autant qu'un jour à forte participation).
// `null` tant qu'aucun jour n'a encore été clôturé (rien à comparer).
export function cumulativeScore(totalDegatsCumules, totalDegatsOptimalCumules) {
  if (!totalDegatsOptimalCumules) return null;
  return gradeForRatio(totalDegatsCumules / totalDegatsOptimalCumules);
}

// ── Ultime — bonus/malus de dégâts basé sur la performance des jours
// précédents (remplace l'ancien concept d'Ultime déclenché par vote) ──
// SS/S hier -> +10% de dégâts aujourd'hui, SS/S hier ET avant-hier (2 jours
// de suite) -> +30% (remplace le +10%, ne s'additionne pas). C/D hier ->
// -10%. Tout le reste (A/B, ou pas d'historique) : neutre, aucun effet. Un
// simple multiplicateur uniforme appliqué à TOUT le dégât du jour (voir
// computeCloture) — ne change jamais quelle combinaison est optimale
// (facteur commun au numérateur et au dénominateur du score), seuls les
// totaux affichés (dégâts du jour, cumul) en profitent ou en pâtissent.
const ULTIMATE_HIGH_GRADES = new Set(["SS", "S"]);
const ULTIMATE_LOW_GRADES = new Set(["C", "D"]);

export function computeUltimateMultiplier(gradeYesterday, gradeDayBefore) {
  if (ULTIMATE_HIGH_GRADES.has(gradeYesterday)) {
    return ULTIMATE_HIGH_GRADES.has(gradeDayBefore) ? 1.3 : 1.1;
  }
  if (ULTIMATE_LOW_GRADES.has(gradeYesterday)) return 0.9;
  return 1;
}

// Résout l'Ultime du jour à partir des scores déjà figés des 2 jours
// précédents (`bossraid:historique`, jamais réécrits une fois le jour clos)
// — safe à appeler aussi bien à l'affichage (jour en cours, encore ouvert)
// qu'à la clôture elle-même : le résultat ne peut pas changer entre les deux
// appels puisqu'il ne dépend que de jours déjà clos. `jour <= 2` (pas assez
// d'historique) résout naturellement en neutre via `getHistoriqueEntry`
// retournant `null`.
export async function resolveUltimateMultiplier(jour) {
  const [entryHier, entryAvantHier] = await Promise.all([
    getHistoriqueEntry(jour - 1),
    getHistoriqueEntry(jour - 2),
  ]);
  const gradeYesterday = entryHier?.score ?? null;
  const gradeDayBefore = entryAvantHier?.score ?? null;
  return {
    multiplier: computeUltimateMultiplier(gradeYesterday, gradeDayBefore),
    gradeYesterday,
    gradeDayBefore,
  };
}

// Les `max` premiers votants RÉELS d'un rôle donné, départagés par
// vote_at croissant — même précédent que la protection Chevalier
// (computeProtection). Sert à appliquer la règle "rôles identiques
// limités à 10" à la clôture réelle : au-delà du plafond, un votant
// n'existe simplement plus pour ce rôle (ni protection consommée, ni
// dégât), quel que soit l'ordre dans lequel les slots de protection sont
// ensuite répartis.
function selectEffectiveVoters(votesRaw, voteAtRaw, roleId, max) {
  return Object.entries(votesRaw)
    .filter(([, r]) => r === roleId)
    .map(([discordId]) => ({ discordId, votedAt: voteAtRaw[discordId] || "" }))
    .sort((a, b) => (a.votedAt < b.votedAt ? -1 : a.votedAt > b.votedAt ? 1 : 0))
    .slice(0, max)
    .map((v) => v.discordId);
}

// ── Orchestrateur pur — cœur de la clôture (aucun I/O) ──────────────
// protection → combinaison réelle (dégâts) → meilleure combinaison
// possible à nombre de votants égal → score du jour.

export function computeCloture({ jour, votesRaw, voteAtRaw, dayParams, config, totalDegatsAvant, totalDegatsOptimalAvant, ultimateMultiplier = 1 }) {
  const voteCounts = {};
  for (const roleId of Object.values(votesRaw)) voteCounts[roleId] = (voteCounts[roleId] || 0) + 1;
  const totalVotes = Object.keys(votesRaw).length;

  // `actionCounts` reste le compte RÉEL (jamais tronqué) — affiché tel
  // quel sur les boutons et dans le bilan (formatCombo). Seul l'EFFET des
  // votes au-delà de MAX_VOTES_PAR_ROLE est neutralisé plus bas.
  const actionCounts = computeActionCounts(votesRaw);
  const totalVotesAction =
    actionCounts.chevalier + actionCounts.voleuse + actionCounts.sorcier + actionCounts.archeres + actionCounts.princesse;

  // Sorcier/Archères plafonnés à leurs MAX_VOTES_PAR_ROLE premiers votants
  // (par ordre d'arrivée) AVANT toute allocation de protection — sinon un
  // 11e Sorcier pourrait consommer un slot de protection pour un dégât
  // qui ne compte plus, ou faire déborder le compte de non-protégés dans
  // computeComboDamage (lui aussi plafonné).
  const effectiveSorcierIds = new Set(selectEffectiveVoters(votesRaw, voteAtRaw, "sorcier", MAX_VOTES_PAR_ROLE));
  const effectiveArcheresIds = new Set(selectEffectiveVoters(votesRaw, voteAtRaw, "archeres", MAX_VOTES_PAR_ROLE));
  const distants = Object.entries(votesRaw)
    .filter(
      ([discordId, roleId]) =>
        (roleId === "sorcier" && effectiveSorcierIds.has(discordId)) ||
        (roleId === "archeres" && effectiveArcheresIds.has(discordId)),
    )
    .map(([discordId]) => ({ discordId, votedAt: voteAtRaw[discordId] || "" }));
  const protection = computeProtection(
    Math.min(actionCounts.chevalier, MAX_VOTES_PAR_ROLE),
    distants,
    dayParams.protectionSlots,
  );

  let protectedSorcier = 0;
  let protectedArcheres = 0;
  for (const [discordId, roleId] of Object.entries(votesRaw)) {
    if (!protection.protectedIds.has(discordId)) continue;
    if (roleId === "sorcier") protectedSorcier += 1;
    else if (roleId === "archeres") protectedArcheres += 1;
  }

  const actual = computeComboDamage(actionCounts, dayParams, config, { protectedSorcier, protectedArcheres });
  const best = computeBestCombo(totalVotesAction, dayParams, config);
  // Ratio calculé AVANT application de l'Ultime : un multiplicateur commun
  // au réel et au plafond théorique ne doit jamais influencer la note (voir
  // computeUltimateMultiplier) — seuls les totaux affichés ci-dessous en
  // profitent ou en pâtissent.
  const score = best.damage > 0 ? gradeForRatio(actual.total / best.damage) : null;

  const totalDamageDuJour = Math.round(actual.total * ultimateMultiplier);
  const bestDamage = Math.round(best.damage * ultimateMultiplier);
  const breakdown = Object.fromEntries(
    Object.entries(actual.breakdown).map(([role, value]) => [role, Math.round(value * ultimateMultiplier)]),
  );

  return {
    event: dayParams.event,
    dayParams,
    voteCounts,
    totalVotes,
    actionCounts,
    totalVotesAction,
    protection: {
      capacite: protection.capacite,
      protectedCount: protection.protectedIds.size,
      tousProteges: protection.tousProteges,
    },
    ultimateMultiplier,
    totalDamageDuJour,
    breakdown,
    bestCombo: best.counts,
    bestDamage,
    score,
    totalDegatsApres: totalDegatsAvant + totalDamageDuJour,
    totalDegatsOptimalApres: totalDegatsOptimalAvant + bestDamage,
  };
}

// ── Wrappers I/O — appelés uniquement par postBossRaid()/handlePrincesse() ──

async function loadCloture(jour, config) {
  const [votesRaw, voteAtRaw, usernamesRaw, state, ultimate] = await Promise.all([
    hgetallRaw(votesKey(jour)),
    hgetallRaw(voteAtKey(jour)),
    hgetallRaw(voteUsernamesKey(jour)),
    readState(),
    resolveUltimateMultiplier(jour),
  ]);
  const dayParams = resolveDayParams(jour, config);
  const result = computeCloture({
    jour,
    votesRaw,
    voteAtRaw,
    dayParams,
    config,
    totalDegatsAvant: state.totalDegatsCumules,
    totalDegatsOptimalAvant: state.totalDegatsOptimalCumules || 0,
    ultimateMultiplier: ultimate.multiplier,
  });
  // Pseudos rattachés après coup (jamais dans computeCloture, qui reste
  // pure) — sert uniquement à l'affichage admin (bossRaidStatus.js), lu
  // AVANT que clearVotes() ne supprime bossraid:vote_usernames:<jour>.
  return { ...result, usernamesRaw, ultimate };
}

// Lecture seule (aucune écriture Redis) — utilisée par le bouton Princesse
// (projection live sur le jour EN COURS de vote) ET par la branche --dry-run
// de postBossRaid.js. Les deux appellent littéralement la même fonction.
export async function previewCloture(jour, config) {
  return loadCloture(jour, config);
}

// Garde-fou anti-double-avancée (même incident/pattern que Robinson,
// 26/08) : un cron `schedule` en retard peut encore se déclencher après
// qu'un admin a relancé le jour à la main entretemps — sans ce filet, les
// deux appels à postBossRaid() clôtureraient chacun un jour d'affilée.
// MIN_HOURS_BETWEEN_CLOSURES reste très en dessous du cycle normal (~24h),
// donc sans impact sur le fonctionnement quotidien légitime.
export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  const hoursSince = (now - new Date(publishedAt).getTime()) / 3_600_000;
  return hoursSince < MIN_HOURS_BETWEEN_CLOSURES;
}

// Écrit l'historique, met à jour le dernier rôle finalisé des votants du
// jour, purge les clés de vote du jour. Appelée uniquement au cron réel.
export async function closeDayAndAdvance(jour, config) {
  const votesRaw = await hgetallRaw(votesKey(jour));
  const result = await loadCloture(jour, config);

  await writeHistoriqueEntry(jour, {
    event: result.event,
    dayParams: result.dayParams,
    voteCounts: result.voteCounts,
    totalVotes: result.totalVotes,
    actionCounts: result.actionCounts,
    protection: result.protection,
    ultimateMultiplier: result.ultimateMultiplier,
    totalDamageDuJour: result.totalDamageDuJour,
    breakdown: result.breakdown,
    bestCombo: result.bestCombo,
    bestDamage: result.bestDamage,
    score: result.score,
    totalDegatsApres: result.totalDegatsApres,
    totalDegatsOptimalApres: result.totalDegatsOptimalApres,
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

// ── Manches (bilans de fin de Raid) ────────────────────────────────
// Le jeu est destiné à être rejoué plusieurs fois dans l'année (un Raid =
// une "manche"). Contrairement à HISTORIQUE_KEY (bilans quotidiens d'UNE
// manche, écrasés d'une manche à l'autre puisque les jours 1-7 se
// répètent), MANCHES_KEY est un HASH permanent indexé par un numéro de
// manche strictement croissant (`MANCHE_SEQ_KEY`, `INCR` atomique) —
// jamais nettoyé par resetBossRaid(), pour que le récap de fin de Raid
// puisse comparer la manche qui vient de se terminer aux précédentes.

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

// `clearManches: false` par défaut — l'archive des manches passées (parties
// réellement jouées au fil de l'année) survit à un reset normal, pour ne
// jamais l'effacer par erreur en cours de partie réelle. Seul un reset
// explicite (`--manches`, voir scripts/resetBossRaid.js) l'efface, utile en
// phase de test pour ne pas polluer l'archive avec des manches de test.
export async function resetBossRaid({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, DERNIER_ROLE_KEY, HISTORIQUE_KEY);
  await scanDelete("bossraid:votes:*");
  await scanDelete("bossraid:vote_at:*");
  await scanDelete("bossraid:vote_usernames:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
