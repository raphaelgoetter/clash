// ============================================================
// pont.js — Pont du Troll (jeu spécial de 7 jours, jeu de la minorité) :
// chaque jour, chaque membre traverse le ravin par le pont de pierre ou le
// pont de cordes, en secret. Le troll attrape le pont le plus chargé (le
// moins chargé un jour de Troll repu) ; les passants de l'autre pont se
// partagent le butin (1 pièce par passant attrapé, × multiplicateur de
// leur pont). Indice (jours pairs, répartition de moins en moins précise au
// fil de la journée) et Rumeurs (jours impairs, ponts annoncés par les
// joueurs, vrais ou faux, menteurs dévoilés aux rumeurs suivantes).
// Règles : jeux/CONTRIBUTING.md, section « Pont du Troll ».
//
// Stockage : Upstash Redis, espace de clés `pont:*`.
// ⚠️ automaticDeserialization désactivée (IDs Discord > MAX_SAFE_INTEGER).
// Pièces stockées en centièmes entiers (HINCRBY), jamais en flottant.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { noterJeuSpecial } from "./passeport.js";
import { jourDeJeu } from "./creneaux.js";
import { parisParts } from "./meowRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "pont", "pont.json");

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

// HGETALL sans désérialisation : tableau plat [champ1, valeur1, …]
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}
const hgetallRaw = async (key) => pairsToObject((await getRedis().hgetall(key)) || []);
async function hgetallJson(key) {
  const raw = await hgetallRaw(key);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, fromJson(v)]));
}
async function hgetallNombres(key) {
  const raw = await hgetallRaw(key);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]));
}

async function scanDelete(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (String(cursor) !== "0");
  if (keys.length) await getRedis().del(...keys);
}

const STATE_KEY = "pont:state";
const POINTS_KEY = "pont:points";
const PASSES_KEY = "pont:passes";
const USERNAMES_KEY = "pont:usernames";
const AVATARS_KEY = "pont:avatars";
const HISTORIQUE_KEY = "pont:historique";
const MANCHES_KEY = "pont:manches";
const MANCHE_SEQ_KEY = "pont:manche_seq";
const choixKey = (jour) => `pont:choix:${jour}`;
const indicesKey = (jour) => `pont:indices:${jour}`;
const rumeursKey = (jour) => `pont:rumeurs:${jour}`;

export const PIERRE = "pierre";
export const CORDES = "cordes";
export const COTES = [PIERRE, CORDES];
export const REPU = "repu";
export const FINALE = "finale";

// ── Config (statique) ─────────────────────────────────────────────

let configCache = null;
export async function loadPontConfig() {
  if (configCache) return configCache;
  configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf-8"));
  return configCache;
}

// Multiplicateurs et événement d'un jour : { jour, pierre, cordes, evenement }
export function jourConfig(config, jour) {
  const entree = config.calendrier.find((c) => c.jour === Number(jour));
  return { pierre: 1, cordes: 1, evenement: null, ...entree, jour: Number(jour) };
}

export const indiceDisponible = (config, jour) => config.jours_indice.includes(Number(jour));
export const rumeursDisponibles = (config, jour) => config.jours_rumeurs.includes(Number(jour));

// Jour de rumeurs précédent (détecteur de fake-news), null s'il n'y en a pas
export function rumeursPrecedentes(config, jour) {
  const avant = config.jours_rumeurs.filter((j) => j < Number(jour));
  return avant.length ? Math.max(...avant) : null;
}

// ── État de la partie (muté uniquement au cron) ───────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// Garde-fou anti-double-avancée (cron en retard après une relance manuelle)
export const MIN_HOURS_BETWEEN_CLOSURES = 8;
export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// Jour de jeu de 8h à 8h (heure de Paris) : après le décompte de 8h, plus
// aucun clic pour le jour publié, même si le cron n'est pas encore passé.
export function jourOuvert(publishedAt, now = Date.now()) {
  return Boolean(publishedAt) && jourDeJeu(publishedAt) === jourDeJeu(now);
}

// ── Règles — fonctions pures (testées) ────────────────────────────

