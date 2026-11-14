// ============================================================
// boss.js — Boss de fin de saison des mini-jeux : les joueurs au passeport
// complet (passeport.js) affrontent une Kévina renforcée sur le duel du
// mois, une seule tentative, du 1er au 7 du mois suivant.
//
// - Même donne pour tous : les choix de Kévina tirent leur hasard d'une
//   graine de la saison et de l'avancée de la partie (`bossRng.js`), donc deux
//   joueurs qui jouent les mêmes coups voient Kévina répondre pareil.
// - Une tentative est consommée dès « Prêt » (HSETNX) ; sans action pendant
//   INACTIVITE_MS, la partie est perdue avec le score atteint.
// - Classement par score décroissant (règle de chaque jeu, `BOSS_JEUX`) ;
//   le classement n'est publié qu'à la clôture (le 8).
//
// Les règles de chaque duel restent pures (`<jeu>Rules.js`) ; ce module ne
// fait que l'état Redis et le déroulé commun.
// ============================================================

import { Redis } from "@upstash/redis";
import { getSeasonBoundsById, seasonIdForDate } from "./saison.js";
import { incrementerCompteurs, lirePasseport, listerJoueursSaison } from "./passeport.js";
import { BOSS_QUATRE } from "./bossQuatre.js";
import { BOSS_FRISE } from "./bossFrise.js";
import { BOSS_PUNTO } from "./bossPunto.js";
import { BOSS_GRILLE } from "./bossGrille.js";
import { BOSS_POTATO } from "./bossPotato.js";

export { rngBossDe as rngBoss } from "./bossRng.js";

// Duels possibles pour le Boss (même ordre que leur ajout). Un duel n'y
// entre que si la donne peut être commune et le score départager.
export const BOSS_JEUX = { quatre: BOSS_QUATRE, frise: BOSS_FRISE, punto: BOSS_PUNTO, grille: BOSS_GRILLE, potato: BOSS_POTATO };

// Première saison avec un Boss : novembre 2026 (objectifs allégés, voir
// passeport.js), Boss ouvert le 1er décembre 2026.
export const PREMIERE_SAISON_BOSS = 138;

// Durée du Boss : du 1er à minuit (heure de Paris) au 8 à minuit.
export const DUREE_JOURS = 7;
export const INACTIVITE_MS = 60 * 60 * 1000;
const TTL_SECONDES = 120 * 24 * 3600;

const cleBoss = (seasonId) => `boss:${seasonId}`;
const cleTentatives = (seasonId) => `boss:${seasonId}:tentatives`;
const clePartie = (seasonId, discordId) => `boss:${seasonId}:partie:${discordId}`;
const cleCloture = (seasonId) => `boss:${seasonId}:cloture`;
const cleVerrou = (seasonId, discordId) => `boss:${seasonId}:lock:${discordId}`;

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

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function withLock(cle, fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(cle, "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(cle);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou du Boss indisponible");
}

// ── Boss d'une saison ─────────────────────────────────────────────────

/** Pure : instant de clôture du Boss de la saison `seasonId` (le 8 du mois
 * suivant à minuit, heure de Paris). */
export function clotureDe(seasonId) {
  const { start } = getSeasonBoundsById(seasonId + 1);
  const fin = new Date(start);
  fin.setUTCDate(fin.getUTCDate() + DUREE_JOURS);
  return fin;
}

export async function lireBoss(seasonId) {
  return fromJson(await getRedis().get(cleBoss(seasonId)));
}

/** Boss dont la semaine court à `now` (saison précédente, entre son
 * ouverture et sa clôture), sinon null. */
export async function bossEnCours(now = new Date()) {
  const boss = await lireBoss(seasonIdForDate(now) - 1);
  if (!boss || boss.cloture || now >= new Date(boss.clotureAt)) return null;
  return boss;
}

/** Pure : duel du Boss de la saison `seasonId`, en roulement dans l'ordre
 * de BOSS_JEUX à partir de PREMIERE_SAISON_BOSS. */
export function jeuDeSaison(seasonId) {
  const jeux = Object.keys(BOSS_JEUX);
  const i = (((seasonId - PREMIERE_SAISON_BOSS) % jeux.length) + jeux.length) % jeux.length;
  return jeux[i];
}

/** Ouvre le Boss de la saison `seasonId` (une fois la saison finie) :
 * duel, graine et liste des qualifiés. Idempotent : renvoie le Boss déjà
 * ouvert avec `deja: true`. */
