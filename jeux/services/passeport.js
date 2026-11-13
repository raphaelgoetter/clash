// ============================================================
// passeport.js — Passeport mensuel des mini-jeux (bouton « 🛂 Mon
// passeport » de /mini-jeux) : registre de ce que chaque joueur a fait dans
// le mois et calcul de ses tampons.
//
// Le mois est celui de l'action (`seasonIdForDate(now)`, heure de Paris),
// pas celui de la manche : une manche publiée fin novembre et jouée le
// 2 décembre compte pour décembre.
//
// Les écritures ne lèvent jamais : un incident Redis ne doit pas casser le
// jeu qui les appelle.
// ============================================================

import { Redis } from "@upstash/redis";
import { seasonIdForDate } from "./saison.js";

// Conservation des registres : la saison, le Boss du mois suivant, et une
// marge pour les consultations.
const TTL_SECONDES = 120 * 24 * 3600;

// Tampons du mois.
export const OBJECTIFS = { jeux: 4, manches: 10, kevina: 2 };
// Objectifs allégés d'une saison : novembre 2026, entamé quand le
// passeport est arrivé.
const OBJECTIFS_ALLEGES = { 138: { jeux: 3, manches: 5, kevina: 1 } };

/** Pure : objectifs des tampons de la saison `seasonId`. */
export function objectifsDe(seasonId) {
  return { ...OBJECTIFS, ...OBJECTIFS_ALLEGES[seasonId] };
}

// Quête du mois (5e tampon) : gagner un duel du jeu du mois, contre Kévina
// ou en 1v1. Rotation dans cet ordre, novembre 2026 (saison 138) = Frise.
// Seulement des duels où la victoire est nette (pas Blackjack ni Gobelet en
// solo) ; Pendu : 1v1 seulement (le solo n'oppose personne).
export const QUETES_DU_MOIS = [
  { jeu: "frise", libelle: "Gagner un duel de Frise (/frise)" },
  { jeu: "punto", libelle: "Gagner un duel de Punto (/punto)" },
  { jeu: "quatre", libelle: "Gagner un duel de Quatre à la suite (/quatre)" },
  { jeu: "grille", libelle: "Gagner un duel de La Grille (/grille)" },
  { jeu: "mascarade", libelle: "Gagner un duel de Mascarade (/mascarade)" },
  { jeu: "potato", libelle: "Gagner un duel de Potato (/potato)" },
  { jeu: "bac", libelle: "Gagner un duel de Petit Bac (/bac)" },
  { jeu: "pendu", libelle: "Gagner un duel de Pendu en 1v1 (/pendu)" },
];
const SAISON_PREMIERE_QUETE = 138;

/** Pure : quête du mois de la saison `seasonId`. */
export function queteDuMois(seasonId) {
  const n = QUETES_DU_MOIS.length;
  return QUETES_DU_MOIS[(((seasonId - SAISON_PREMIERE_QUETE) % n) + n) % n];
}

const cleManches = (seasonId, discordId) => `passeport:${seasonId}:${discordId}:manches`;
const cleDuels = (seasonId, discordId) => `passeport:${seasonId}:${discordId}:duels`;
const cleSpeciauxJoueur = (seasonId, discordId) => `passeport:${seasonId}:${discordId}:speciaux`;
// Jeux spéciaux ayant eu au moins un participant dans le mois.
const cleSpeciauxMois = (seasonId) => `passeport:${seasonId}:speciaux`;
// Joueurs ayant au moins une entrée dans le mois (qualifiés du Boss).
const cleJoueursMois = (seasonId) => `passeport:${seasonId}:joueurs`;
// Compteurs permanents (jamais effacés) : discordId → { passeports, boss }.
const CLE_COMPTEURS = "passeport:compteurs";

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

async function indexer(seasonId, discordId) {
  await getRedis().sadd(cleJoueursMois(seasonId), discordId);
  await getRedis().expire(cleJoueursMois(seasonId), TTL_SECONDES);
}

