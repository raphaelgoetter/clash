// ============================================================
// draftroyale.js — Draft Royale, jeu spécial de 7 jours inspiré du « Kilo
// de merde » : chaque carte en jeu existe en 4 exemplaires, chaque joueur
// a 4 cartes en main, le marché contient une carte par joueur (toujours
// visible). Chaque
// jour, un joueur prend une carte du marché et y dépose une carte de sa
// main. Le premier à réunir 4 exemplaires d'une même carte (un « carré »)
// déclenche le décompte : 10 pts pour un carré, sinon 1 à 3 pts selon le
// nombre d'exemplaires identiques, puis toutes les cartes sont
// redistribuées. Règles pures dans draftRules.js.
//
// Couche métier : config statique, catalogue, état de la partie (cartes
// en jeu et marché), joueurs, échanges du jour, clôture, historique,
// manches.
//
// Stockage : Upstash Redis (mêmes conventions que marioclash.js) — espace
// de clés `draftroyale:*`.
//
// Participation libre : un joueur reçoit sa main à son premier clic (de
// nouvelles cartes entrent en jeu selon le nombre de joueurs). Les
// échanges sont modifiables jusqu'à la clôture, où ils sont résolus tous
// ensemble (computeCloture, fonction pure, `rng` injectable) : l'heure de
// connexion ne doit donner aucun avantage.
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Draft Royale), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { filterCardPool } from "./cards.js";
import { ajouterJoueur, echangeValide, computeTour, classement, lireBonus, voirMain, jokerCout, choisirVedettes, nbVedettes } from "./draftRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "draftroyale", "draftroyale.json");
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");

const STATE_KEY = "draftroyale:state";
// { familles, sorties, marche, reserve, vedettes } (cardKeys) — cartes en
// jeu, cartes sorties du jeu (quadruplés), marché courant, exemplaires à
// l'écart et cartes vedettes
const PARTIE_KEY = "draftroyale:partie";
const JOUEURS_KEY = "draftroyale:joueurs";
const HISTORIQUE_KEY = "draftroyale:historique";
const RESULTAT_KEY = "draftroyale:resultat";
const MANCHES_KEY = "draftroyale:manches";
const MANCHE_SEQ_KEY = "draftroyale:manche_seq";
// Gel des arrivées (le marché change quand un joueur reçoit sa main)
const LOCK_KEY = "draftroyale:lock";
const actionsKey = (jour) => `draftroyale:actions:${jour}`;

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

// ── Config statique et catalogue ───────────────────────────────────

let _configCache = null;

export async function loadDraftRoyaleConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

// Catalogue complet des cartes jouables (voir cards.js).
// Map cardKey → carte de data/cardNames.json.
let _catalogCache = null;

export async function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  const all = JSON.parse(await fs.readFile(CARD_NAMES_PATH, "utf8"));
  _catalogCache = new Map(filterCardPool(all).map((c) => [c.cardKey, c]));
  return _catalogCache;
}

// ── Clôture (fonction pure) ─────────────────────────────────────────

// Clôture du jour `jour` : échanges, décompte (carré ou dernier jour),
// nouvelle main pour l'auteur d'un quadruplé, classement final au dernier
// jour.
export function computeCloture({ jour, joueursAvant, actionsRaw, partie, config, catalog = null, rng = Math.random }) {
  const dernier = jour >= config.duree_jours;
  const tour = computeTour({
    joueursAvant,
    actions: actionsRaw,
    marche: partie.marche,
    reserve: partie.reserve,
    familles: partie.familles,
    sorties: partie.sorties || [],
    vedettes: partie.vedettes || [],
    derniersQuadruples: partie.derniersQuadruples || [],
    catalog,
    config,
    dernier,
    rng,
  });
  return {
    joueursApres: tour.joueurs,
    partieApres: { ...partie, marche: tour.marche, reserve: tour.reserve, familles: tour.familles, sorties: tour.sorties, vedettes: tour.vedettes, derniersQuadruples: tour.derniersQuadruples },
    lignes: tour.lignes,
    carres: tour.carres,
    scores: tour.scores,
    nouvellesVedettes: tour.nouvellesVedettes,
    final: dernier ? classement(tour.joueurs) : null,
  };
}

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