export async function ouvrirBoss(seasonId, { now = new Date(), rng = Math.random } = {}) {
  if (seasonIdForDate(now) <= seasonId) throw new Error(`Saison ${seasonId} pas encore finie`);
  if (seasonId < PREMIERE_SAISON_BOSS) throw new Error(`Pas de Boss avant la saison ${PREMIERE_SAISON_BOSS}`);
  const existant = await lireBoss(seasonId);
  if (existant) return { boss: existant, deja: true };
  const joueurs = await listerJoueursSaison(seasonId);
  const qualifies = [];
  for (const discordId of joueurs) {
    if ((await lirePasseport(discordId, { now, seasonId })).complet) qualifies.push(discordId);
  }
  const boss = {
    seasonId,
    jeu: jeuDeSaison(seasonId),
    graine: Math.floor(rng() * 2 ** 32).toString(36),
    ouvertAt: now.toISOString(),
    clotureAt: clotureDe(seasonId).toISOString(),
    qualifies,
    cloture: false,
  };
  // NX : deux ouvertures simultanées gardent la même graine
  const pose = await getRedis().set(cleBoss(seasonId), JSON.stringify(boss), { nx: true, ex: TTL_SECONDES });
  if (!pose) return { boss: await lireBoss(seasonId), deja: true };
  return { boss, deja: false };
}

async function ecrireBoss(boss) {
  await getRedis().set(cleBoss(boss.seasonId), JSON.stringify(boss), { ex: TTL_SECONDES });
}

// ── Tentatives ────────────────────────────────────────────────────────
// Tentative : { pseudo, statut: "enCours" | "fini", debutAt, finAt,
// resultat: "victoire" | "nul" | "defaite", score, inactif? }.

export async function lireTentative(seasonId, discordId) {
  return fromJson(await getRedis().hget(cleTentatives(seasonId), discordId));
}

async function ecrireTentative(seasonId, discordId, tentative) {
  await getRedis().hset(cleTentatives(seasonId), { [discordId]: JSON.stringify(tentative) });
  await getRedis().expire(cleTentatives(seasonId), TTL_SECONDES);
}

async function lirePartie(seasonId, discordId) {
  return fromJson(await getRedis().get(clePartie(seasonId, discordId)));
}

async function ecrirePartie(seasonId, discordId, partie) {
  await getRedis().set(clePartie(seasonId, discordId), JSON.stringify(partie), { ex: TTL_SECONDES });
}

/** Ce que le joueur peut faire : « ferme » (hors semaine du Boss),
 * « nonQualifie », « disponible », « enCours » ou « fini ». */
export function statutJoueur(boss, tentative, discordId, now = new Date()) {
  if (!boss || boss.cloture || now >= new Date(boss.clotureAt)) return "ferme";
  if (!boss.qualifies.includes(discordId)) return "nonQualifie";
  if (!tentative) return "disponible";
  return tentative.statut;
}

// Fin de partie : tentative figée avec le score de la règle du jeu.
function finir(boss, tentative, etat, now, { inactif = false } = {}) {
  const regles = BOSS_JEUX[boss.jeu];
  return {
    ...tentative,
    statut: "fini",
    finAt: now.toISOString(),
    resultat: inactif ? "defaite" : regles.resultat(etat),
    score: regles.score(etat, { inactif }),
    ...(inactif ? { inactif: true } : {}),
  };
}

const estInactive = (partie, now) => now.getTime() - partie.dernierCoupAt > INACTIVITE_MS;

/** Consomme la tentative et crée la partie. Renvoie { etat, tentative } ou
 * { erreur } (« ferme », « nonQualifie », « dejaJoue »). */
export async function demarrer(boss, discordId, pseudo, { now = new Date() } = {}) {
  return withLock(cleVerrou(boss.seasonId, discordId), async () => {
    const statut = statutJoueur(boss, await lireTentative(boss.seasonId, discordId), discordId, now);
    if (statut !== "disponible") return { erreur: statut === "enCours" || statut === "fini" ? "dejaJoue" : statut };
    const tentative = { pseudo, statut: "enCours", debutAt: now.toISOString() };
    const pose = await getRedis().hsetnx(cleTentatives(boss.seasonId), discordId, JSON.stringify(tentative));
    if (!Number(pose)) return { erreur: "dejaJoue" };
    await getRedis().expire(cleTentatives(boss.seasonId), TTL_SECONDES);
    const regles = BOSS_JEUX[boss.jeu];
    const config = regles.chargerConfig ? await regles.chargerConfig() : {};
    const etat = regles.creer({ graine: boss.graine, config });
    await ecrirePartie(boss.seasonId, discordId, { etat, dernierCoupAt: now.getTime() });
    return { etat, tentative };
  });
}

/** Partie en cours ou finie du joueur : { etat, tentative } (null sans
 * tentative). Une partie inactive est perdue au passage. */
export async function lireJeu(boss, discordId, { now = new Date() } = {}) {
  return withLock(cleVerrou(boss.seasonId, discordId), async () => {
    const tentative = await lireTentative(boss.seasonId, discordId);
    if (!tentative) return null;
    const partie = await lirePartie(boss.seasonId, discordId);
    if (tentative.statut === "enCours" && partie && estInactive(partie, now)) {
      const fini = finir(boss, tentative, partie.etat, now, { inactif: true });
      await ecrireTentative(boss.seasonId, discordId, fini);
      return { etat: partie.etat, tentative: fini };
    }
    return { etat: partie?.etat ?? null, tentative };
  });
}