async function sansErreur(libelle, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[Passeport] ${libelle}:`, err);
  }
}

/** Interaction d'un joueur avec une manche d'un mini-jeu hebdomadaire
 * (tentative, indice, réponse). Idempotent : une manche compte une fois. */
export async function noterManche(discordId, jeu, gameId, now = new Date()) {
  if (!discordId || !jeu || gameId == null) return;
  await sansErreur("noterManche", async () => {
    const seasonId = seasonIdForDate(now);
    const cle = cleManches(seasonId, discordId);
    await getRedis().sadd(cle, `${jeu}:${gameId}`);
    await getRedis().expire(cle, TTL_SECONDES);
    await indexer(seasonId, discordId);
  });
}

/** Victoire d'un joueur en duel. `mode` : "bot" (contre Kévina) ou "pvp". */
export async function noterVictoireDuel(discordId, jeu, mode, now = new Date()) {
  if (!discordId || !jeu || (mode !== "bot" && mode !== "pvp")) return;
  await sansErreur("noterVictoireDuel", async () => {
    const seasonId = seasonIdForDate(now);
    const cle = cleDuels(seasonId, discordId);
    await getRedis().hincrby(cle, mode, 1);
    await getRedis().hincrby(cle, `${mode}:${jeu}`, 1);
    await getRedis().expire(cle, TTL_SECONDES);
    await indexer(seasonId, discordId);
  });
}

/** Participation d'un joueur à un jeu spécial (vote, main, action…). */
export async function noterJeuSpecial(discordId, jeu, now = new Date()) {
  if (!discordId || !jeu) return;
  await sansErreur("noterJeuSpecial", async () => {
    const seasonId = seasonIdForDate(now);
    const cleJoueur = cleSpeciauxJoueur(seasonId, discordId);
    await getRedis().sadd(cleJoueur, jeu);
    await getRedis().expire(cleJoueur, TTL_SECONDES);
    await getRedis().sadd(cleSpeciauxMois(seasonId), jeu);
    await getRedis().expire(cleSpeciauxMois(seasonId), TTL_SECONDES);
    await indexer(seasonId, discordId);
  });
}

/** Pure : tampons d'un registre. `moisTermine` : sans jeu spécial dans le
 * mois, le tampon « jeu spécial » n'est validé d'office qu'une fois le mois
 * fini (un jeu peut encore commencer). */
export function calculerTampons({ objectifs = OBJECTIFS, manches, victoiresKevina, victoiresQuete, quete, speciauxJoueur, speciauxMois, moisTermine }) {
  const jeux = new Set(manches.map((m) => m.split(":")[0]));
  const aucunSpecial = speciauxMois.length === 0;
  return [
    {
      cle: "jeux",
      libelle: `Jouer à ${objectifs.jeux} mini-jeux différents`,
      valeur: jeux.size,
      objectif: objectifs.jeux,
      valide: jeux.size >= objectifs.jeux,
    },
    {
      cle: "manches",
      libelle: `Jouer ${objectifs.manches} manches de mini-jeux`,
      valeur: manches.length,
      objectif: objectifs.manches,
      valide: manches.length >= objectifs.manches,
    },
    {
      cle: "kevina",
      libelle: `Battre Kévina ${objectifs.kevina} fois en duel`,
      valeur: victoiresKevina,
      objectif: objectifs.kevina,
      valide: victoiresKevina >= objectifs.kevina,
    },
    {
      cle: "special",
      libelle: "Participer à un jeu spécial",
      valeur: null,
      objectif: null,
      valide: speciauxJoueur.length > 0 || (aucunSpecial && moisTermine),
    },
    {
      cle: "quete",
      libelle: `Quête du mois : ${quete.libelle}`,
      valeur: null,
      objectif: null,
      valide: victoiresQuete > 0,
    },
  ];
}

/** Registre et tampons d'un joueur pour la saison `seasonId` (par défaut
 * celle de `now`). */
export async function lirePasseport(discordId, { now = new Date(), seasonId = seasonIdForDate(now) } = {}) {
  const redis = getRedis();
  const quete = queteDuMois(seasonId);
  const [manches, victoires, queteBot, quetePvp, speciauxJoueur, speciauxMois] = await Promise.all([
    redis.smembers(cleManches(seasonId, discordId)),
    redis.hget(cleDuels(seasonId, discordId), "bot"),
    redis.hget(cleDuels(seasonId, discordId), `bot:${quete.jeu}`),
    redis.hget(cleDuels(seasonId, discordId), `pvp:${quete.jeu}`),
    redis.smembers(cleSpeciauxJoueur(seasonId, discordId)),
    redis.smembers(cleSpeciauxMois(seasonId)),
  ]);
  const tampons = calculerTampons({
    objectifs: objectifsDe(seasonId),
    manches: manches ?? [],
    victoiresKevina: Number(victoires) || 0,
    victoiresQuete: (Number(queteBot) || 0) + (Number(quetePvp) || 0),
    quete,
    speciauxJoueur: speciauxJoueur ?? [],
    speciauxMois: speciauxMois ?? [],
    moisTermine: seasonIdForDate(now) > seasonId,
  });
  return { seasonId, quete, tampons, complet: tampons.every((t) => t.valide) };
}

/** Joueurs ayant au moins une entrée au passeport de la saison. */
export async function listerJoueursSaison(seasonId) {
  return (await getRedis().smembers(cleJoueursMois(seasonId))) ?? [];
}

/** Compteurs permanents d'un joueur : { passeports, boss }. */
export async function lireCompteurs(discordId) {
  const raw = await getRedis().hget(CLE_COMPTEURS, discordId);
  let c = null;
  try {
    c = raw ? JSON.parse(raw) : null;
  } catch {
    c = null;
  }
  return { passeports: c?.passeports ?? 0, boss: c?.boss ?? 0 };
}

/** Ajoute aux compteurs permanents (clôture du Boss, boss.js). */
export async function incrementerCompteurs(discordId, { passeports = 0, boss = 0 }) {
  const c = await lireCompteurs(discordId);
  const suite = { passeports: c.passeports + passeports, boss: c.boss + boss };
  await getRedis().hset(CLE_COMPTEURS, { [discordId]: JSON.stringify(suite) });
  return suite;
}
