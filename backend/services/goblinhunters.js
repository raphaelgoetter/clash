// ============================================================
// goblinhunters.js — Goblin Hunters, jeu à identité secrète/camps cachés
// (Chasseurs vs Gobelins infiltrés) façon Shadow Hunters/Loups-Garous,
// adapté au rythme asynchrone quotidien du bot. Couche métier : config
// statique, inscriptions, attribution des camps/rôles, actions du jour,
// résolution de clôture (combat + vote + enquêtes + positions), historique.
//
// Stockage : Upstash Redis (mêmes conventions que bossraid.js/robinson.js)
// — espace de clés `goblinhunters:*`.
//
// ⚠️ Modèle de référence = Boss Raid, pas Robinson : rien n'est appliqué en
// direct pendant la journée (positions/PV/votes/actions). Tout se résout
// UNE SEULE FOIS à la clôture, dans computeCloture() — une fonction pure.
// Les boutons/select menus du jour se contentent d'un HSET écrasable
// (dernier clic gagne, modifiable jusqu'au cron), jamais de tirage ni de
// mutation d'état de partie au clic.
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
const GOBLINHUNTERS_DIR = path.resolve(__dirname, "..", "..", "data", "goblinhunters");
const CONFIG_JSON_PATH = path.join(GOBLINHUNTERS_DIR, "goblinhunters.json");
const NARRATIFS_JSON_PATH = path.join(GOBLINHUNTERS_DIR, "narratifs.json");

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

const STATE_KEY = "goblinhunters:state";
const INSCRIPTIONS_KEY = "goblinhunters:inscriptions";
const HISTORIQUE_KEY = "goblinhunters:historique";
const MANCHES_KEY = "goblinhunters:manches";
const MANCHE_SEQ_KEY = "goblinhunters:manche_seq";

function actionsKey(jour) {
  return `goblinhunters:actions:${jour}`;
}
function actionUsernamesKey(jour) {
  return `goblinhunters:action_usernames:${jour}`;
}
function votesKey(jour) {
  return `goblinhunters:votes:${jour}`;
}
function voteUsernamesKey(jour) {
  return `goblinhunters:vote_usernames:${jour}`;
}

// ── Lecture de la config (statique, jamais mutée) ─────────────────

let configCache = null;

export async function loadGoblinHuntersConfig() {
  if (configCache) return configCache;
  const txt = await fs.readFile(CONFIG_JSON_PATH, "utf-8");
  configCache = JSON.parse(txt);
  return configCache;
}

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

// ── Inscriptions (phase "inscription") ─────────────────────────────
// Chaque joueur ne touche que SON PROPRE champ du hash (safe en
// concurrence). Le contrôle de capacité (effectif_max) est un
// check-then-act non atomique sur l'ensemble du hash — risque de dépassement
// d'1 joueur en cas de double-clic strictement simultané, accepté ici
// (même niveau de rigueur que le reste du repo pour ce type de fenêtre de
// course marginale, voir robinson.js pour un cas où l'atomicité stricte est
// au contraire nécessaire — pas le cas ici, un inscrit de trop se règle à
// la main avant le lancement).

export async function registerPlayer(discordId, username, effectifMax) {
  const already = await getRedis().hget(INSCRIPTIONS_KEY, discordId);
  if (already) return { status: "already_registered" };
  const count = await countInscriptions();
  if (count >= effectifMax) return { status: "full" };
  await getRedis().hset(INSCRIPTIONS_KEY, {
    [discordId]: toJson({ username, registeredAt: new Date().toISOString() }),
  });
  return { status: "registered" };
}

export async function unregisterPlayer(discordId) {
  const removed = await getRedis().hdel(INSCRIPTIONS_KEY, discordId);
  return { status: removed ? "unregistered" : "not_registered" };
}

export async function listInscriptions() {
  const raw = await hgetallJson(INSCRIPTIONS_KEY);
  return Object.entries(raw).map(([discordId, detail]) => ({ discordId, ...detail }));
}

export async function countInscriptions() {
  return Number(await getRedis().hlen(INSCRIPTIONS_KEY)) || 0;
}

export async function clearInscriptions() {
  await getRedis().del(INSCRIPTIONS_KEY);
}

// ── Attribution des camps/rôles (pures, rng injectable pour les tests) ──

export function computeMinorityCount(totalPlayers, minorityTable) {
  return minorityTable[String(totalPlayers)] ?? Math.round(totalPlayers / 3);
}