export async function readPartie() {
  return fromJson(await getRedis().get(PARTIE_KEY)) || { familles: [], marche: [], reserve: [] };
}

async function writePartie(partie) {
  await getRedis().set(PARTIE_KEY, toJson(partie));
}

// Début du draft (Jour 1) : aucune carte en jeu, elles arrivent avec les
// joueurs (voir ajouterJoueur).
export async function initPartie() {
  const partie = { familles: [], marche: [], reserve: [] };
  await writePartie(partie);
  return partie;
}

// ── Joueurs ─────────────────────────────────────────────────────────
// HASH discordId → JSON { username, main: [cardKey], joker, points,
// carres, arrivee }.

export async function readJoueurs() {
  return hgetallJson(JOUEURS_KEY);
}

export async function readJoueur(discordId) {
  return fromJson(await getRedis().hget(JOUEURS_KEY, discordId));
}

export async function writeJoueur(discordId, joueur) {
  await getRedis().hset(JOUEURS_KEY, { [discordId]: toJson(joueur) });
}

async function withLock(fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(LOCK_KEY, "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(LOCK_KEY);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Gel du Draft Royale indisponible");
}

// Premier clic : le joueur tire sa main dans le marché (sous verrou, le
// marché change). Renvoie { joueur, nouveau }.
export async function ensureJoueur(discordId, username, rng = Math.random) {
  const existing = await readJoueur(discordId);
  if (existing) {
    if (username && existing.username !== username) {
      const updated = { ...existing, username };
      await writeJoueur(discordId, updated);
      return { joueur: updated, nouveau: false };
    }
    return { joueur: existing, nouveau: false };
  }
  return withLock(async () => {
    const deja = await readJoueur(discordId);
    if (deja) return { joueur: deja, nouveau: false };
    const [config, catalog, joueurs, partie] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readJoueurs(), readPartie()]);
    const nbAvant = Object.keys(joueurs).length;
    const arrivee = ajouterJoueur({ ...partie, nbJoueursAvant: nbAvant, config, catalog, rng });
    const joueur = { username: username || "?", main: arrivee.main, joker: 0, points: 0, carres: 0, arrivee: nbAvant };
    // Cartes vedettes : une pour `joueurs_par_vedette` joueurs, complétées
    // au fil des arrivées (celles déjà annoncées sont gardées)
    const vedettes = choisirVedettes(arrivee.familles, nbVedettes(nbAvant + 1, config), { gardees: partie.vedettes || [] }, rng);
    await writePartie({ ...partie, familles: arrivee.familles, marche: arrivee.marche, reserve: arrivee.reserve, vedettes });
    await writeJoueur(discordId, joueur);
    return { joueur, nouveau: true };
  });
}

// ── Échanges du jour ────────────────────────────────────────────────
// HASH discordId → JSON { prise, depot }, modifiable jusqu'à la clôture.

export async function readActions(jour) {
  return hgetallJson(actionsKey(jour));
}

export async function readAction(jour, discordId) {
  return fromJson(await getRedis().hget(actionsKey(jour), discordId)) || {};
}

// `champ` : "prise" (carte du marché), "depot" (carte de la main) ou
// "annuler" (efface les deux).
export async function enregistrerChoix(jour, discordId, champ, key) {
  const [joueur, partie] = await Promise.all([readJoueur(discordId), readPartie()]);
  if (!joueur) return { status: "unknownPlayer" };
  if (champ === "annuler") {
    const action = { ...(await readAction(jour, discordId)), prise: null, depot: null };
    await getRedis().hset(actionsKey(jour), { [discordId]: toJson(action) });
    return { status: "ok", action, complet: false };
  }
  if (champ === "prise" && !partie.marche.includes(key)) return { status: "unavailable" };
  if (champ === "depot" && !joueur.main.includes(key)) return { status: "notInHand" };
  const action = { ...(await readAction(jour, discordId)), [champ]: key };
  await getRedis().hset(actionsKey(jour), { [discordId]: toJson(action) });
  return { status: "ok", action, complet: echangeValide(action, joueur.main, partie.marche) };
}