// Résout un jour. `choix` : { discordId: { cote } } ; `cfg` : jourConfig().
// Gains en centièmes de pièce (entiers, multiples de 10).
export function resoudreJour(choix, cfg) {
  const passants = { [PIERRE]: [], [CORDES]: [] };
  for (const [discordId, c] of Object.entries(choix)) {
    if (passants[c?.cote]) passants[c.cote].push(discordId);
  }
  const n = { [PIERRE]: passants[PIERRE].length, [CORDES]: passants[CORDES].length };

  // Égalité : le troll hésite, personne n'est attrapé
  let attrape = null;
  if (n[PIERRE] !== n[CORDES]) {
    const plusCharge = n[PIERRE] > n[CORDES] ? PIERRE : CORDES;
    const moinsCharge = plusCharge === PIERRE ? CORDES : PIERRE;
    attrape = cfg.evenement === REPU ? moinsCharge : plusCharge;
  }
  const gagnant = attrape ? (attrape === PIERRE ? CORDES : PIERRE) : null;

  // Butin : 1 pièce par attrapé, partagée entre les passants de l'autre
  // pont, × son multiplicateur (× 2 en Grande finale). Pont vide en face :
  // aucun. Personne d'attrapé (égalité, ou Troll repu qui vise un pont
  // vide) : tout le monde passe et gagne le multiplicateur de son pont
  // (la formule du butin avec attrapés / passés = 1).
  // Arrondi au dixième de pièce : les totaux s'affichent sans perte.
  const finale = cfg.evenement === FINALE ? 2 : 1;
  const dixiemes = (x) => 10 * Math.round(10 * x);
  const personneAttrape = !attrape || n[attrape] === 0;
  const gainParCote = { [PIERRE]: 0, [CORDES]: 0 };
  if (personneAttrape) {
    for (const cote of COTES) gainParCote[cote] = dixiemes(cfg[cote] * finale);
  } else if (n[gagnant] > 0) {
    gainParCote[gagnant] = dixiemes((cfg[gagnant] * finale * n[attrape]) / n[gagnant]);
  }
  const gainBase = gagnant ? gainParCote[gagnant] : 0;

  const resultats = [];
  for (const cote of COTES) {
    for (const discordId of passants[cote]) {
      const passe = personneAttrape || cote === gagnant;
      resultats.push({ discordId, cote, passe, gain: passe ? gainParCote[cote] : 0 });
    }
  }
  return { pierre: n[PIERRE], cordes: n[CORDES], attrape, gagnant, personneAttrape, gainBase, gainParCote, passants, resultats };
}

const ECART_SERRE = 2;
const LARGEUR_FOURCHETTE = 4;
const NOM_COTE = { [PIERRE]: "la pierre", [CORDES]: "les cordes" };

// Indice : répartition au moment du clic, de moins en moins précise au
// fil de la journée (heure de Paris). 8h-12h : chiffres exacts ; 12h-18h :
// fourchette de 5 valeurs contenant l'écart réel, placée au hasard ;
// 18h-8h : tendance seule. Écart de 2 ou moins (hors 8h-12h) : coude à coude.
export function texteIndice({ pierre, cordes }, now = Date.now(), rng = Math.random) {
  if (pierre + cordes === 0) return "Personne n'a encore traversé.";
  const { h } = parisParts(now);
  if (h >= 8 && h < 12) return `Pierre ${pierre}, Cordes ${cordes}.`;
  const ecart = Math.abs(pierre - cordes);
  if (ecart <= ECART_SERRE) return "Coude à coude entre les deux ponts.";
  const devant = pierre > cordes ? PIERRE : CORDES;
  if (h >= 12 && h < 18) {
    const decalage = Math.floor(rng() * (LARGEUR_FOURCHETTE + 1));
    const bas = Math.max(1, ecart - decalage);
    const haut = bas + LARGEUR_FOURCHETTE;
    const verbe = devant === PIERRE ? "mène" : "mènent";
    return `${devant === PIERRE ? "La pierre" : "Les cordes"} ${verbe} de ${bas} à ${haut} passants.`;
  }
  return devant === PIERRE ? "La pierre semble plus chargée." : "Les cordes semblent plus chargées.";
}

