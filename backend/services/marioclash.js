// ============================================================
// marioclash.js — Mario Clash, course communautaire façon Mario Kart sur
// plateau à 49 cases (thème Clash Royale). Couche métier : config statique,
// état de la partie (phase/jour/joueurs), actions quotidiennes, clôture,
// historique, manches.
//
// Stockage : Upstash Redis (mêmes conventions que bossraid.js/robinson.js)
// — espace de clés `marioclash:*`.
//
// ⚠️ Modèle de référence = Boss Raid, pas Robinson, pour l'objet et le
// sort : ce sont de simples CHOIX enregistrés pendant la journée
// (`marioclash:actions:<jour>`, HSET écrasable) — aucun tirage aléatoire au
// clic. Ils se résolvent UNE SEULE FOIS à la clôture, dans
// `computeCloture()`, une fonction pure (aucun I/O, `rng` injectable pour
// des tests déterministes — convention `rollXxx(..., rng = Math.random)` de
// robinson.js). Raison : ils peuvent cibler un AUTRE joueur, et l'ordre par
// rapport à l'immunité Étoile du jour doit être déterministe.
//
// ⚠️ Ordre de résolution à la clôture (décision explicite, voir
// CONTRIBUTING.md) : 1) objets déjà actifs (Étoile → immunité du jour)
// 2) objets appliqués (Accélérateur/Bombe/Banane) 3) sorts. L'Étoile
// protège ainsi contre TOUT le reste de la journée (objets ET sorts
// d'autrui, y compris un sort qu'on se lancerait à soi-même).
//
// ⚠️ Le dé et la boutique sont résolus EN DIRECT au clic, PAS à la
// clôture (voir rollDiceForPlayer()/purchaseItem()) : ce sont des actions
// individuelles, sans aucune interaction avec les autres joueurs ni
// dépendance à l'immunité Étoile — même principe que la Pilule du
// Tamagoshi (ressource individuelle, effet immédiat, capée).
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "marioclash", "marioclash.json");

const STATE_KEY = "marioclash:state";
const JOUEURS_KEY = "marioclash:joueurs";
const HISTORIQUE_KEY = "marioclash:historique";
const MANCHES_KEY = "marioclash:manches";
const MANCHE_SEQ_KEY = "marioclash:manche_seq";
const actionsKey = (jour) => `marioclash:actions:${jour}`;

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
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}

