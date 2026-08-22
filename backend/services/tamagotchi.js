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

const STATE_KEY = "tamagotchi:state";
const HISTORIQUE_KEY = "tamagotchi:historique";
const MANCHES_KEY = "tamagotchi:manches";
const MANCHE_SEQ_KEY = "tamagotchi:manche_seq";

function votesKey(jour) {
  return `tamagotchi:votes:${jour}`;
}

function voteUsernamesKey(jour) {
  return `tamagotchi:vote_usernames:${jour}`;
}

const PILULE_TOTAL_KEY = "tamagotchi:pilule_total_used";

function piluleUsedDayKey(jour) {
  return `tamagotchi:pilule_used:${jour}`;
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

// Libère le vote du jour d'un joueur — utilisé uniquement quand un vote
// "réservé" (ex. Pilule) échoue ensuite pour une raison indépendante du
// joueur (déjà utilisée par quelqu'un d'autre, quota épuisé) : il n'a alors
// pas réellement voté, il doit pouvoir revoter une vraie action. Même
// précédent que releaseVoteSlot() dans backend/services/robinson.js.
export async function releaseVote(jour, discordId) {
  await getRedis().hdel(votesKey(jour), discordId);
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

// ── Pilule (filet de sécurité rare, Jours 4-10) ──────────────────────
// Contrairement aux votes normaux (par joueur), la Pilule est une ressource
// PARTAGÉE : au plus 1 réussite par jour (premier arrivé), et au plus
// `cap` réussites cumulées sur toute la manche. SETNX quotidien d'abord (sans
// effet de bord si échec), puis INCR du total (compensé s'il dépasse le
// plafond) — cette ordre minimise la surface de compensation à un seul cas.
export async function claimPilule(jour, cap) {
  const redis = getRedis();
  const dayClaimed = Number(await redis.setnx(piluleUsedDayKey(jour), "1"));
  if (!dayClaimed) {
    return { claimed: false, reason: "already_used_today" };
  }
  const totalUsed = Number(await redis.incr(PILULE_TOTAL_KEY));
  if (totalUsed > cap) {
    await redis.decr(PILULE_TOTAL_KEY);
    return { claimed: false, reason: "total_exhausted" };
  }
  return { claimed: true, totalUsed };
}

// Lecture seule pour l'affichage (bouton Discord, script de statut) — séparée
// de claimPilule() pour ne jamais muter l'état en construisant un embed.
// Note : si le quota total a été atteint un jour donné, la clé du jour reste
// "posée" (harmless, rien ne peut plus réussir de toute façon) — c'est pour
// ça que l'appelant doit toujours vérifier `exhausted` avant `usedToday`.
export async function readPiluleState(jour, cap) {
  const redis = getRedis();
  const [usedTodayRaw, totalUsedRaw] = await Promise.all([
    redis.get(piluleUsedDayKey(jour)),
    redis.get(PILULE_TOTAL_KEY),
  ]);
  const totalUsed = Number(totalUsedRaw) || 0;
  return {
    usedToday: usedTodayRaw != null,
    totalUsed,
    remaining: Math.max(0, cap - totalUsed),
    exhausted: totalUsed >= cap,
  };
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
// `votantsReference` (optionnel) introduit un facteur de participation :
// sans lui (ou à 0), le résultat ne dépend que du RATIO entre actions votées
// — "1 Câliner + 2 Sieste" produit alors exactement le même impact que
// "2+4" ou "300+600", aucune incitation à voter en nombre. Avec lui, le
// résultat est multiplié par min(total_votes / votantsReference, 1) : en
// dessous de la référence, l'effet est proportionnellement affaibli (plus de
// votants = plus d'impact) ; à la référence ou au-delà, l'effet est
// identique à un partage de vote sans ce facteur (jamais de survitaminage
// au-delà de la magnitude déclarée des actions).
// `fatigue` (optionnel) : { actionId, facteur } — l'action qui a dominé les
// votes la VEILLE voit sa part multipliée par `facteur` (ex. 0.5) en plus de
// la participation. Force un changement de stratégie d'un jour à l'autre :
// répéter benoîtement la même action gagnante ne marche plus deux jours de
// suite. Rétro-compatible : omis, comportement inchangé.
export function computeDayImpact(voteCounts, actionsConfig, votantsReference, fatigue) {
  const actionIds = Object.keys(actionsConfig).filter(
    (id) => !actionsConfig[id].is_info_action,
  );
  const total = actionIds.reduce((sum, id) => sum + (voteCounts[id] || 0), 0);
  const impact = { estomac: 0, energie: 0, moral: 0 };
  if (total === 0) return impact;
  const participation = votantsReference
    ? Math.min(total / votantsReference, 1)
    : 1;
  for (const id of actionIds) {
    const share = (voteCounts[id] || 0) / total;
    const fatigueFactor = fatigue && id === fatigue.actionId ? fatigue.facteur : 1;
    const actionImpact = actionsConfig[id].impact || {};
    for (const gauge of Object.keys(impact)) {
      impact[gauge] += participation * fatigueFactor * share * (actionImpact[gauge] || 0);
    }
  }
  return impact;
}

// Action qui a recueilli le plus de votes ce jour-là (Câliner incluse — elle
// doit pouvoir se fatiguer aussi, sinon elle devient une cible de vote
// éternellement "sûre"). Égalité stricte (ou aucun vote) -> null : pas de
// fatigue arbitraire à appliquer sur un ex-aequo.
export function dominantAction(voteCounts, actionIds) {
  let best = null;
  let bestCount = 0;
  let tie = false;
  for (const id of actionIds) {
    const n = voteCounts[id] || 0;
    if (n === 0) continue;
    if (n > bestCount) {
      best = id;
      bestCount = n;
      tie = false;
    } else if (n === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

// Un événement peut temporairement changer ce que rapporte une action pour
// la journée (ex. Pénurie de vivres, Jour 8 : Nourrir remplit moins l'Estomac)
// via `actionsModifiees`, plutôt qu'un simple delta de
// jauges appliqué une fois — l'effet dure toute la journée puisqu'il change
// directement le calcul de computeDayImpact(). Fusion superficielle : seuls
// les axes précisés dans l'override remplacent ceux de l'action de base, les
// autres axes (et les actions non listées) restent inchangés.
export function applyActionOverrides(actionsConfig, actionsModifiees) {
  if (!actionsModifiees) return actionsConfig;
  const out = { ...actionsConfig };
  for (const [id, overrideImpact] of Object.entries(actionsModifiees)) {
    if (!out[id]) continue;
    out[id] = { ...out[id], impact: { ...out[id].impact, ...overrideImpact } };
  }
  return out;
}

// Delta de la Pilule : rapproche chaque jauge de `target` d'au plus `maxStep`
// points, sans jamais la dépasser (ex. valeur=79, target=55, maxStep=10 ->
// -10 ; valeur=58, target=55, maxStep=10 -> -3, atteint la cible pile).
// Résultat destiné à applyGaugeDelta() ci-dessous (pas de clamp/arrondi ici).
export function computePiluleDelta(gauges, target, maxStep) {
  const out = {};
  for (const gauge of Object.keys(gauges)) {
    out[gauge] = Math.max(-maxStep, Math.min(maxStep, target - gauges[gauge]));
  }
  return out;
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

// Le jour d'apparition vit dans la donnée elle-même (champ `jour` de chaque
// événement, voir data/tamagotchi/tamagotchi.json) plutôt que dans un mapping
// séparé côté code : ajouter/déplacer un événement ne demande alors qu'une
// édition du JSON, jamais de toucher au JS.
export function eventForDay(jour, evenementsPossibles) {
  return evenementsPossibles.find((e) => e.jour === jour) ?? null;
}

// Jauges d'ouverture d'un jour : applique d'abord l'éventuel événement du
// jour (modificateur_jauges, un delta ponctuel), puis la décroissance
// passive (config.decroissance) si le jour l'atteint déjà — les deux
// cumulent le même jour plutôt que de s'annuler. Centralisé ici pour que
// postTamagotchi() (clôture réelle) et tamagotchiStatus.js (projection)
// appliquent exactement la même règle, sans dupliquer la logique.
export function computeDayOpenGauges(gaugesClosing, jour, event, config) {
  let gauges = event?.modificateur_jauges
    ? applyGaugeDelta(gaugesClosing, event.modificateur_jauges)
    : gaugesClosing;
  const decroissance = config.decroissance;
  if (decroissance && jour >= decroissance.jour_min) {
    gauges = applyGaugeDelta(gauges, decroissance.modificateur_jauges);
  }
  return gauges;
}

export function computeFinalTier(starTotal) {
  if (starTotal >= 8) return "S";
  if (starTotal >= 4) return "B";
  return "F";
}

// ── Confiance (jauge à sens unique, non compensable par les 3 jauges) ────
// Baisse sur les jours "Moyenne"/"Catastrophe", ne remonte QUE via l'action
// Câliner (elle-même sujette à la fatigue, voir `fatigue` ci-dessus, sinon
// la spammer une fois les jauges stabilisées deviendrait une échappatoire
// triviale). Plafonne le palier de fin de manche (capTierByConfiance) plutôt
// que d'interférer avec le calcul quotidien des jauges — un mauvais début de
// manche laisse une trace qu'aucun bon jour de jauges ne peut effacer.

// Même formule share × participation × fatigue que computeDayImpact, mais
// appliquée au bonus de Confiance de Câliner plutôt qu'aux 3 jauges.
export function computeCalinerConfianceBonus(voteCounts, actionsConfig, votantsReference, fatigue) {
  const caliner = actionsConfig.caliner;
  if (!caliner?.confiance_bonus) return 0;
  const actionIds = Object.keys(actionsConfig).filter(
    (id) => !actionsConfig[id].is_info_action,
  );
  const total = actionIds.reduce((sum, id) => sum + (voteCounts[id] || 0), 0);
  if (total === 0) return 0;
  const participation = votantsReference
    ? Math.min(total / votantsReference, 1)
    : 1;
  const share = (voteCounts.caliner || 0) / total;
  const fatigueFactor = fatigue && fatigue.actionId === "caliner" ? fatigue.facteur : 1;
  return participation * fatigueFactor * share * caliner.confiance_bonus;
}

export function computeConfianceDelta(ratingLabel, calinerBonus, confianceConfig) {
  const malus =
    ratingLabel === "moyenne"
      ? confianceConfig.malus_moyen
      : ratingLabel === "catastrophe"
        ? confianceConfig.malus_catastrophe
        : 0;
  return malus + calinerBonus;
}

const TIER_ORDER = ["F", "B", "S"]; // du pire au meilleur

// Cherche le seuil `plafond_tier` le plus restrictif franchi (trié par
// `sous` croissant -> premier trouvé = le plus bas donc le plus sévère), et
// renvoie le pire des deux paliers entre celui calculé sur les étoiles et le
// plafond trouvé. Sans config.confiance (ou plafond_tier vide) : le palier
// d'origine est renvoyé tel quel.
export function capTierByConfiance(tier, confianceFinale, confianceConfig) {
  const plafonds = confianceConfig?.plafond_tier;
  if (!plafonds?.length) return tier;
  const tries = [...plafonds].sort((a, b) => a.sous - b.sous);
  for (const { sous, max } of tries) {
    if (confianceFinale < sous) {
      return TIER_ORDER.indexOf(max) < TIER_ORDER.indexOf(tier) ? max : tier;
    }
  }
  return tier;
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

// ── Manches (bilans de fin de partie) ────────────────────────────
// Le jeu est destiné à être rejoué plusieurs fois dans l'année (une partie
// = une "manche"). Contrairement à HISTORIQUE_KEY (bilans quotidiens d'UNE
// manche, écrasés d'une manche à l'autre puisque les jours 1-10 se
// répètent), MANCHES_KEY est un HASH permanent indexé par un numéro de
// manche strictement croissant (`MANCHE_SEQ_KEY`, `INCR` atomique) —
// jamais nettoyé par resetTamagotchi(), pour que le récap de fin de partie
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

// ── Résolution/clôture du jour courant ──────────────────────────────
// Appelée uniquement par postTamagotchi() (api/discord/_handlers/tamagotchi.js)
// au moment du cron quotidien. Toute la logique métier vit ici, jamais dans
// le handler ni dans interactions.js.

async function computeClosure(state, config) {
  const [voteCounts, voters] = await Promise.all([
    tallyVotes(state.jour),
    listVotes(state.jour),
  ]);
  // state.lastEvent est l'événement du jour qu'on clôture ici (écrit quand ce
  // jour a démarré, voir postTamagotchi()) — c'est lui, pas l'événement du
  // jour suivant, qui doit influencer le calcul d'impact de CE jour.
  const actionsConfig = applyActionOverrides(config.actions, state.lastEvent?.actions_modifiees);
  // state.actionFatiguee = action dominante du jour PRÉCÉDENT (posée par le
  // computeClosure() d'hier) — c'est elle qui est pénalisée aujourd'hui.
  const fatigue =
    config.fatigue && state.actionFatiguee
      ? { actionId: state.actionFatiguee, facteur: config.fatigue.facteur }
      : null;
  const impact = computeDayImpact(voteCounts, actionsConfig, config.votants_reference, fatigue);
  const gaugesClosing = applyGaugeDelta(state.gauges, impact);
  const rating = rateDay(gaugesClosing, config.zones_ideales);

  let confianceApres = state.confiance;
  if (config.confiance) {
    const calinerBonus = computeCalinerConfianceBonus(voteCounts, actionsConfig, config.votants_reference, fatigue);
    const delta = computeConfianceDelta(rating.rating, calinerBonus, config.confiance);
    confianceApres = clampGauge(Math.round((state.confiance ?? config.confiance.depart) + delta));
  }

  // Action dominante DE CE JOUR (celui qu'on clôture ici) — devient
  // actionFatiguee pour la clôture du jour SUIVANT, pas celui-ci.
  const actionIds = Object.keys(config.actions).filter((id) => !config.actions[id].is_info_action);
  const actionFatigueeSuivante = config.fatigue ? dominantAction(voteCounts, actionIds) : null;

  return { voteCounts, voters, impact, gaugesClosing, rating, confianceApres, actionFatigueeSuivante };
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run,
// qui ne doit jamais faire avancer la partie ni consommer les votes du jour
// actif.
export async function previewCloseDay(state, config) {
  return computeClosure(state, config);
}

export async function closeDayAndAdvance(state, config) {
  const { voteCounts, voters, impact, gaugesClosing, rating, confianceApres, actionFatigueeSuivante } =
    await computeClosure(state, config);
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
    confianceAvant: state.confiance,
    confianceApres,
    actionFatiguee: state.actionFatiguee ?? null,
    resolvedAt: new Date().toISOString(),
  });
  await clearVotes(state.jour);

  return { gaugesClosing, rating, starTotalApres, voteCounts, voters, confianceApres, actionFatigueeSuivante };
}

// ── Remise à zéro ────────────────────────────────────────────────────

// `clearManches: false` par défaut — l'archive des manches passées (parties
// réellement jouées au fil de l'année) survit à un reset normal, pour ne
// jamais l'effacer par erreur en cours de partie réelle. Seul un reset
// explicite (`--manches`, voir scripts/resetTamagotchi.js) l'efface, utile
// en phase de test pour ne pas polluer l'archive avec des manches de test.
export async function resetTamagotchi({ clearManches = false } = {}) {
  // PILULE_TOTAL_KEY et les clés pilule_used:<jour> sont nettoyées
  // inconditionnellement (même hors --manches) : les numéros de jour se
  // répètent d'une manche à l'autre, une clé résiduelle bloquerait
  // silencieusement le Jour 4 de la manche suivante.
  await getRedis().del(STATE_KEY, HISTORIQUE_KEY, PILULE_TOTAL_KEY);
  await scanDelete("tamagotchi:votes:*");
  await scanDelete("tamagotchi:vote_usernames:*");
  await scanDelete("tamagotchi:pilule_used:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