// Classement : pièces décroissantes, puis jours passés décroissants.
export function buildRanking(points, passes = {}, usernames = {}) {
  return Object.entries(points)
    .map(([discordId, centiemes]) => ({
      discordId,
      username: usernames[discordId] || null,
      centiemes,
      passes: passes[discordId] ?? 0,
    }))
    .sort((a, b) => b.centiemes - a.centiemes || b.passes - a.passes);
}

export const memeRang = (a, b) => a.centiemes === b.centiemes && a.passes === b.passes;

// « 4,6 » (une décimale, virgule)
export function formatPieces(centiemes) {
  const v = Math.round(centiemes / 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ",");
}

// ── Choix du pont (un par jour, définitif) ────────────────────────

// Enregistre le choix s'il n'existe pas encore (HSETNX, sûr en cas de
// double clic). Renvoie { ok, cote } (cote = choix retenu).
// `avatar` : hash de l'avatar Discord ; PNJ : `avatarRef` (« clay-03 »),
// jamais de passeport.
export async function enregistrerChoix(jour, discordId, cote, { username, avatar, avatarRef } = {}) {
  const ok = Boolean(await getRedis().hsetnx(choixKey(jour), discordId, toJson({ cote, at: new Date().toISOString() })));
  if (!ok) return { ok: false, cote: (await readChoix(jour, discordId))?.cote ?? null };
  if (username) await getRedis().hset(USERNAMES_KEY, { [discordId]: username });
  await getRedis().hset(AVATARS_KEY, { [discordId]: avatarRef ?? (avatar ? `${discordId}/${avatar}` : "") });
  if (!estPnj(discordId)) await noterJeuSpecial(discordId, "pont");
  return { ok: true, cote };
}

// ── PNJ (salon de test uniquement) ────────────────────────────────

export const PNJ = ["Josette", "Gérard", "Ginette", "Jean-Mi", "Bernadette"];
export const estPnj = (discordId) => String(discordId).startsWith("pnj-");

// Les PNJ traversent au hasard (un pont chacun, 50/50) et, les jours de
// rumeurs, lancent une rumeur au hasard (vérité, mensonge ou rien).
export async function jouerPnj(jour, { rumeurs = false } = {}, rng = Math.random) {
  for (const [i, nom] of PNJ.entries()) {
    const id = `pnj-${i + 1}`;
    await enregistrerChoix(jour, id, rng() < 0.5 ? PIERRE : CORDES, {
      username: nom,
      avatarRef: `clay-${String(i + 1).padStart(2, "0")}`,
    });
    if (rumeurs) await lancerRumeur(jour, id, RUMEURS[Math.floor(rng() * RUMEURS.length)]);
  }
}

export async function readChoix(jour, discordId) {
  return fromJson(await getRedis().hget(choixKey(jour), discordId));
}

export async function listChoix(jour) {
  return hgetallJson(choixKey(jour));
}

export async function compterPassants(jour) {
  return Number(await getRedis().hlen(choixKey(jour))) || 0;
}

// ── Rumeurs (jours impairs, une par joueur et par jour) ───────────

export const VERITE = "verite";
export const MENSONGE = "mensonge";
export const RIEN = "rien";
export const RUMEURS = [VERITE, MENSONGE, RIEN];
const AUTRE = { [PIERRE]: CORDES, [CORDES]: PIERRE };

// Intention définitive (HSETNX). Renvoie { ok, mode } (mode retenu).
export async function lancerRumeur(jour, discordId, mode) {
  if (!RUMEURS.includes(mode)) return { ok: false, mode: null };
  const ok = Boolean(await getRedis().hsetnx(rumeursKey(jour), discordId, toJson({ mode, at: new Date().toISOString() })));
  if (ok) return { ok: true, mode };
  return { ok: false, mode: fromJson(await getRedis().hget(rumeursKey(jour), discordId))?.mode ?? null };
}