/** Coup du joueur (`action` propre au jeu), réponse de Kévina comprise.
 * Renvoie { etat, tentative, resultat } (`resultat` : celui de la règle du
 * jeu, `erreur` compris) ou { erreur } sans partie en cours. */
export async function jouer(boss, discordId, action, { now = new Date() } = {}) {
  return withLock(cleVerrou(boss.seasonId, discordId), async () => {
    const tentative = await lireTentative(boss.seasonId, discordId);
    const partie = await lirePartie(boss.seasonId, discordId);
    if (!tentative || !partie) return { erreur: "aucunePartie" };
    if (tentative.statut === "fini") return { etat: partie.etat, tentative, resultat: { erreur: "termine" } };
    if (estInactive(partie, now) || now >= new Date(boss.clotureAt)) {
      const fini = finir(boss, tentative, partie.etat, now, { inactif: true });
      await ecrireTentative(boss.seasonId, discordId, fini);
      return { etat: partie.etat, tentative: fini, resultat: { inactif: true } };
    }
    const regles = BOSS_JEUX[boss.jeu];
    const config = regles.chargerConfig ? await regles.chargerConfig() : {};
    const resultat = regles.jouer(partie.etat, action, { graine: boss.graine, config });
    if (resultat.erreur) return { etat: partie.etat, tentative, resultat };
    await ecrirePartie(boss.seasonId, discordId, { etat: partie.etat, dernierCoupAt: now.getTime() });
    let suite = tentative;
    if (partie.etat.termine) {
      suite = finir(boss, tentative, partie.etat, now);
      await ecrireTentative(boss.seasonId, discordId, suite);
    }
    return { etat: partie.etat, tentative: suite, resultat };
  });
}

// ── Classement et clôture ─────────────────────────────────────────────

/** Pure : tentatives finies, score décroissant puis partie la plus
 * courte (`finAt - debutAt`) ; rang partagé à score égal. */
export function classer(tentatives) {
  const finies = tentatives
    .filter((t) => t.statut === "fini")
    .map((t) => ({ ...t, duree: new Date(t.finAt) - new Date(t.debutAt) }))
    .sort((a, b) => b.score - a.score || a.duree - b.duree);
  let rang = 0;
  return finies.map((t, i) => {
    if (i === 0 || t.score !== finies[i - 1].score) rang = i + 1;
    return { ...t, rang };
  });
}

export async function listerTentatives(seasonId) {
  const ids = (await getRedis().hkeys(cleTentatives(seasonId))) ?? [];
  const tentatives = await Promise.all(ids.map(async (discordId) => ({ discordId, ...(await lireTentative(seasonId, discordId)) })));
  return tentatives.filter((t) => t.statut);
}

/** Champions d'un Boss clos, pour /mini-jeux-history : { champions:
 * [pseudo] } (premiers du classement s'ils ont vaincu Kévina, sinon liste
 * vide : Kévina invaincue). null si le Boss n'existe pas (ou plus : 120
 * jours), n'est pas clos ou n'avait aucun qualifié. */
export async function championsBoss(seasonId) {
  const boss = await lireBoss(seasonId);
  if (!boss?.cloture || !boss.qualifies?.length) return null;
  const classement = classer(await listerTentatives(seasonId));
  const champions = classement.filter((t) => t.rang === 1 && t.resultat === "victoire").map((t) => t.pseudo ?? "?");
  return { jeu: boss.jeu, champions };
}

/** Clôture (le 8) : parties encore en cours perdues, classement, compteurs
 * permanents (passeport complété pour chaque qualifié, Boss vaincu pour
 * chaque victoire). Idempotente (marqueur posé avant les compteurs).
 * Renvoie { boss, classement, deja }. */
export async function cloturerBoss(seasonId, { now = new Date() } = {}) {
  const boss = await lireBoss(seasonId);
  if (!boss) return { boss: null, classement: [], deja: false };
  const deja = !Number(await getRedis().hsetnx(cleCloture(seasonId), "fait", now.toISOString()));
  if (!deja) {
    await getRedis().expire(cleCloture(seasonId), TTL_SECONDES);
    for (const t of await listerTentatives(seasonId)) {
      if (t.statut !== "enCours") continue;
      const partie = await lirePartie(seasonId, t.discordId);
      const { discordId, ...tentative } = t;
      // Sans partie (expirée) : score minimal
      const fini = partie ? finir(boss, tentative, partie.etat, now, { inactif: true }) : { ...tentative, statut: "fini", finAt: now.toISOString(), resultat: "defaite", score: 0, inactif: true };
      await ecrireTentative(seasonId, discordId, fini);
    }
    const vainqueurs = new Set((await listerTentatives(seasonId)).filter((t) => t.resultat === "victoire").map((t) => t.discordId));
    for (const discordId of boss.qualifies) {
      await incrementerCompteurs(discordId, { passeports: 1, boss: vainqueurs.has(discordId) ? 1 : 0 });
    }
    boss.cloture = true;
    await ecrireBoss(boss);
  }
  return { boss: await lireBoss(seasonId), classement: classer(await listerTentatives(seasonId)), deja };
}