async function hgetallJson(key) {
  const raw = pairsToObject((await getRedis().hgetall(key)) || []);
  const result = {};
  for (const [field, value] of Object.entries(raw)) result[field] = fromJson(value);
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

// ── Config statique ────────────────────────────────────────────────

let _configCache = null;

export async function loadMarioClashConfig() {
  if (_configCache) return _configCache;
  const raw = await fs.readFile(CONFIG_JSON_PATH, "utf8");
  _configCache = JSON.parse(raw);
  return _configCache;
}

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Joueurs (position, points boutique, objet détenu) ──────────────
// HASH discordId → JSON { username, position, points, objet }. Pas
// d'inscription préalable (participation libre, comme Robinson/Tamagoshi/
// Boss Raid) : un joueur est créé au tout premier clic via ensureJoueur().

export async function readJoueurs() {
  return hgetallJson(JOUEURS_KEY);
}

export async function readJoueur(discordId) {
  return fromJson(await getRedis().hget(JOUEURS_KEY, discordId));
}

export async function writeJoueur(discordId, joueur) {
  await getRedis().hset(JOUEURS_KEY, { [discordId]: toJson(joueur) });
}

export async function ensureJoueur(discordId, username) {
  const existing = await readJoueur(discordId);
  if (existing) {
    if (username && existing.username !== username) {
      const updated = { ...existing, username };
      await writeJoueur(discordId, updated);
      return updated;
    }
    return existing;
  }
  const fresh = { username: username || "?", position: 0, points: 0, objet: null, dernierAchatJour: null };
  await writeJoueur(discordId, fresh);
  return fresh;
}

// ── Boutique — résolution immédiate au clic ─────────────────────────
// Pas de clôture différée : achat individuel, sans interaction avec
// d'autres joueurs (contrairement au dé/objet/sort, voir en-tête).

export async function purchaseItem(discordId, username, itemId, jour, config) {
  const item = config.objets[itemId];
  if (!item) return { status: "unknownItem" };
  const joueur = await ensureJoueur(discordId, username);
  if (joueur.objet) return { status: "alreadyHasItem", joueur };
  // "On ne peut acheter qu'un objet par jour" — distinct du cap "un seul
  // objet à la fois" ci-dessus : même si l'objet du jour a déjà été utilisé
  // (et donc consommé) le même jour, un second achat reste refusé.
  if (joueur.dernierAchatJour === jour) return { status: "alreadyPurchasedToday", joueur };
  if (joueur.points < item.cout) return { status: "insufficientPoints", joueur };
  const updated = { ...joueur, points: joueur.points - item.cout, objet: itemId, dernierAchatJour: jour };
  await writeJoueur(discordId, updated);
  return { status: "ok", joueur: updated };
}

// ── Actions quotidiennes (dé / objet / sort) ────────────────────────
// HASH discordId → JSON { dice, item: {target}|null, spell: {target}|null }.
// Écrasable par champ (lecture-fusion-écriture), modifiable jusqu'au cron —
// même esprit que bossraid.js (aucune notion de slot réservé).

async function updateAction(jour, discordId, patch) {
  const raw = await getRedis().hget(actionsKey(jour), discordId);
  const current = fromJson(raw) || {};
  const updated = { ...current, ...patch };
  await getRedis().hset(actionsKey(jour), { [discordId]: toJson(updated) });
  return updated;
}

export async function recordItemUse(jour, discordId, target = null) {
  return updateAction(jour, discordId, { item: { target } });
}

export async function readActions(jour) {
  return hgetallJson(actionsKey(jour));
}

async function clearActions(jour) {
  await getRedis().del(actionsKey(jour));
}

// ── Résolution quotidienne (fonction pure) ──────────────────────────

export function rollDice(rng = Math.random) {
  return Math.floor(rng() * 6) + 1;
}

export function rollSort(sorts, rng = Math.random) {
  const id = Math.floor(rng() * sorts.length) + 1;
  return sorts.find((s) => s.id === id) || sorts[0];
}

export function clampPosition(position, caseArrivee) {
  return Math.max(0, Math.min(caseArrivee, position));
}

// ── Dé — résolu EN DIRECT au clic, pas à la clôture ──────────────────
// Contrairement à l'objet/au sort (qui peuvent cibler un adversaire et
// dépendent de l'immunité Étoile calculée à la clôture), le dé n'affecte
// jamais que son propre lanceur : aucune interaction avec les autres
// joueurs, donc aucune raison d'en différer la résolution. Même principe
// que la boutique (action individuelle, effet immédiat).
export async function rollDiceForPlayer(jour, discordId, config, rng = Math.random) {
  const actions = await readActions(jour);
  if (actions[discordId]?.dice) return { status: "alreadyRolled" };
  const joueur = await readJoueur(discordId);
  if (!joueur) return { status: "unknownPlayer" };
  const valeur = rollDice(rng);
  const position = clampPosition(joueur.position + valeur, config.case_arrivee);
  await writeJoueur(discordId, { ...joueur, position });
  await updateAction(jour, discordId, { dice: true, diceValue: valeur });
  return { status: "ok", valeur, positionAvant: joueur.position, position };
}

// ── Sort — cible ET effet tirés au sort DÈS LE CLIC, annoncés
// immédiatement ; seule l'APPLICATION (déplacement, blocage éventuel par
// l'Étoile d'un joueur devenu immunisé plus tard le même jour) reste
// différée à la clôture, dans l'ordre de résolution documenté en tête de
// fichier. Aucun choix du joueur : ni la cible (soi-même ou un adversaire,
// 50/50), ni l'effet (1 à 6, voir data/marioclash/marioclash.json) —
// "totalement aléatoire", décision explicite.
export async function castSpellForPlayer(jour, discordId, config, rng = Math.random) {
  const actions = await readActions(jour);
  if (actions[discordId]?.spell) return { status: "alreadyCast" };
  const joueurs = await readJoueurs();
  if (!joueurs[discordId]) return { status: "unknownPlayer" };
  const autres = Object.keys(joueurs).filter((id) => id !== discordId);
  const target = autres.length && rng() < 0.5 ? autres[Math.floor(rng() * autres.length)] : discordId;
  const sort = rollSort(config.sorts, rng);
  await updateAction(jour, discordId, { spell: { target, sortId: sort.id } });
  return { status: "ok", target, sort };
}

// `actionsRaw`/`joueursAvant` : objets { discordId: {...} }, déjà
// désérialisés (aucun I/O ici). Retourne { joueursApres, lignes,
// immunises } — `lignes` est une liste de faits bruts (pas de texte
// narratif, voir handler pour la mise en forme Discord).
export function computeCloture({ actionsRaw, joueursAvant, config, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j };
  const lignes = [];

  // 1) Objets déjà actifs ce jour → immunité (Étoile).
  const immunises = new Set();
  for (const [id, action] of Object.entries(actionsRaw)) {
    const joueur = joueurs[id];
    if (!joueur || !action.item || !joueur.objet) continue;
    if (config.objets[joueur.objet]?.invincible) immunises.add(id);
  }

  // 2) Objets appliqués (hors Étoile, déjà traitée ci-dessus).
  for (const [id, action] of Object.entries(actionsRaw)) {
    const joueur = joueurs[id];
    if (!joueur || !action.item || !joueur.objet) continue;
    const itemId = joueur.objet;
    const item = config.objets[itemId];
    if (!item || item.invincible) {
      if (item?.invincible) joueur.objet = null; // Étoile consommée telle quelle
      continue;
    }
    if (item.cible === "soi") {
      if (item.avance) {
        joueur.position = clampPosition(joueur.position + item.avance, config.case_arrivee);
        lignes.push({ type: "objet", discordId: id, itemId, effet: "avance", valeur: item.avance });
      }
      joueur.objet = null;
      continue;
    }
    // cible === "adversaire"
    const targetId = action.item.target;
    const cible = targetId ? joueurs[targetId] : null;
    if (!cible) { joueur.objet = null; continue; }
    if (immunises.has(targetId)) {
      lignes.push({ type: "objet", discordId: id, itemId, effet: "bloque", cibleId: targetId });
      joueur.objet = null;
      continue;
    }
    if (item.recul) {
      cible.position = clampPosition(cible.position - item.recul, config.case_arrivee);
      lignes.push({ type: "objet", discordId: id, itemId, effet: "recul", cibleId: targetId, valeur: item.recul });
    } else if (item.echange) {
      const posJoueur = joueur.position;
      joueur.position = cible.position;
      cible.position = posJoueur;
      lignes.push({ type: "objet", discordId: id, itemId, effet: "echange", cibleId: targetId });
    }
    joueur.objet = null;
  }

  // 3) Sorts — cible et effet déjà tirés au clic (castSpellForPlayer), on
  // se contente ici de les APPLIQUER (ou de les bloquer si la cible est
  // devenue immunisée entre-temps) : jamais un second tirage.
  for (const [id, action] of Object.entries(actionsRaw)) {
    const joueur = joueurs[id];
    if (!joueur || !action.spell) continue;
    const targetId = action.spell.target || id;
    const cible = joueurs[targetId];
    if (!cible) continue;
    if (immunises.has(targetId)) {
      lignes.push({ type: "sort", discordId: id, effet: "bloque", cibleId: targetId });
      continue;
    }
    const sort = config.sorts.find((s) => s.id === action.spell.sortId) || rollSort(config.sorts, rng);
    if (sort.avance) {
      cible.position = clampPosition(cible.position + sort.avance, config.case_arrivee);
    }
    if (sort.perdObjet && cible.objet) {
      cible.objet = null;
    }
    if (sort.pointsBoutique) {
      cible.points += sort.pointsBoutique;
    }
    if (sort.echangeAleatoire) {
      const autres = Object.keys(joueurs).filter((otherId) => otherId !== targetId);
      if (autres.length) {
        const other = autres[Math.floor(rng() * autres.length)];
        const posCible = cible.position;
        cible.position = joueurs[other].position;
        joueurs[other].position = posCible;
      }
    }
    lignes.push({ type: "sort", discordId: id, cibleId: targetId, sortId: sort.id, sortLabel: sort.label });
  }
  // Le dé n'est plus résolu ici : action individuelle sans interaction avec
  // les autres joueurs, elle est résolue EN DIRECT au clic (voir
  // rollDiceForPlayer()) — même principe que la boutique.

  return { joueursApres: joueurs, lignes, immunises: [...immunises] };
}

// Octroie le point boutique quotidien à tous les joueurs déjà connus,
// AVANT l'ouverture des actions du nouveau jour (voir "en début de
// journée" dans le brief). Fonction pure, réutilisée par closeDayAndAdvance()
// ET previewCloture() pour que le dry-run affiche exactement le même état
// "jour suivant" qu'une vraie clôture.
export function grantDailyShopPoints(joueurs, config) {
  const updated = {};
  for (const [id, j] of Object.entries(joueurs)) {
    updated[id] = { ...j, points: j.points + config.points_boutique_par_jour };
  }
  return updated;
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run
// de postMarioClash.js, pour prévisualiser le bilan du jour actif ET l'état
// du jour suivant sans clôturer réellement. Même principe que
// previewCloture() de bossraid.js. Ne grante PAS le point quotidien quand
// c'est le dernier jour (pas de "jour suivant" à ouvrir), cohérent avec
// closeDayAndAdvance().
export async function previewCloture(jour, config) {
  const [actionsRaw, joueursAvant] = await Promise.all([readActions(jour), readJoueurs()]);
  const { joueursApres, lignes, immunises } = computeCloture({ actionsRaw, joueursAvant, config });
  const jourSuivant = jour + 1;
  if (jourSuivant > config.duree_jours) {
    return { termine: true, joueurs: joueursApres, lignes, immunises };
  }
  return { termine: false, jourSuivant, joueurs: grantDailyShopPoints(joueursApres, config), lignes, immunises };
}

export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  const hoursSince = (now - new Date(publishedAt).getTime()) / 3_600_000;
  return hoursSince < MIN_HOURS_BETWEEN_CLOSURES;
}

// Clôture le jour ACTIF (`state.jour`) : résout les actions, persiste les
// joueurs, archive le bilan du jour, purge les actions du jour. Ne gère PAS
// la transition "annonce → Jour 1" (aucune action à clôturer ce jour-là) —
// cette branche vit dans le handler, comme pour bossraid.js.
export async function closeDayAndAdvance(jour, config) {
  const [actionsRaw, joueursAvant] = await Promise.all([readActions(jour), readJoueurs()]);
  const { joueursApres, lignes, immunises } = computeCloture({ actionsRaw, joueursAvant, config });

  await writeHistoriqueEntry(jour, { lignes, immunises, resolvedAt: new Date().toISOString() });
  await clearActions(jour);

  const jourSuivant = jour + 1;
  if (jourSuivant > config.duree_jours) {
    for (const [id, j] of Object.entries(joueursApres)) {
      await writeJoueur(id, j);
    }
    return { termine: true, joueurs: joueursApres, lignes };
  }
  const joueursAvecPoints = grantDailyShopPoints(joueursApres, config);
  for (const [id, j] of Object.entries(joueursAvecPoints)) {
    await writeJoueur(id, j);
  }
  return { termine: false, jourSuivant, joueurs: joueursAvecPoints, lignes };
}

// ── Historique (bilans quotidiens de la manche en cours) ────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

// ── Manches (comparaison entre parties, comme bossraid.js) ──────────

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

export async function resetMarioClash({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, JOUEURS_KEY, HISTORIQUE_KEY);
  await scanDelete("marioclash:actions:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
  }
}