export async function readRumeur(jour, discordId) {
  return fromJson(await getRedis().hget(rumeursKey(jour), discordId))?.mode ?? null;
}

export async function listRumeurs(jour) {
  return hgetallJson(rumeursKey(jour));
}

// Pont annoncé par chacun : l'intention s'applique au pont réellement
// choisi (vérité : le sien, mensonge : l'autre). Sans pont choisi, ou sans
// rumeur (« rien »), le joueur n'apparaît pas. Pure.
export function rumeursAnnoncees(choix, rumeurs) {
  const annonces = { [PIERRE]: [], [CORDES]: [] };
  for (const [discordId, r] of Object.entries(rumeurs)) {
    const cote = choix[discordId]?.cote;
    if (!cote || !(cote in annonces)) continue;
    if (r?.mode === VERITE) annonces[cote].push(discordId);
    else if (r?.mode === MENSONGE) annonces[AUTRE[cote]].push(discordId);
  }
  return annonces;
}

// Menteurs d'un jour de rumeurs : mensonge et pont choisi. Pure.
export function menteurs(choix, rumeurs) {
  return Object.entries(rumeurs)
    .filter(([discordId, r]) => r?.mode === MENSONGE && choix[discordId]?.cote)
    .map(([discordId]) => discordId);
}

// ── Indice (une consultation par jour) ────────────────────────────

// Première consultation : calcule et mémorise le texte. Suivantes : même
// texte (pas de nouvel indice). Renvoie { nouveau, texte }.
export async function consulterIndice(jour, discordId, now = Date.now()) {
  const existant = fromJson(await getRedis().hget(indicesKey(jour), discordId));
  if (existant) return { nouveau: false, texte: existant.texte };
  const choix = await listChoix(jour);
  const repartition = { pierre: 0, cordes: 0 };
  for (const c of Object.values(choix)) if (c?.cote in repartition) repartition[c.cote] += 1;
  const texte = texteIndice(repartition, now);
  const ok = Boolean(await getRedis().hsetnx(indicesKey(jour), discordId, toJson({ at: new Date(now).toISOString(), texte })));
  if (!ok) return { nouveau: false, texte: fromJson(await getRedis().hget(indicesKey(jour), discordId))?.texte ?? texte };
  return { nouveau: true, texte };
}

export async function compterIndices(jour) {
  return Number(await getRedis().hlen(indicesKey(jour))) || 0;
}

// ── Points, jours passés, pseudos, avatars ────────────────────────

export async function addPoints(discordId, centiemes) {
  if (centiemes > 0) await getRedis().hincrby(POINTS_KEY, discordId, centiemes);
}

export async function addPasse(discordId) {
  await getRedis().hincrby(PASSES_KEY, discordId, 1);
}

// Tout passant apparaît au classement, même à 0 pièce
export async function inscrireAuClassement(discordId) {
  await getRedis().hincrby(POINTS_KEY, discordId, 0);
}

export const readPoints = () => hgetallNombres(POINTS_KEY);
export const readPasses = () => hgetallNombres(PASSES_KEY);
export const readUsernames = () => hgetallRaw(USERNAMES_KEY);
export const readAvatars = () => hgetallRaw(AVATARS_KEY);

// ── Historique (résultats quotidiens) ─────────────────────────────

export async function writeHistoriqueEntry(jour, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(jour) {
  return fromJson(await getRedis().hget(HISTORIQUE_KEY, String(jour)));
}

// ── Manches (bilans de fin de partie, jamais nettoyées sauf --manches) ──

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

// ── Remise à zéro ─────────────────────────────────────────────────

// Données d'une partie (au passage au Jour 1 et par resetPont)
export async function resetPartie() {
  await getRedis().del(POINTS_KEY, PASSES_KEY, USERNAMES_KEY, AVATARS_KEY, HISTORIQUE_KEY);
  await scanDelete("pont:choix:*");
  await scanDelete("pont:indices:*");
  await scanDelete("pont:rumeurs:*");
}

export async function resetPont({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY);
  await resetPartie();
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
