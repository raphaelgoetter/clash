// ============================================================
// coffre.js — Le Coffre (jeu spécial de 7 jours, Mastermind quotidien) :
// chaque jour, un nouveau code de 4 symboles tous différents parmi 6. Chaque
// joueur a 5 essais et un indice personnel (différent pour chacun) ; chaque
// essai répond par le nombre de symboles bien placés et mal placés.
// Coffre ouvert en N essais = 6 - N points (5 au premier essai, 1 au
// cinquième). Classement cumulé : points, puis le moins d'essais utilisés.
// Règles : jeux/CONTRIBUTING.md, section « Le Coffre ».
//
// Stockage : Upstash Redis, espace de clés `coffre:*`.
// ⚠️ automaticDeserialization désactivée (IDs Discord > MAX_SAFE_INTEGER).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { noterJeuSpecial } from "./passeport.js";
import { jourDeJeu } from "./creneaux.js";
import { parisParts } from "./meowRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "coffre", "coffre.json");

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

const STATE_KEY = "coffre:state";
const CODES_KEY = "coffre:codes";
const POINTS_KEY = "coffre:points";
const ESSAIS_TOTAL_KEY = "coffre:essais_total";
const USERNAMES_KEY = "coffre:usernames";
const HISTORIQUE_KEY = "coffre:historique";
const MANCHES_KEY = "coffre:manches";
const MANCHE_SEQ_KEY = "coffre:manche_seq";
const partiesKey = (jour) => `coffre:parties:${jour}`;
const verrouKey = (jour, discordId) => `coffre:verrou:${jour}:${discordId}`;

// ── Symboles ──────────────────────────────────────────────────────
// Forme ET couleur distinctes (daltoniens), émoji Discord identique à la
// forme dessinée sur le plateau (coffreImage.js)
export const SYMBOLES = [
  { id: "rond", nom: "Rond", emoji: "🟣", couleur: "#b46bff" },
  { id: "carre", nom: "Carré", emoji: "🟦", couleur: "#3d8bff" },
  { id: "losange", nom: "Losange", emoji: "🔶", couleur: "#ff8a1f" },
  { id: "etoile", nom: "Étoile", emoji: "⭐", couleur: "#ffd43b" },
  { id: "coeur", nom: "Cœur", emoji: "💚", couleur: "#3ecf6a" },
  { id: "triangle", nom: "Triangle", emoji: "🔺", couleur: "#ff4d4f" },
];
export const IDS_SYMBOLES = SYMBOLES.map((s) => s.id);
export const symbole = (id) => SYMBOLES.find((s) => s.id === id) ?? null;

// ── Config (statique) ─────────────────────────────────────────────

let configCache = null;
export async function loadCoffreConfig() {
  if (configCache) return configCache;
  configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf-8"));
  return configCache;
}

// ── État de la partie (muté uniquement au cron) ───────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// Garde-fou anti-double-avancée : un jour publié depuis moins de 8 h n'est
// pas clôturé (cron en retard après une relance manuelle)
export const MIN_HOURS_BETWEEN_CLOSURES = 8;
export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// Heure d'ouverture du coffre, en heure de Paris du jour de `now` : le cron
// tourne à heure UTC fixe (7h28 UTC), soit 8h28 en hiver et 9h28 en été.
// Fermeture à minuit toute l'année. Pure.
const HEURE_UTC_OUVERTURE = 7;
export function heureOuverture(now = Date.now()) {
  const d = new Date(now);
  return parisParts(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HEURE_UTC_OUVERTURE, 30)).h;
}

// Coffre ouvert jusqu'à minuit (heure de Paris) le jour de jeu de sa
// publication : de minuit au passage du cron, plus aucun essai.
export function jourOuvert(publishedAt, now = Date.now()) {
  return Boolean(publishedAt) && jourDeJeu(publishedAt) === jourDeJeu(now) && parisParts(now).h >= 8;
}

// ── Règles — fonctions pures (testées) ────────────────────────────

// Code du jour : `longueur` symboles tous différents
export function tirerCode(longueur = 4, rng = Math.random) {
  const pool = [...IDS_SYMBOLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, longueur);
}

// Réponse Mastermind (symboles tous différents) : { bien, mal }
export function reponse(code, essai) {
  let bien = 0;
  let mal = 0;
  essai.forEach((s, i) => {
    if (code[i] === s) bien += 1;
    else if (code.includes(s)) mal += 1;
  });
  return { bien, mal };
}

// Essai valide : `longueur` symboles connus, tous différents
export function essaiValide(essai, longueur = 4) {
  return (
    Array.isArray(essai) &&
    essai.length === longueur &&
    essai.every((s) => IDS_SYMBOLES.includes(s)) &&
    new Set(essai).size === longueur
  );
}

// Points d'un coffre ouvert au `n`-ième essai (5 au premier, 1 au cinquième)
export const pointsOuverture = (n, essaisMax = 5) => Math.max(0, essaisMax + 1 - n);

