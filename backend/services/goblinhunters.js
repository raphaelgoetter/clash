// ============================================================
// goblinhunters.js — Goblin Hunters, jeu à identité secrète/camps cachés
// (Villageois vs Gobelins infiltrés) façon Shadow Hunters/Loups-Garous,
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
const GOBLINHUNTERS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "goblinhunters",
);
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

const STATE_KEY = "goblinhunters:state";
const INSCRIPTIONS_KEY = "goblinhunters:inscriptions";
const HISTORIQUE_KEY = "goblinhunters:historique";
const INDICES_KEY = "goblinhunters:indices";
const MANCHES_KEY = "goblinhunters:manches";
const MANCHE_SEQ_KEY = "goblinhunters:manche_seq";
const MESSAGES_KEY = "goblinhunters:messages";

function actionsKey(jour) {
  return `goblinhunters:actions:${jour}`;
}
function actionUsernamesKey(jour) {
  return `goblinhunters:action_usernames:${jour}`;
}
function messagesSentKey(jour) {
  return `goblinhunters:messages_sent:${jour}`;
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
  return Object.entries(raw).map(([discordId, detail]) => ({
    discordId,
    ...detail,
  }));
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

// 1 exemplaire de chaque rôle spécial (Éclaireur/Bûcheron/Guet-Apens côté
// Villageois, Infiltré/Explosif côté Gobelins), quel que soit l'effectif —
// voir goblinhunters.json. Effectif mini 8 -> minorité mini 3 (table 8→3) et
// majorité mini 5 (8-3) : les 2 rôles Gobelins et les 3 rôles Villageois
// tiennent toujours, même à l'effectif plancher. Retourne
// [{discordId, camp, role}], role = null pour les joueurs de base.
export function assignCampsAndRoles(
  playerIds,
  minorityCount,
  rng = Math.random,
) {
  const shuffled = shuffle(playerIds, rng);
  const gobelins = shuffled.slice(0, minorityCount);
  const chasseurs = shuffled.slice(minorityCount);

  const assignments = new Map();
  for (const id of gobelins)
    assignments.set(id, { discordId: id, camp: "gobelin", role: null });
  for (const id of chasseurs)
    assignments.set(id, { discordId: id, camp: "chasseur", role: null });

  const gobelinsShuffled = shuffle(gobelins, rng);
  if (gobelinsShuffled[0])
    assignments.get(gobelinsShuffled[0]).role = "infiltre";
  if (gobelinsShuffled[1])
    assignments.get(gobelinsShuffled[1]).role = "explosif";

  const chasseursShuffled = shuffle(chasseurs, rng);
  if (chasseursShuffled[0])
    assignments.get(chasseursShuffled[0]).role = "eclaireur";
  if (chasseursShuffled[1])
    assignments.get(chasseursShuffled[1]).role = "bucheron";
  if (chasseursShuffled[2])
    assignments.get(chasseursShuffled[2]).role = "guet_apens";

  return [...assignments.values()];
}

export function buildInitialRoster(inscriptions, assignments, combatConfig) {
  const usernameById = new Map(
    inscriptions.map((i) => [i.discordId, i.username]),
  );
  return assignments.map(({ discordId, camp, role }) => {
    const roleConfig =
      role === "bucheron" ? combatConfig.bucheronOverride : null;
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
// clôture, dernier clic gagne — SAUF le vote du Château, rendu définitif dès
// validation par un garde côté handler (isActionLocked/handleLieuButton), pas
// ici : cette fonction reste volontairement "bête", elle écrit toujours ce
// qu'on lui donne. `slot` = "primary" ou "secondary" (2e action de
// l'Éclaireur uniquement) — le contrôle du rôle autorisant "secondary" se
// fait aussi côté handler Discord (accès à state.joueurs), pas ici.

export async function recordAction(
  jour,
  discordId,
  slot,
  { lieu, cibleId = null },
  username,
) {
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

// Lecture ciblée d'un seul joueur (évite de récupérer tout le hash du jour
// juste pour vérifier son propre choix courant, ex. dans isActionLocked côté
// handler).
export async function readPlayerAction(jour, discordId) {
  return fromJson(await getRedis().hget(actionsKey(jour), discordId));
}

// Action définitive : une fois un choix validé pour un slot donné (primary
// ou secondary), plus aucun changement possible sur ce slot pour le reste du
// jour — quel que soit le lieu, y compris si aucune cible n'a été trouvée
// (Arène/Tour de Guet sans candidat, cibleId: null quand même
// enregistré). Décidé avec l'utilisateur, en élargissant une première
// version qui ne verrouillait que le vote du Château — chaque action est un
// engagement, pas un brouillon qu'on peut retirer sans conséquence. Vérifié
// au clic dans le handler (handleLieuButton/handleTargetSelect), même esprit
// que isLieuRepeatAllowed — recordAction() lui-même reste "bête" (écrit
// toujours ce qu'on lui donne, sans jamais vérifier s'il écrase quelque
// chose), la garde vit entièrement côté appelant. Comme recordAction()
// n'écrit JAMAIS d'état "partiel" (le clic initial sur un lieu à cible ne
// persiste rien tant que la cible n'est pas choisie), la présence de
// `existingAction[slot]` suffit à elle seule à détecter un choix déjà
// finalisé — pas besoin de vérifier le lieu ni la cible comme avant.
export function isActionLocked(existingAction, slot) {
  return existingAction?.[slot] != null;
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

// ── Fonctions pures de résolution (aucun I/O, testées unitairement) ──

// Le vote du Château N'A PAS de stockage Redis séparé — voter est juste
// l'action du jour comme n'importe quel autre lieu, enregistrée dans le
// même hash `goblinhunters:actions:<jour>` via recordAction(). ⚠️ Correction
// d'un bug réel : une première version stockait le vote dans une clé
// distincte (`goblinhunters:votes:<jour>`), ce qui permettait de cumuler un
// vote ET une action normale le même jour (les deux stockages ne
// s'écrasaient jamais l'un l'autre) — en violation directe de la règle 1
// action/jour. En dérivant le vote de la même source que les autres
// actions, choisir un autre lieu écrase bien le vote de la veille et
// inversement. Primary regardé en priorité, secondary seulement pour
// l'Éclaireur si primary n'est pas un vote.
function extractVote(action) {
  if (action?.primary?.lieu === "chateau" && action.primary.cibleId)
    return action.primary.cibleId;
  if (action?.secondary?.lieu === "chateau" && action.secondary.cibleId)
    return action.secondary.cibleId;
  return null;
}

export function computeVoteTally(actionsRaw) {
  const counts = {};
  for (const action of Object.values(actionsRaw)) {
    const cibleId = extractVote(action);
    if (!cibleId) continue;
    counts[cibleId] = (counts[cibleId] || 0) + 1;
  }
  return counts;
}

// Quorum minimum (2 votants par défaut, config.vote_quorum_min) : sans ça,
// un seul joueur qui se rend seul au Château peut exécuter n'importe qui
// unilatéralement (son unique vote est mécaniquement "le score maximum").
// Bug repéré en revue avec l'utilisateur, jamais volontaire. Égalité entre
// plusieurs cibles au score maximum -> personne n'est éliminé (décision
// actée avec l'utilisateur, contrairement au tirage au sort utilisé pour
// départager une égalité en combat).
export function resolveVoteElimination(voteTally, quorumMin = 2) {
  const entries = Object.entries(voteTally);
  if (!entries.length) return null;
  const totalVotes = entries.reduce((sum, [, c]) => sum + c, 0);
  if (totalVotes < quorumMin) return null;
  const maxCount = Math.max(...entries.map(([, c]) => c));
  const top = entries.filter(([, c]) => c === maxCount);
  return top.length === 1 ? top[0][0] : null;
}

// Joueurs ayant choisi la Taverne aujourd'hui (protection potentielle) —
// distingue primary/secondary pour couvrir le cas Éclaireur.
export function computeTavernOccupants(actionsRaw) {
  const occupants = new Set();
  for (const [discordId, action] of Object.entries(actionsRaw)) {
    if (
      action?.primary?.lieu === "taverne" ||
      action?.secondary?.lieu === "taverne"
    ) {
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
// computeCloture).
function resolveEligibleAttacks(actionsRaw, joueursAvant, lieuxCombat) {
  const positionById = new Map(
    joueursAvant.map((j) => [j.discordId, j.position]),
  );
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
// l'attaquant, pas de la cible). L'Arène est le SEUL lieu de
// combat — la Clairière ne fait plus partie du combat depuis sa
// refonte en révélation de position (voir computeClairiereReveals), décidée
// avec l'utilisateur pour lui donner une identité propre plutôt qu'une
// simple variante de l'Arène sans vraie contrepartie.
// Filet de sécurité (Arène/Tour de Guet) : si un joueur a
// choisi ce lieu mais n'a résolu aucune interaction (personne d'éligible
// n'était là hier, ou sa cible a été éliminée par le vote à la même
// clôture), il agit quand même sur un joueur vivant tiré au hasard plutôt
// que de perdre son action pour rien. Décidé avec l'utilisateur : sans ce
// filet, personne n'a jamais intérêt à être le premier à visiter ces lieux
// (s'exposer sans aucune contrepartie tant que personne d'autre n'y est
// jamais allé avant) — ces deux lieux pouvaient donc rester morts toute la
// partie si tout le monde jouait "rationnellement" (3 lieux sûrs suffisent
// à alterner indéfiniment sans jamais s'y risquer).
function fallbackActorsFor(actionsRaw, lieu, joueursAvant, resolvedActorIds) {
  const aliveById = new Map(joueursAvant.map((j) => [j.discordId, j.alive]));
  const actors = [];
  for (const [discordId, action] of Object.entries(actionsRaw)) {
    if (resolvedActorIds.has(discordId) || !aliveById.get(discordId)) continue;
    if (action?.primary?.lieu === lieu || action?.secondary?.lieu === lieu)
      actors.push(discordId);
  }
  return actors;
}

function pickRandomTarget(joueursAvant, excludeId, rng) {
  const candidates = joueursAvant.filter(
    (j) => j.alive && j.discordId !== excludeId,
  );
  return candidates.length ? shuffle(candidates, rng)[0] : null;
}

export function computeAttacksFromActions(
  actionsRaw,
  joueursAvant,
  config,
  rng = Math.random,
) {
  const roleById = new Map(joueursAvant.map((j) => [j.discordId, j.role]));
  const attacks = resolveEligibleAttacks(actionsRaw, joueursAvant, [
    "camp_entrainement",
  ]);

  const resolvedIds = new Set(attacks.map((a) => a.attackerId));
  for (const attackerId of fallbackActorsFor(
    actionsRaw,
    "camp_entrainement",
    joueursAvant,
    resolvedIds,
  )) {
    const target = pickRandomTarget(joueursAvant, attackerId, rng);
    if (target)
      attacks.push({
        attackerId,
        targetId: target.discordId,
        lieu: "camp_entrainement",
      });
  }

  return attacks.map((a) => ({
    ...a,
    degats:
      roleById.get(a.attackerId) === "bucheron"
        ? config.roles.bucheron.degats
        : config.combat.degats_base,
  }));
}

// Clairière : révèle la position COURANTE de 2 joueurs vivants
// tirés au hasard (jamais soi-même) — aucune cible à choisir, aucune
// restriction de co-location (ce n'est pas une confrontation). Décidé avec
// l'utilisateur : donne à ce lieu une utilité propre (renseignement) plutôt
// qu'une attaque redondante avec l'Arène.
export function computeClairiereReveals(
  actionsRaw,
  joueursApres,
  rng = Math.random,
) {
  const aliveById = new Map(joueursApres.map((j) => [j.discordId, j.alive]));
  const aliveOthers = (excludeId) =>
    joueursApres.filter((j) => j.alive && j.discordId !== excludeId);
  const revealsByPlayer = {};
  for (const [discordId, action] of Object.entries(actionsRaw)) {
    if (!aliveById.get(discordId)) continue; // éliminé ce même jour (vote/combat) -> pas de vision
    const visite =
      action?.primary?.lieu === "clairiere_mystique" ||
      action?.secondary?.lieu === "clairiere_mystique";
    if (!visite) continue;
    const picks = shuffle(aliveOthers(discordId), rng).slice(0, 2);
    revealsByPlayer[discordId] = picks.map((j) => ({
      cibleId: j.discordId,
      cibleUsername: j.username,
      lieu: j.position,
    }));
  }
  return revealsByPlayer;
}

export function sumDamagePerTarget(attacks, protectedSet) {
  const totals = {};
  for (const a of attacks) {
    if (protectedSet.has(a.targetId)) continue; // protégé par la Taverne, attaque bloquée
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

  const maxDamage = Math.max(
    ...candidates.map(([id]) => damagePerTarget[id] || 0),
  );
  const topCandidates = candidates.filter(
    ([id]) => (damagePerTarget[id] || 0) === maxDamage,
  );
  const [deathId] =
    topCandidates.length === 1
      ? topCandidates[0]
      : topCandidates[Math.floor(rng() * topCandidates.length)];

  const pvAfter = { ...rawPvAfter };
  for (const [id] of candidates) {
    pvAfter[id] = id === deathId ? rawPvAfter[id] : 1;
  }
  return { pvAfter, deathId };
}

// Enquête (Tour de Guet) : révèle le camp de la cible, sauf sur l'Infiltré
// qui renvoie toujours "chasseur" (faux positif classique du genre).
export function computeInvestigations(
  actionsRaw,
  joueursAvant,
  rng = Math.random,
) {
  const joueurById = new Map(joueursAvant.map((j) => [j.discordId, j]));
  const attacks = resolveEligibleAttacks(actionsRaw, joueursAvant, [
    "tour_de_guet",
  ]);
  const results = attacks.map(({ attackerId, targetId }) => {
    const cible = joueurById.get(targetId);
    const campReporte = cible.role === "infiltre" ? "chasseur" : cible.camp;
    return { investigatorId: attackerId, cibleId: targetId, campReporte };
  });

  // Même filet de sécurité que le combat (voir fallbackActorsFor) : une
  // enquête sans cible éligible se rabat sur un joueur vivant au hasard.
  const resolvedIds = new Set(results.map((r) => r.investigatorId));
  for (const investigatorId of fallbackActorsFor(
    actionsRaw,
    "tour_de_guet",
    joueursAvant,
    resolvedIds,
  )) {
    const target = pickRandomTarget(joueursAvant, investigatorId, rng);
    if (!target) continue;
    const campReporte = target.role === "infiltre" ? "chasseur" : target.camp;
    results.push({ investigatorId, cibleId: target.discordId, campReporte });
  }

  return results;
}

// Indices personnels accumulés par joueur sur toute la partie (carnet privé,
// affiché uniquement au joueur concerné via le bouton Journal). Le plateau
// public ne montre que les positions COURANTES (regénéré à chaque clôture,
// aucun historique) — sans ce carnet, un joueur perdrait toute trace de ses
// rencontres passées dès le lendemain. Deux sources par jour : les enquêtes
// (résultat de camp, `campReporte` non nul) et les rencontres de
// combat/sabotage (lieu seulement, jamais de camp — une attaque ne révèle
// rien sur le camp de la cible).
// `type` distingue les 3 sources d'indices, formatées différemment côté
// handler (voir formatIndiceLine) :
// - "enquete" : camp révélé (Tour de Guet), `lieu` = "tour_de_guet" (là où
//   l'enquête a eu lieu).
// - "combat" : aucun camp révélé, `lieu` = "camp_entrainement" (là où
//   l'affrontement a eu lieu).
// - "reveal" : aucun camp révélé, `lieu` = la position COURANTE de la
//   cible (pas le lieu de l'interaction — la Clairière n'implique aucune
//   co-location, voir computeClairiereReveals).
// `attacks` doit venir du MÊME appel que celui qui a servi à la résolution
// des PV (result.attacks de computeCloture) — ne jamais le recalculer
// séparément ici : computeAttacksFromActions pioche désormais une cible au
// hasard (filet de sécurité, voir fallbackActorsFor) via `rng`, un second
// calcul indépendant tirerait potentiellement une cible DIFFÉRENTE de celle
// réellement appliquée en combat, désynchronisant le carnet d'indices de ce
// qui s'est vraiment passé.
export function computeIndicesForDay(
  jour,
  attacks,
  investigations,
  clairiereReveals,
  joueursAvant,
) {
  const usernameById = new Map(
    joueursAvant.map((j) => [j.discordId, j.username]),
  );
  const indicesByPlayer = {};
  const push = (discordId, entry) => {
    (indicesByPlayer[discordId] ??= []).push({ jour, ...entry });
  };

  for (const inv of investigations) {
    push(inv.investigatorId, {
      type: "enquete",
      cibleId: inv.cibleId,
      cibleUsername: usernameById.get(inv.cibleId) || "?",
      lieu: "tour_de_guet",
      campReporte: inv.campReporte,
    });
  }

  for (const a of attacks) {
    push(a.attackerId, {
      type: "combat",
      cibleId: a.targetId,
      cibleUsername: usernameById.get(a.targetId) || "?",
      lieu: a.lieu,
      campReporte: null,
    });
  }

  for (const [discordId, reveals] of Object.entries(clairiereReveals)) {
    for (const r of reveals) {
      push(discordId, {
        type: "reveal",
        cibleId: r.cibleId,
        cibleUsername: r.cibleUsername,
        lieu: r.lieu,
        campReporte: null,
      });
    }
  }

  return indicesByPlayer;
}

// Riposte du Gobelin explosif : à sa mort (vote OU combat), inflige
// `config.roles.explosif.degats_riposte` (1 par défaut) à un Villageois —
// jamais mortelle (clampée à 1 PV minimum). Décidé explicitement avec
// l'utilisateur : contrairement au plafond anti-snowball du combat classique
// (1 mort max/jour, départagé par rng si plusieurs cibles seraient
// mortelles), la riposte ne doit JAMAIS pouvoir causer une 2e mort le même
// jour, quel que soit l'état de PV de la cible avant riposte (ex. déjà
// plafonnée à 1 PV par le combat normal ce même jour) — plus simple à
// raisonner qu'une intégration dans le plafond de resolveCombat(), et
// suffisant puisque la riposte n'est de toute façon jamais injectée dans
// `damagePerTarget`/resolveCombat(), elle s'applique en aval, sur le pv déjà
// résolu. Cible : l'attaquant qui l'a achevé au combat (uniquement si
// Villageois — pas de riposte sur un tir ami Gobelin via le filet de
// sécurité), sinon un votant Villageois tiré au hasard s'il est éliminé au
// vote (pas d'attaquant unique dans ce cas). `attacks` doit venir du même
// appel que la résolution des PV (même avertissement que pour
// computeIndicesForDay : ne jamais recalculer computeAttacksFromActions()
// séparément).
export function resolveExplosifRetaliation({
  eliminationsParVote,
  deathIdCombat,
  actionsRaw,
  attacks,
  joueursAvant,
  rng = Math.random,
}) {
  const byId = new Map(joueursAvant.map((j) => [j.discordId, j]));
  let gobelinId = null;
  let candidates = [];

  const votedOut = eliminationsParVote ? byId.get(eliminationsParVote) : null;
  if (votedOut?.role === "explosif") {
    gobelinId = votedOut.discordId;
    candidates = Object.entries(actionsRaw)
      .filter(
        ([voterId, action]) =>
          extractVote(action) === gobelinId &&
          byId.get(voterId)?.camp === "chasseur",
      )
      .map(([voterId]) => voterId);
  }

  const combatDead = deathIdCombat ? byId.get(deathIdCombat) : null;
  if (combatDead?.role === "explosif") {
    gobelinId = combatDead.discordId;
    candidates = [
      ...new Set(
        attacks
          .filter(
            (a) =>
              a.targetId === gobelinId &&
              byId.get(a.attackerId)?.camp === "chasseur",
          )
          .map((a) => a.attackerId),
      ),
    ];
  }

  if (!gobelinId || !candidates.length) return null;
  const targetId = candidates[Math.floor(rng() * candidates.length)];
  return { gobelinId, targetId };
}

// Révélation du Guet-Apens : mort au combat -> révèle le camp du/des
// attaquant(s) qui l'ont achevé (plusieurs possibles si ciblé par plusieurs
// attaques le même jour, cf. sumDamagePerTarget). Ne se déclenche qu'au
// combat, jamais au vote (pas d'attaquant identifiable dans un vote
// collectif). `attacks` = même contrainte que resolveExplosifRetaliation
// ci-dessus (résultat du même appel que la résolution des PV).
export function resolveGuetApensReveal({
  deathIdCombat,
  attacks,
  joueursAvant,
}) {
  const byId = new Map(joueursAvant.map((j) => [j.discordId, j]));
  const dead = deathIdCombat ? byId.get(deathIdCombat) : null;
  if (dead?.role !== "guet_apens") return null;
  const attackerIds = [
    ...new Set(
      attacks
        .filter((a) => a.targetId === deathIdCombat)
        .map((a) => a.attackerId),
    ),
  ];
  if (!attackerIds.length) return null;
  return {
    guetApensId: deathIdCombat,
    attackers: attackerIds.map((id) => ({
      attackerId: id,
      campReporte: byId.get(id)?.camp,
    })),
  };
}

// Nouvelle position affichée pour chaque joueur vivant : le lieu de sa
// dernière action soumise (secondary si Éclaireur ayant joué 2 fois),
// retombe au Château par défaut (pass automatique, décidé avec l'utilisateur).
export function computeNewPositions(
  actionsRaw,
  joueursAvant,
  defaultLieu = "chateau",
) {
  const positions = {};
  for (const j of joueursAvant) {
    if (!j.alive) continue;
    const action = actionsRaw[j.discordId];
    positions[j.discordId] =
      action?.secondary?.lieu || action?.primary?.lieu || defaultLieu;
  }
  return positions;
}

export function checkVictory(joueursApres, jourCourant, dureeJours) {
  const vivants = joueursApres.filter((j) => j.alive);
  const gobelinsVivants = vivants.filter((j) => j.camp === "gobelin").length;
  const chasseursVivants = vivants.filter((j) => j.camp === "chasseur").length;

  if (gobelinsVivants > 0 && gobelinsVivants >= chasseursVivants)
    return "gobelins_parite";
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

export function computeCloture({
  jour,
  actionsRaw,
  joueursAvant,
  config,
  rng = Math.random,
}) {
  const voteTally = computeVoteTally(actionsRaw);
  const eliminationsParVote =
    jour > 1 ? resolveVoteElimination(voteTally, config.vote_quorum_min) : null;

  const joueursApresVote = joueursAvant.map((j) =>
    j.discordId === eliminationsParVote
      ? { ...j, alive: false, campReveleAt: jour }
      : j,
  );

  let deathIdCombat = null;
  let attacks = [];
  let pvApres = Object.fromEntries(
    joueursApresVote.filter((j) => j.alive).map((j) => [j.discordId, j.pv]),
  );

  if (jour > 1) {
    const occupants = computeTavernOccupants(actionsRaw);
    const protectedSet = computeTavernProtection(
      occupants,
      config.taverne_seuil_protection,
    );
    attacks = computeAttacksFromActions(
      actionsRaw,
      joueursApresVote,
      config,
      rng,
    );
    const damagePerTarget = sumDamagePerTarget(attacks, protectedSet);
    const pvBefore = Object.fromEntries(
      joueursApresVote.filter((j) => j.alive).map((j) => [j.discordId, j.pv]),
    );
    const combatResult = resolveCombat(pvBefore, damagePerTarget, rng);
    pvApres = combatResult.pvAfter;
    deathIdCombat = combatResult.deathId;
  }

  const explosifRetaliation =
    jour > 1
      ? resolveExplosifRetaliation({
          eliminationsParVote,
          deathIdCombat,
          actionsRaw,
          attacks,
          joueursAvant,
          rng,
        })
      : null;
  const guetApensReveal =
    jour > 1
      ? resolveGuetApensReveal({ deathIdCombat, attacks, joueursAvant })
      : null;

  const investigations = computeInvestigations(
    actionsRaw,
    joueursApresVote,
    rng,
  );
  const newPositions = computeNewPositions(actionsRaw, joueursApresVote);

  const joueursApres = joueursApresVote.map((j) => {
    if (!j.alive) return j;
    let pv = pvApres[j.discordId] ?? j.pv;
    if (explosifRetaliation?.targetId === j.discordId) {
      pv = Math.max(pv - config.roles.explosif.degats_riposte, 1);
    }
    const meurt = j.discordId === deathIdCombat;
    return {
      ...j,
      pv,
      alive: !meurt,
      campReveleAt: meurt ? jour : j.campReveleAt,
      position: newPositions[j.discordId] ?? j.position,
    };
  });

  // Calculée sur joueursApres (positions FINALES de ce jour, éliminations du
  // jour déjà appliquées) : révèle où les cibles ont fini la journée, pas où
  // elles étaient avant — un joueur éliminé le jour même (vote ou combat)
  // n'est ni éligible comme cible, ni comme voyant (aliveById filtre les deux).
  const clairiereReveals = computeClairiereReveals(
    actionsRaw,
    joueursApres,
    rng,
  );

  const victory = checkVictory(joueursApres, jour, config.duree_jours);

  return {
    joueursApres,
    eliminationsParVote,
    deathIdCombat,
    attacks,
    investigations,
    clairiereReveals,
    voteTally,
    explosifRetaliation,
    guetApensReveal,
    victory,
  };
}

// ── Indices personnels (carnet privé, HASH permanent sur toute la manche) ──

export async function appendIndices(indicesByPlayer) {
  for (const [discordId, entries] of Object.entries(indicesByPlayer)) {
    const existing =
      fromJson(await getRedis().hget(INDICES_KEY, discordId)) || [];
    await getRedis().hset(INDICES_KEY, {
      [discordId]: toJson([...existing, ...entries]),
    });
  }
}

export async function readPlayerIndices(discordId) {
  return fromJson(await getRedis().hget(INDICES_KEY, discordId)) || [];
}

// ── Messagerie anonyme (bouton "Messagerie", 1 message/jour/joueur) ────────
// Live, pas résolue à la clôture (contrairement au reste du jeu) : un simple
// LIST Redis borné aux 3 derniers messages (RPUSH + LTRIM), jamais associé au
// discordId de l'auteur dans le contenu stocké — l'anonymat est structurel,
// pas juste un masquage à l'affichage. Le quota quotidien (1/jour/joueur) vit
// dans un HASH séparé par jour (`messagesSentKey`), jamais dans le contenu du
// message lui-même, pour ne jamais pouvoir fuiter "qui a écrit quoi" même en
// lisant le contenu brut de MESSAGES_KEY.

export async function hasSentMessageToday(jour, discordId) {
  return !!(await getRedis().hget(messagesSentKey(jour), discordId));
}

// Check-then-act non atomique (même niveau de rigueur que registerPlayer()
// ci-dessus pour ce type d'action à faible enjeu) : un double-clic strictement
// simultané pourrait en théorie laisser passer 2 messages le même jour, accepté.
export async function recordMessage(jour, discordId, content) {
  const already = await hasSentMessageToday(jour, discordId);
  if (already) return { status: "already_sent" };
  await getRedis().rpush(MESSAGES_KEY, toJson({ content, jour }));
  await getRedis().ltrim(MESSAGES_KEY, -3, -1);
  await getRedis().hset(messagesSentKey(jour), { [discordId]: "1" });
  return { status: "sent" };
}

// RPUSH + LTRIM garantit au plus 3 entrées, LRANGE 0 -1 les renvoie donc déjà
// dans l'ordre chronologique (plus ancien -> plus récent), même convention
// de lecture que le carnet d'indices du Journal.
export async function listRecentMessages() {
  const raw = (await getRedis().lrange(MESSAGES_KEY, 0, -1)) || [];
  return raw.map(fromJson).filter(Boolean);
}

// ── Wrappers I/O — appelés uniquement par postGoblinHunters()/cron ──

async function loadCloture(jour, config) {
  const [actionsRaw, state] = await Promise.all([
    readActions(jour),
    readState(),
  ]);
  return computeCloture({
    jour,
    actionsRaw,
    joueursAvant: state.joueurs,
    config,
    rng: Math.random,
  });
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
    explosifRetaliation: result.explosifRetaliation,
    guetApensReveal: result.guetApensReveal,
    victory: result.victory,
    resolvedAt: new Date().toISOString(),
  });

  // Indices personnels : réutilise result.attacks/investigations TELS QUELS
  // (mêmes objets que ceux qui ont résolu les PV/enquêtes de cette clôture,
  // jamais recalculés séparément — voir l'avertissement sur
  // computeIndicesForDay). state.joueurs = joueursAvant (pseudos d'avant
  // élimination), jamais result.joueursApres.
  const indicesByPlayer = computeIndicesForDay(
    jour,
    result.attacks,
    result.investigations,
    result.clairiereReveals,
    state.joueurs,
  );
  await appendIndices(indicesByPlayer);

  await writeState({ ...state, jour: jour + 1, joueurs: result.joueursApres });
  await clearActions(jour);

  return result;
}

// Fige le roster, attribue camps/rôles, écrit l'état de départ (phase
// "jeu", jour 1). Les DM de distribution des rôles sont envoyés par le
// handler Discord (accès à l'API Discord), pas ici.
export async function launchGame(channelId, config) {
  const inscriptions = await listInscriptions();
  const playerIds = inscriptions.map((i) => i.discordId);
  const minorityCount = computeMinorityCount(
    playerIds.length,
    config.minority_table,
  );
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
  await getRedis().hset(MANCHES_KEY, {
    [manche]: toJson({ manche, ...record }),
  });
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
  await getRedis().del(
    STATE_KEY,
    INSCRIPTIONS_KEY,
    HISTORIQUE_KEY,
    INDICES_KEY,
    MESSAGES_KEY,
  );
  await scanDelete("goblinhunters:actions:*");
  await scanDelete("goblinhunters:action_usernames:*");
  await scanDelete("goblinhunters:messages_sent:*");
  // Clés d'une version antérieure du vote Château (stockage séparé, retiré
  // suite à un bug — voir computeVoteTally) : filet de sécurité pour purger
  // d'éventuelles clés résiduelles d'avant la correction, plus jamais écrites.
  await scanDelete("goblinhunters:votes:*");
  await scanDelete("goblinhunters:vote_usernames:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