// Bonus Joker du jour (valeur du menu, voir lireBonus), modifiable jusqu'à
// la clôture.
export async function enregistrerJoker(jour, discordId, valeur) {
  const [config, joueurs, partie, action] = await Promise.all([loadDraftRoyaleConfig(), readJoueurs(), readPartie(), readAction(jour, discordId)]);
  if (!joueurs[discordId]) return { status: "unknownPlayer" };
  const r = lireBonus(valeur, { id: discordId, joueurs, marche: partie.marche, reserve: partie.reserve, config });
  if (r.erreur) return { status: r.erreur };
  await getRedis().hset(actionsKey(jour), { [discordId]: toJson({ ...action, joker: r.joker }) });
  return { status: "ok", joker: r.joker };
}

// Espionner : instantané, payé tout de suite (une fois par jour). Sous le
// verrou des arrivées : les points Joker du joueur changent.
export async function voirMainJoueur(jour, discordId, cible) {
  return withLock(async () => {
    const [config, joueurs, actions] = await Promise.all([loadDraftRoyaleConfig(), readJoueurs(), readActions(jour)]);
    const r = voirMain({ id: discordId, cible, joueurs, actions, config });
    if (r.erreur) return { status: r.erreur };
    const moi = joueurs[discordId];
    await writeJoueur(discordId, { ...moi, joker: moi.joker - jokerCout("espionner", config) });
    await getRedis().hset(actionsKey(jour), { [discordId]: toJson({ ...(actions[discordId] || {}), vu: r.vu }) });
    return { status: "ok", vu: r.vu };
  });
}

// ── Clôture ─────────────────────────────────────────────────────────

async function loadClotureInputs(jour) {
  const [config, catalog, joueursAvant, actionsRaw, partie] = await Promise.all([
    loadDraftRoyaleConfig(),
    loadCatalog(),
    readJoueurs(),
    readActions(jour),
    readPartie(),
  ]);
  return { config, catalog, joueursAvant, actionsRaw, partie };
}

// Lecture seule (aucune écriture Redis) — branche --dry-run du script.
export async function previewCloture(jour) {
  const inputs = await loadClotureInputs(jour);
  const closure = computeCloture({ jour, ...inputs });
  return { ...closure, joueursAvant: inputs.joueursAvant, termine: !!closure.final, jourSuivant: jour + 1 };
}

export async function closeDayAndAdvance(jour) {
  const inputs = await loadClotureInputs(jour);
  const closure = computeCloture({ jour, ...inputs });

  await writeHistoriqueEntry(jour, {
    lignes: closure.lignes,
    carres: closure.carres,
    scores: closure.scores,
    nouvellesVedettes: closure.nouvellesVedettes,
    resolvedAt: new Date().toISOString(),
  });
  await writePartie(closure.partieApres);
  for (const [id, j] of Object.entries(closure.joueursApres)) await writeJoueur(id, j);
  if (closure.final) await getRedis().set(RESULTAT_KEY, toJson(closure.final));

  return { ...closure, joueursAvant: inputs.joueursAvant, termine: !!closure.final, jourSuivant: jour + 1 };
}

export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── Historique et résultat final ────────────────────────────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

export async function readResultat() {
  return fromJson(await getRedis().get(RESULTAT_KEY));
}

// ── Manches (comparaison entre parties, comme marioclash.js) ────────

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

export async function resetDraftRoyale({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, PARTIE_KEY, JOUEURS_KEY, HISTORIQUE_KEY, RESULTAT_KEY, LOCK_KEY);
  await scanDelete("draftroyale:actions:*");
  await scanDelete("draftroyale:marche:*");
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