// Générateur reproductible (mulberry32) à partir d'une chaîne
export function rngDepuis(graine) {
  let h = 1779033703 ^ graine.length;
  for (let i = 0; i < graine.length; i++) {
    h = Math.imul(h ^ graine.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Indice personnel, toujours vrai, tiré de façon reproductible (même
// indice à chaque ouverture du plateau, sans stockage). Types (poids de la
// simulation, jeux/outils/coffre-simulation/simuler.mjs) :
// - absent : « X n'est pas dans le code » (3)
// - position : « X est en Ne place » (2)
// - ailleurs : « X est dans le code, mais pas en Ne place » (3)
// - pasEn : « X n'est pas en Ne place » (2, X présent ailleurs ou absent)
const POIDS_INDICES = [["absent", 3], ["position", 2], ["ailleurs", 3], ["pasEn", 2]];
export function tirerIndice(code, rng) {
  const total = POIDS_INDICES.reduce((a, [, p]) => a + p, 0);
  let r = rng() * total;
  let type = POIDS_INDICES[0][0];
  for (const [t, p] of POIDS_INDICES) {
    if ((r -= p) < 0) {
      type = t;
      break;
    }
  }
  const pioche = (t) => t[Math.floor(rng() * t.length)];
  const positions = code.map((_, i) => i);
  const absents = IDS_SYMBOLES.filter((s) => !code.includes(s));
  if (type === "absent" && absents.length) return { type, symbole: pioche(absents) };
  if (type === "position") {
    const p = pioche(positions);
    return { type, symbole: code[p], position: p };
  }
  if (type === "ailleurs") {
    const i = pioche(positions);
    return { type, symbole: code[i], position: pioche(positions.filter((q) => q !== i)) };
  }
  const p = pioche(positions);
  return { type: "pasEn", symbole: pioche(IDS_SYMBOLES.filter((s) => s !== code[p])), position: p };
}

export const indiceDuJoueur = (code, partieId, jour, discordId) =>
  tirerIndice(code, rngDepuis(`${partieId}:${jour}:${discordId}`));

// Vérifie qu'un code respecte un indice (tests)
export function respecteIndice(code, indice) {
  const { type, symbole: s, position: p } = indice;
  if (type === "absent") return !code.includes(s);
  if (type === "position") return code[p] === s;
  if (type === "ailleurs") return code.includes(s) && code[p] !== s;
  return code[p] !== s;
}

const rangTexte = (p) => (p === 0 ? "1re" : `${p + 1}e`);

// « 🟣 n'est pas dans le code » (émoji du symbole)
export function texteIndice(indice) {
  const e = symbole(indice.symbole)?.emoji ?? "?";
  if (indice.type === "absent") return `${e} n'est pas dans le code`;
  if (indice.type === "position") return `${e} est en ${rangTexte(indice.position)} place`;
  if (indice.type === "ailleurs") return `${e} est dans le code, mais pas en ${rangTexte(indice.position)} place`;
  return `${e} n'est pas en ${rangTexte(indice.position)} place`;
}

// Texte de l'image, après la forme dessinée : « est en 3e place »
export function texteIndiceCourt(indice) {
  if (indice.type === "absent") return "n'est pas dans le code";
  if (indice.type === "position") return `est en ${rangTexte(indice.position)} place`;
  if (indice.type === "ailleurs") return `est là, mais pas en ${rangTexte(indice.position)}`;
  return `n'est pas en ${rangTexte(indice.position)} place`;
}

// Classement : points décroissants, puis le moins d'essais utilisés
export function buildRanking(points, essais = {}, usernames = {}) {
  return Object.entries(points)
    .map(([discordId, pts]) => ({
      discordId,
      username: usernames[discordId] || null,
      points: pts,
      essais: essais[discordId] ?? 0,
    }))
    .sort((a, b) => b.points - a.points || a.essais - b.essais);
}

export const memeRang = (a, b) => a.points === b.points && a.essais === b.essais;

// Bilan d'un jour à partir des parties des joueurs. Pure.
export function bilanJour(parties) {
  const joueurs = Object.values(parties).filter((p) => p?.essais?.length);
  const ouverts = joueurs.filter((p) => p.ouvert);
  const essaisOuverts = ouverts.map((p) => p.essais.length);
  return {
    joueurs: joueurs.length,
    ouverts: ouverts.length,
    // Nombre de coffres ouverts en 1, 2, … essais
    parEssais: essaisOuverts.reduce((acc, n) => ({ ...acc, [n]: (acc[n] ?? 0) + 1 }), {}),
    meilleur: essaisOuverts.length ? Math.min(...essaisOuverts) : null,
  };
}

// ── Code du jour (secret jusqu'au résultat) ───────────────────────

export async function writeCode(jour, code) {
  await getRedis().hset(CODES_KEY, { [jour]: toJson(code) });
}

export async function readCode(jour) {
  return fromJson(await getRedis().hget(CODES_KEY, String(jour)));
}

// ── Partie d'un joueur (un jour) ──────────────────────────────────

// { essais: [{ symboles, bien, mal, at }], ouvert, points }
export async function readPartie(jour, discordId) {
  return fromJson(await getRedis().hget(partiesKey(jour), discordId)) ?? { essais: [], ouvert: false, points: 0 };
}

export async function listParties(jour) {
  return hgetallJson(partiesKey(jour));
}

export async function compterJoueurs(jour) {
  return Number(await getRedis().hlen(partiesKey(jour))) || 0;
}

// Joue un essai. Renvoie { statut, partie, reponse? } ; statut : "ok",
// "invalide", "termine" (coffre ouvert ou essais épuisés), "occupe" (essai
// déjà en cours, double clic). Verrou par joueur (SET NX, 10 s).
export async function jouerEssai(jour, discordId, essai, { code, essaisMax, username, pnj = false }) {
  if (!essaiValide(essai, code.length)) return { statut: "invalide", partie: await readPartie(jour, discordId) };
  const verrou = await getRedis().set(verrouKey(jour, discordId), "1", { nx: true, ex: 10 });
  if (!verrou) return { statut: "occupe", partie: await readPartie(jour, discordId) };
  try {
    const partie = await readPartie(jour, discordId);
    if (partie.ouvert || partie.essais.length >= essaisMax) return { statut: "termine", partie };
    const r = reponse(code, essai);
    partie.essais.push({ symboles: essai, ...r, at: new Date().toISOString() });
    if (r.bien === code.length) {
      partie.ouvert = true;
      partie.points = pointsOuverture(partie.essais.length, essaisMax);
    }
    await getRedis().hset(partiesKey(jour), { [discordId]: toJson(partie) });
    // Classement : tout joueur y entre dès son premier essai, même à 0 point
    await getRedis().hincrby(POINTS_KEY, discordId, partie.points);
    await getRedis().hincrby(ESSAIS_TOTAL_KEY, discordId, 1);
    if (username) await getRedis().hset(USERNAMES_KEY, { [discordId]: username });
    if (partie.essais.length === 1 && !pnj) await noterJeuSpecial(discordId, "coffre");
    return { statut: "ok", partie, reponse: r };
  } finally {
    await getRedis().del(verrouKey(jour, discordId));
  }
}

// ── PNJ (salon de test uniquement) ────────────────────────────────

export const PNJ = ["Josette", "Gérard", "Ginette", "Jean-Mi", "Bernadette"];
export const estPnj = (discordId) => String(discordId).startsWith("pnj-");

// Les PNJ jouent des codes au hasard compatibles avec leur indice et leurs
// réponses précédentes (comme un joueur méthodique)
export async function jouerPnj(jour, { code, essaisMax, partieId }, rng = Math.random) {
  for (const [i, nom] of PNJ.entries()) {
    const id = `pnj-${i + 1}`;
    const indice = indiceDuJoueur(code, partieId, jour, id);
    const historique = [];
    for (let e = 0; e < essaisMax; e++) {
      const candidats = tousLesCodes(code.length).filter(
        (c) =>
          respecteIndice(c, indice) &&
          historique.every((h) => {
            const r = reponse(c, h.symboles);
            return r.bien === h.bien && r.mal === h.mal;
          }),
      );
      const essai = candidats[Math.floor(rng() * candidats.length)];
      const { partie } = await jouerEssai(jour, id, essai, { code, essaisMax, username: nom, pnj: true });
      if (partie.ouvert) break;
      historique.splice(0, historique.length, ...partie.essais);
    }
  }
}

// Tous les codes de `longueur` symboles différents (360 pour 4 parmi 6)
export function tousLesCodes(longueur = 4) {
  const res = [];
  const rec = (pref) => {
    if (pref.length === longueur) return res.push(pref);
    for (const s of IDS_SYMBOLES) if (!pref.includes(s)) rec([...pref, s]);
  };
  rec([]);
  return res;
}

// ── Points, essais, pseudos ───────────────────────────────────────

export const readPoints = () => hgetallNombres(POINTS_KEY);
export const readEssaisTotal = () => hgetallNombres(ESSAIS_TOTAL_KEY);
export const readUsernames = () => hgetallRaw(USERNAMES_KEY);

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

// Données d'une partie (au passage au Jour 1 et par resetCoffre)
export async function resetPartie() {
  await getRedis().del(CODES_KEY, POINTS_KEY, ESSAIS_TOTAL_KEY, USERNAMES_KEY, HISTORIQUE_KEY);
  await scanDelete("coffre:parties:*");
  await scanDelete("coffre:verrou:*");
}

export async function resetCoffre({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY);
  await resetPartie();
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