function shuffle(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// 1 exemplaire de chaque rôle spécial (Éclaireur/Bûcheron côté Chasseurs,
// Infiltré côté Gobelins), quel que soit l'effectif — voir goblinhunters.json.
// Retourne [{discordId, camp, role}], role = null pour les joueurs de base.
export function assignCampsAndRoles(playerIds, minorityCount, rng = Math.random) {
  const shuffled = shuffle(playerIds, rng);
  const gobelins = shuffled.slice(0, minorityCount);
  const chasseurs = shuffled.slice(minorityCount);

  const assignments = new Map();
  for (const id of gobelins) assignments.set(id, { discordId: id, camp: "gobelin", role: null });
  for (const id of chasseurs) assignments.set(id, { discordId: id, camp: "chasseur", role: null });

  const gobelinsShuffled = shuffle(gobelins, rng);
  if (gobelinsShuffled[0]) assignments.get(gobelinsShuffled[0]).role = "infiltre";

  const chasseursShuffled = shuffle(chasseurs, rng);
  if (chasseursShuffled[0]) assignments.get(chasseursShuffled[0]).role = "eclaireur";
  if (chasseursShuffled[1]) assignments.get(chasseursShuffled[1]).role = "bucheron";

  return [...assignments.values()];
}

export function buildInitialRoster(inscriptions, assignments, combatConfig) {
  const usernameById = new Map(inscriptions.map((i) => [i.discordId, i.username]));
  return assignments.map(({ discordId, camp, role }) => {
    const roleConfig = role === "bucheron" ? combatConfig.bucheronOverride : null;
    return {
      discordId,
      username: usernameById.get(discordId) || discordId,
      camp,
      role,
      pv: roleConfig?.pv ?? combatConfig.pv_base,
      pvMax: roleConfig?.pv ?? combatConfig.pv_base,
      position: "chateau",
      alive: true,
      campReveleAt: null,
    };
  });
}

// ── Actions du jour (lieu + cible éventuelle) ───────────────────────
// HSET écrasable (comme les votes de Bossraid) : modifiable jusqu'à la
// clôture, dernier clic gagne. `slot` = "primary" ou "secondary" (2e action
// de l'Éclaireur uniquement) — le contrôle du rôle autorisant "secondary"
// se fait côté handler Discord (accès à state.joueurs), pas ici.

export async function recordAction(jour, discordId, slot, { lieu, cibleId = null }, username) {
  const existingRaw = await getRedis().hget(actionsKey(jour), discordId);
  const existing = fromJson(existingRaw) || {};
  existing[slot] = { lieu, cibleId };
  await getRedis().hset(actionsKey(jour), { [discordId]: toJson(existing) });
  if (username) {
    await getRedis().hset(actionUsernamesKey(jour), { [discordId]: username });
  }
  return existing;
}

export async function readActions(jour) {
  return hgetallJson(actionsKey(jour));
}

// Anti-camping : impossible de choisir le même lieu que celui occupé la
// veille (Jour 1 exclu — la position de spawn initiale au Château ne compte
// pas comme un choix actif). Décidé pour dynamiser le jeu : sans ça, rester
// au Château en continu offre une immunité totale et gratuite au combat (le
// ciblage étant restreint au dernier lieu connu, voir computeAttacksFromActions),
// contrairement à la Taverne qui au moins plafonne sa protection sous un
// seuil. Même principe que isChevalierVoteAllowed() dans bossraid.js — un
// garde-fou vérifié au clic, pas une contrainte de résolution à la clôture.
export function isLieuRepeatAllowed(previousPosition, lieu, jour) {
  if (Number(jour) <= 1) return true;
  return previousPosition !== lieu;
}

async function clearActions(jour) {
  await getRedis().del(actionsKey(jour), actionUsernamesKey(jour));
}

// ── Vote d'accusation (Château) ─────────────────────────────────────
// HSET écrasable (PAS HSETNX) : contrairement au vote de Robinson (qui
// consomme une ressource partagée limitée et doit donc être verrouillé),
// l'accusation ici est juste l'action du jour comme les autres lieux —
// modifiable jusqu'à la clôture, même sémantique que le vote de Bossraid.

export async function recordVoteChateau(jour, discordId, cibleId, username) {
  await getRedis().hset(votesKey(jour), { [discordId]: cibleId });
  if (username) {
    await getRedis().hset(voteUsernamesKey(jour), { [discordId]: username });
  }
}

export async function tallyVotesChateau(jour) {
  return hgetallRaw(votesKey(jour));
}

async function clearVotesChateau(jour) {
  await getRedis().del(votesKey(jour), voteUsernamesKey(jour));
}

// ── Fonctions pures de résolution (aucun I/O, testées unitairement) ──

export function computeVoteTally(votesRaw) {
  const counts = {};
  for (const cibleId of Object.values(votesRaw)) {
    if (!cibleId) continue;
    counts[cibleId] = (counts[cibleId] || 0) + 1;
  }
  return counts;
}

// Égalité entre plusieurs cibles au score maximum -> personne n'est
// éliminé (décision actée avec l'utilisateur, contrairement au tirage au
// sort utilisé pour départager une égalité en combat).
export function resolveVoteElimination(voteTally) {
  const entries = Object.entries(voteTally);
  if (!entries.length) return null;
  const maxCount = Math.max(...entries.map(([, c]) => c));
  const top = entries.filter(([, c]) => c === maxCount);
  return top.length === 1 ? top[0][0] : null;
}

// Joueurs ayant choisi la Taverne aujourd'hui (protection potentielle) —
// distingue primary/secondary pour couvrir le cas Éclaireur.
export function computeTavernOccupants(actionsRaw) {
  const occupants = new Set();
  for (const [discordId, action] of Object.entries(actionsRaw)) {
    if (action?.primary?.lieu === "taverne" || action?.secondary?.lieu === "taverne") {
      occupants.add(discordId);
    }
  }
  return occupants;
}

// La protection ne tient que sous le seuil configuré (surpeuplée, elle ne
// protège plus personne ce jour-là) — garde-fou contre le camping massif de
// la Taverne, décidé avec l'utilisateur.
export function computeTavernProtection(occupants, seuil) {
  if (occupants.size === 0 || occupants.size >= seuil) return new Set();
  return new Set(occupants);
}

// Ciblage restreint : la cible d'un combat/enquête doit être positionnée au
// lieu choisi sur le DERNIER PLATEAU CONNU (joueursAvant, figé depuis la
// clôture précédente) — pas de ciblage libre. Le select menu Discord ne
// propose déjà que ces cibles valides, cette fonction re-filtre quand même
// par défense (ex. cible éliminée par le vote la même clôture, voir
// computeCloture). "clairiere_mystique" est traitée comme une variante
// discrète de combat (voir resolveCombat) : même filtrage de ciblage.
function resolveEligibleAttacks(actionsRaw, joueursAvant, lieuxCombat) {
  const positionById = new Map(joueursAvant.map((j) => [j.discordId, j.position]));
  const aliveById = new Map(joueursAvant.map((j) => [j.discordId, j.alive]));
  const attacks = [];
  for (const [attackerId, action] of Object.entries(actionsRaw)) {
    for (const slot of ["primary", "secondary"]) {
      const a = action?.[slot];
      if (!a || !lieuxCombat.includes(a.lieu) || !a.cibleId) continue;
      if (!aliveById.get(attackerId)) continue;
      if (!aliveById.get(a.cibleId)) continue;
      if (positionById.get(a.cibleId) !== a.lieu) continue; // cible plus présente à ce lieu
      attacks.push({ attackerId, targetId: a.cibleId, lieu: a.lieu });
    }
  }
  return attacks;
}

// Dégâts par attaque : 1 dégât de base, 2 pour le Bûcheron (rôle de
// l'attaquant, pas de la cible). "clairiere_mystique" ignore la protection
// Taverne de la cible (attaque discrète qui contourne la surveillance) —
// seule différence mécanique avec "camp_entrainement".
export function computeAttacksFromActions(actionsRaw, joueursAvant, config) {
  const roleById = new Map(joueursAvant.map((j) => [j.discordId, j.role]));
  const attacks = resolveEligibleAttacks(actionsRaw, joueursAvant, ["camp_entrainement", "clairiere_mystique"]);
  return attacks.map((a) => ({
    ...a,
    degats: roleById.get(a.attackerId) === "bucheron" ? config.roles.bucheron.degats : config.combat.degats_base,
    discret: a.lieu === "clairiere_mystique",
  }));
}

export function sumDamagePerTarget(attacks, protectedSet) {
  const totals = {};
  for (const a of attacks) {
    if (!a.discret && protectedSet.has(a.targetId)) continue; // protégé par la Taverne, attaque bloquée
    totals[a.targetId] = (totals[a.targetId] || 0) + a.degats;
  }
  return totals;
}

// Plafond anti-snowball : 1 mort par combat maximum par jour, tous
// attaquants confondus. Si plusieurs cibles seraient mortelles le même jour,
// seule celle ayant reçu le plus de dégâts meurt réellement ; les autres
// sont plafonnées à 1 PV minimum. Égalité -> tirage au sort (rng).
export function resolveCombat(pvBefore, damagePerTarget, rng = Math.random) {
  const rawPvAfter = {};
  for (const [id, pv] of Object.entries(pvBefore)) {
    rawPvAfter[id] = pv - (damagePerTarget[id] || 0);
  }
  const candidates = Object.entries(rawPvAfter).filter(([, pv]) => pv <= 0);

  if (candidates.length <= 1) {
    return { pvAfter: rawPvAfter, deathId: candidates[0]?.[0] ?? null };
  }

  const maxDamage = Math.max(...candidates.map(([id]) => damagePerTarget[id] || 0));
  const topCandidates = candidates.filter(([id]) => (damagePerTarget[id] || 0) === maxDamage);
  const [deathId] = topCandidates.length === 1 ? topCandidates[0] : topCandidates[Math.floor(rng() * topCandidates.length)];

  const pvAfter = { ...rawPvAfter };
  for (const [id] of candidates) {
    pvAfter[id] = id === deathId ? rawPvAfter[id] : 1;
  }
  return { pvAfter, deathId };
}

// Enquête (Tour de Guet) : révèle le camp de la cible, sauf sur l'Infiltré
// qui renvoie toujours "chasseur" (faux positif classique du genre).
export function computeInvestigations(actionsRaw, joueursAvant) {
  const joueurById = new Map(joueursAvant.map((j) => [j.discordId, j]));
  const attacks = resolveEligibleAttacks(actionsRaw, joueursAvant, ["tour_de_guet"]);
  return attacks.map(({ attackerId, targetId }) => {
    const cible = joueurById.get(targetId);
    const campReporte = cible.role === "infiltre" ? "chasseur" : cible.camp;
    return { investigatorId: attackerId, cibleId: targetId, campReporte };
  });
}

// Nouvelle position affichée pour chaque joueur vivant : le lieu de sa
// dernière action soumise (secondary si Éclaireur ayant joué 2 fois),
// retombe au Château par défaut (pass automatique, décidé avec l'utilisateur).
export function computeNewPositions(actionsRaw, joueursAvant, defaultLieu = "chateau") {
  const positions = {};
  for (const j of joueursAvant) {
    if (!j.alive) continue;
    const action = actionsRaw[j.discordId];
    positions[j.discordId] = action?.secondary?.lieu || action?.primary?.lieu || defaultLieu;
  }
  return positions;
}

export function checkVictory(joueursApres, jourCourant, dureeJours) {
  const vivants = joueursApres.filter((j) => j.alive);
  const gobelinsVivants = vivants.filter((j) => j.camp === "gobelin").length;
  const chasseursVivants = vivants.filter((j) => j.camp === "chasseur").length;

  if (gobelinsVivants > 0 && gobelinsVivants >= chasseursVivants) return "gobelins_parite";
  if (gobelinsVivants === 0) return "chasseurs_gobelins_elimines";
  if (jourCourant >= dureeJours) return "chasseurs_survie";
  return null;
}

// ── Orchestrateur pur — cœur de la clôture (aucun I/O) ──────────────
// Jour 1 : aucune élimination possible (ni vote ni combat), garde-fou
// décidé avec l'utilisateur — seules positions et enquêtes sont calculées.
// Ordre de résolution : vote D'ABORD (le camp accusé est retiré des cibles
// et attaquants possibles du combat qui suit), puis combat — reproduit le
// classique enchaînement jour/nuit du genre.

export function computeCloture({ jour, actionsRaw, votesRaw, joueursAvant, config, rng = Math.random }) {
  const eliminationsParVote = jour > 1 ? resolveVoteElimination(computeVoteTally(votesRaw)) : null;

  const joueursApresVote = joueursAvant.map((j) =>
    j.discordId === eliminationsParVote ? { ...j, alive: false, campReveleAt: jour } : j,
  );

  let deathIdCombat = null;
  let pvApres = Object.fromEntries(joueursApresVote.filter((j) => j.alive).map((j) => [j.discordId, j.pv]));

  if (jour > 1) {
    const occupants = computeTavernOccupants(actionsRaw);
    const protectedSet = computeTavernProtection(occupants, config.taverne_seuil_protection);
    const attacks = computeAttacksFromActions(actionsRaw, joueursApresVote, config);
    const damagePerTarget = sumDamagePerTarget(attacks, protectedSet);
    const pvBefore = Object.fromEntries(joueursApresVote.filter((j) => j.alive).map((j) => [j.discordId, j.pv]));
    const combatResult = resolveCombat(pvBefore, damagePerTarget, rng);
    pvApres = combatResult.pvAfter;
    deathIdCombat = combatResult.deathId;
  }

  const investigations = computeInvestigations(actionsRaw, joueursApresVote);
  const newPositions = computeNewPositions(actionsRaw, joueursApresVote);

  const joueursApres = joueursApresVote.map((j) => {
    if (!j.alive) return j;
    const pv = pvApres[j.discordId] ?? j.pv;
    const meurt = j.discordId === deathIdCombat;
    return {
      ...j,
      pv,
      alive: !meurt,
      campReveleAt: meurt ? jour : j.campReveleAt,
      position: newPositions[j.discordId] ?? j.position,
    };
  });

  const victory = checkVictory(joueursApres, jour, config.duree_jours);

  return {
    joueursApres,
    eliminationsParVote,
    deathIdCombat,
    investigations,
    voteTally: computeVoteTally(votesRaw),
    victory,
  };
}

// ── Wrappers I/O — appelés uniquement par postGoblinHunters()/cron ──

async function loadCloture(jour, config) {
  const [actionsRaw, votesRaw, state] = await Promise.all([readActions(jour), tallyVotesChateau(jour), readState()]);
  return computeCloture({ jour, actionsRaw, votesRaw, joueursAvant: state.joueurs, config, rng: Math.random });
}

// Lecture seule (aucune écriture Redis) — bouton preview + `--dry-run`.
export async function previewCloture(jour, config) {
  return loadCloture(jour, config);
}

// Écrit l'historique, avance l'état de partie, purge les actions/votes du
// jour. Appelée uniquement au cron réel.
export async function closeDayAndAdvance(jour, config) {
  const result = await loadCloture(jour, config);
  const state = await readState();

  await writeHistoriqueEntry(jour, {
    eliminationsParVote: result.eliminationsParVote,
    deathIdCombat: result.deathIdCombat,
    investigations: result.investigations,
    voteTally: result.voteTally,
    victory: result.victory,
    resolvedAt: new Date().toISOString(),
  });

  await writeState({ ...state, jour: jour + 1, joueurs: result.joueursApres });
  await clearActions(jour);
  await clearVotesChateau(jour);

  return result;
}

// Fige le roster, attribue camps/rôles, écrit l'état de départ (phase
// "jeu", jour 1). Les DM de distribution des rôles sont envoyés par le
// handler Discord (accès à l'API Discord), pas ici.
export async function launchGame(channelId, config) {
  const inscriptions = await listInscriptions();
  const playerIds = inscriptions.map((i) => i.discordId);
  const minorityCount = computeMinorityCount(playerIds.length, config.minority_table);
  const assignments = assignCampsAndRoles(playerIds, minorityCount);
  const joueurs = buildInitialRoster(inscriptions, assignments, {
    pv_base: config.combat.pv_base,
    bucheronOverride: { pv: config.roles.bucheron.pv },
  });

  await writeState({
    phase: "jeu",
    jour: 1,
    channelId,
    joueurs,
    publishedAt: new Date().toISOString(),
    termine: false,
  });
  await clearInscriptions();

  return { joueurs };
}

// ── Historique (bilans quotidiens) ────────────────────────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

export async function listHistorique({ limit = 10, offset = 0 } = {}) {
  const all = await hgetallJson(HISTORIQUE_KEY);
  const entries = Object.entries(all)
    .map(([jour, record]) => ({ jour: Number(jour), ...record }))
    .sort((a, b) => b.jour - a.jour);
  const hasMore = entries.length > offset + limit;
  return { entries: entries.slice(offset, offset + limit), hasMore };
}

// ── Manches (bilans de fin de partie) ────────────────────────────────
// Le jeu est destiné à être rejoué plusieurs fois. MANCHES_KEY est un HASH
// permanent indexé par un numéro de manche strictement croissant, jamais
// nettoyé par resetGoblinHunters() sauf reset explicite (--manches).

export async function archiveManche(record) {
  const manche = Number(await getRedis().incr(MANCHE_SEQ_KEY));
  await getRedis().hset(MANCHES_KEY, { [manche]: toJson({ manche, ...record }) });
  return manche;
}

export async function listManches({ limit = 10 } = {}) {
  const all = await hgetallJson(MANCHES_KEY);
  return Object.values(all)
    .sort((a, b) => b.manche - a.manche)
    .slice(0, limit);
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetGoblinHunters({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, INSCRIPTIONS_KEY, HISTORIQUE_KEY);
  await scanDelete("goblinhunters:actions:*");
  await scanDelete("goblinhunters:action_usernames:*");
  await scanDelete("goblinhunters:votes:*");
  await scanDelete("goblinhunters:vote_usernames:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
