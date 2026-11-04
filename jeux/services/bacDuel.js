// ============================================================
// bacDuel.js — Petit Bac (`/bac`) : un joueur contre Kévina
// (plateau public + vue éphémère du joueur) ou contre un autre joueur
// (`/bac adversaire:1v1`, message public + vue éphémère par joueur). Règles pures
// dans bacRules.js.
//
// Stockage : Upstash Redis. Contre Kévina : une clé par joueur
// (`bacduel:<discordId>`), plusieurs parties en même temps possibles.
// 1v1 : une seule partie à la fois (`bacduel:pvp`).
// Chaque écriture relance l'expiration : sans action pendant
// `INACTIVITE_SECONDES`, la partie disparaît. Seules les séries de
// victoires (et leurs records) sont conservées, une par mode et par
// difficulté.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Petit Bac), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { creerDuel, definirAjouts, normaliser } from "./bacRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "bac", "duel.json");

export const INACTIVITE_SECONDES = 3600;

const cleDuel = (discordId) => `bacduel:${discordId}`;
const cleVerrou = (discordId) => `bacduel:lock:${discordId}`;

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

let _configCache = null;

export async function loadDuelConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

export async function readDuel(discordId) {
  return fromJson(await getRedis().get(cleDuel(discordId)));
}

async function writeDuel(discordId, duel) {
  await getRedis().set(cleDuel(discordId), JSON.stringify(duel), { ex: INACTIVITE_SECONDES });
}

export async function supprimerDuel(discordId) {
  await getRedis().del(cleDuel(discordId));
}

// Verrou par joueur (double clic, clics rapprochés).
async function withLock(discordId, fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(cleVerrou(discordId), "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(cleVerrou(discordId));
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou de Petit Bac indisponible");
}

// Nouvelle partie contre Kévina (remplace une éventuelle partie en cours).
// `preparer(duel)` : avant l'enregistrement (réponse de Kévina). `ancien` :
// partie remplacée (ou null), pour retirer son plateau public du salon.
// `difficulte` : "normal" ou "difficile".
export async function nouveauDuel(discordId, { preparer = null, difficulte = "normal" } = {}) {
  return withLock(discordId, async () => {
    const ancien = await readDuel(discordId);
    const s = await lireSerie("bot", discordId, difficulte);
    // Partie précédente abandonnée ou remplacée : comptée comme une défaite
    await ecrireSerie("bot", discordId, difficulte, { serie: s.enCours ? 0 : s.serie, enCours: true });
    const duel = creerDuel({ now: Date.now(), difficulte });
    preparer?.(duel);
    await writeDuel(discordId, duel);
    return { duel, ancien };
  });
}

// Action du joueur sous verrou : `fn(duel)` modifie le duel (fonctions de
// bacRules.js) et renvoie un résultat. En fin de partie, la série est mise
// à jour et jointe au duel (`duel.series`). `nom` : pseudo du record.
// Renvoie { duel, resultat } ou { duel: null } sans partie en cours.
export async function agirDuel(discordId, fn, { nom = null, now = new Date() } = {}) {
  return withLock(discordId, async () => {
    const duel = await readDuel(discordId);
    if (!duel) return { duel: null };
    await chargerAjouts();
    const finiAvant = duel.termine;
    const resultat = (await fn(duel)) || {};
    if (!finiAvant && duel.termine) duel.series = await finSerieSolo(discordId, nom, duel, now);
    await writeDuel(discordId, duel);
    return { duel, resultat };
  });
}

// ── Séries de victoires ───────────────────────────────────────────────────
// Une série par joueur, par mode (contre Kévina, 1v1) et par difficulté
// (normal : clés historiques ; difficile : suffixe `:difficile`) : +1 par victoire,
// remise à 0 par une défaite, intacte sur un match nul. Contre Kévina, une
// partie abandonnée ou remplacée compte comme une défaite (`enCours` encore
// vrai au lancement suivant). Record de chaque mode et difficulté : plus
// longue série, JAMAIS effacé.

const CLE_SERIES = { bot: "bacduel:series:bot", pvp: "bacduel:series:pvp" };
const CLE_RECORDS = "bacduel:records";

// Pure : série après une partie (issue "victoire" | "defaite" | "nul").
export function serieApres(serie, issue) {
  if (issue === "victoire") return serie + 1;
  return issue === "defaite" ? 0 : serie;
}

// Pure : strictement plus longue que le record (une égalité ne détrône pas
// le détenteur), jamais une série nulle.
export function isNewRecord(actuel, serie) {
  return serie > 0 && (!actuel || serie > actuel.serie);
}

const issueDe = (gagnant, siege) => (gagnant === "nul" ? "nul" : gagnant === siege ? "victoire" : "defaite");

// Suffixe de difficulté des clés (rien en normal : séries d'avant les modes)
const sfxDifficulte = (difficulte) => (difficulte === "difficile" ? ":difficile" : "");

async function lireSerie(mode, discordId, difficulte) {
  return fromJson(await getRedis().hget(CLE_SERIES[mode] + sfxDifficulte(difficulte), discordId)) ?? { serie: 0 };
}

async function ecrireSerie(mode, discordId, difficulte, serie) {
  await getRedis().hset(CLE_SERIES[mode] + sfxDifficulte(difficulte), { [discordId]: JSON.stringify(serie) });
}

export async function lireRecord(mode, difficulte = "normal") {
  return fromJson(await getRedis().hget(CLE_RECORDS, mode + sfxDifficulte(difficulte)));
}

// Renvoie le record du mode et de la difficulté à jour (nouveau ou
// inchangé), null sans record.
async function majRecord(mode, difficulte, discordId, username, serie, now) {
  const champ = mode + sfxDifficulte(difficulte);
  return withLock(`record:${champ}`, async () => {
    const actuel = await lireRecord(mode, difficulte);
    if (!isNewRecord(actuel, serie)) return actuel;
    const record = { discordId, username: username || null, serie, at: now.toISOString() };
    await getRedis().hset(CLE_RECORDS, { [champ]: JSON.stringify(record) });
    return record;
  });
}

// Fin d'une partie contre Kévina : { avant, serie, record }.
async function finSerieSolo(discordId, nom, duel, now) {
  const { serie: avant } = await lireSerie("bot", discordId, duel.difficulte);
  const serie = serieApres(avant, issueDe(duel.gagnant, "joueur"));
  await ecrireSerie("bot", discordId, duel.difficulte, { serie, enCours: false });
  return { avant, serie, record: await majRecord("bot", duel.difficulte, discordId, nom, serie, now) };
}

// Fin d'une partie 1v1 : { joueur: { avant, serie }, bot: { … }, record }
// (sièges du moteur).
async function finSeriesPvp(partie, now) {
  const series = {};
  const { difficulte } = partie.duel;
  for (const [siege, id] of Object.entries(partie.sieges)) {
    const { serie: avant } = await lireSerie("pvp", id, difficulte);
    const serie = serieApres(avant, issueDe(partie.duel.gagnant, siege));
    await ecrireSerie("pvp", id, difficulte, { serie });
    series[siege] = { avant, serie };
  }
  const g = partie.duel.gagnant;
  series.record =
    g === "nul"
      ? await lireRecord("pvp", difficulte)
      : await majRecord("pvp", difficulte, partie.sieges[g], partie.noms[partie.sieges[g]], series[g].serie, now);
  return series;
}

// ── Mots contestés ──────────────────────────────────────────────────
// Un joueur conteste un mot refusé (« pas dans la liste ») : il reste
// refusé, mais il est noté pour vérification à la main (outil
// jeux/outils/bac/contestations.mjs, puis accepterMots()). Hash `bacduel:contestations` :
// `<thème>:<mot normalisé>` → { theme, mot, lettres, nb, joueurs, derniere }.

const CLE_CONTESTATIONS = "bacduel:contestations";

export async function enregistrerContestation({ theme, lettre, mot, pseudo, now = new Date() }) {
  return withLock("contestations", async () => {
    const champ = `${theme}:${normaliser(mot)}`;
    const avant = fromJson(await getRedis().hget(CLE_CONTESTATIONS, champ)) ?? { theme, mot, lettres: [], nb: 0, joueurs: [] };
    const apres = {
      ...avant,
      nb: avant.nb + 1,
      lettres: [...new Set([...avant.lettres, lettre])],
      joueurs: [...new Set([...avant.joueurs, pseudo ?? "?"])].slice(0, 10),
      derniere: now.toISOString(),
    };
    await getRedis().hset(CLE_CONTESTATIONS, { [champ]: JSON.stringify(apres) });
    return apres;
  });
}

// Paires [champ, valeur] d'un hash
async function lireHash(cle) {
  const h = (await getRedis().hgetall(cle)) ?? {};
  // Upstash renvoie un objet, ou une liste [champ, valeur, …] sans désérialisation
  return Array.isArray(h) ? h.reduce((a, v, i) => (i % 2 ? a : [...a, [v, h[i + 1]]]), []) : Object.entries(h);
}

export async function lireContestations() {
  return (await lireHash(CLE_CONTESTATIONS)).map(([champ, v]) => ({ champ, ...fromJson(v) }));
}

export async function viderContestations(champs) {
  if (champs.length) await getRedis().hdel(CLE_CONTESTATIONS, ...champs);
}

// ── Mots ajoutés sans redéploiement ──────────────────────────────────
// Mots contestés acceptés après vérification (outil contestations.mjs
// --accepter) : valables dès l'action suivante, sans commit ni déploiement.
// Hash `bacduel:ajouts` : `<thème>:<mot normalisé>` → mot (personnes : nom
// complet). Relu avant chaque action (agirDuel(), agirPvp()) et passé à
// bacRules.js (definirAjouts()).

const CLE_AJOUTS = "bacduel:ajouts";

// { thème: [mots] }
export async function chargerAjouts() {
  const ajouts = {};
  for (const [champ, mot] of await lireHash(CLE_AJOUTS)) (ajouts[champ.split(":")[0]] ??= []).push(mot);
  for (const l of Object.values(ajouts)) l.sort();
  definirAjouts(ajouts);
  return ajouts;
}

// `mots` : [{ theme, mot }]. Retire aussi leur contestation.
export async function accepterMots(mots) {
  if (!mots.length) return;
  const champs = mots.map(({ theme, mot }) => `${theme}:${normaliser(mot)}`);
  await getRedis().hset(CLE_AJOUTS, Object.fromEntries(champs.map((c, i) => [c, mots[i].mot])));
  await viderContestations(champs);
}

export async function retirerAjouts(champs) {
  if (champs.length) await getRedis().hdel(CLE_AJOUTS, ...champs);
}

// ── 1v1 (`/bac adversaire:1v1`) ────────────────────────────────────────────
// Partie : { statut: "lobby" | "enCours" | "fini", channelId, messageId,
// lanceur, difficulte, noms: { discordId: pseudo }, sieges: { joueur, bot } (siège du
// moteur → discordId ; "joueur" commence), duel, webhooks: { discordId:
// { url, at } } (vue éphémère de chaque joueur, rééditée après chaque coup
// adverse), dernierCoupAt, raisonFin: "jeu" (8 manches jouées) | "abandon",
// series (en fin de partie, voir finSeriesPvp()) }.

const CLE_PVP = "bacduel:pvp";
const VERROU_PVP = "pvp";

export async function readPvp() {
  return fromJson(await getRedis().get(CLE_PVP));
}

async function writePvp(partie) {
  await getRedis().set(CLE_PVP, JSON.stringify(partie), { ex: INACTIVITE_SECONDES });
}

// Siège d'un joueur dans la partie (null s'il n'y joue pas).
export function siegeDe(partie, discordId) {
  if (!partie?.sieges) return null;
  return Object.keys(partie.sieges).find((s) => partie.sieges[s] === discordId) ?? null;
}

// Partie 1v1 sans action depuis INACTIVITE_PVP_MS : abandonnée, remplacée
// par le prochain `/bac adversaire:1v1` (séries inchangées).
export const INACTIVITE_PVP_MS = 5 * 60_000;
export const pvpAbandonnee = (partie, now = Date.now()) => partie.statut === "enCours" && now - partie.dernierCoupAt > INACTIVITE_PVP_MS;

// Ouvre une partie (lobby) ; refusée si une autre est en cours. Un lobby
// sans adversaire depuis 1 minute (ou relancé par son lanceur) et une
// partie abandonnée sont remplacés : `ancienne` est renvoyée pour supprimer
// son message public.
export async function ouvrirPvp({ channelId, lanceur, nom, difficulte = "normal" }) {
  return withLock(VERROU_PVP, async () => {
    const enCours = await readPvp();
    const lobbyLibre = enCours?.statut === "lobby" && (enCours.lanceur === lanceur || Date.now() - enCours.dernierCoupAt > 60_000);
    if (enCours && enCours.statut !== "fini" && !lobbyLibre && !pvpAbandonnee(enCours)) return { dejaEnCours: enCours };
    const ancienne = enCours && enCours.statut !== "fini" ? enCours : null;
    const partie = {
      statut: "lobby",
      channelId,
      messageId: null,
      lanceur,
      difficulte,
      noms: { [lanceur]: nom },
      sieges: null,
      duel: null,
      webhooks: {},
      dernierCoupAt: Date.now(),
      raisonFin: null,
    };
    await writePvp(partie);
    return { partie, ancienne };
  });
}

export async function enregistrerMessagePvp(messageId) {
  return withLock(VERROU_PVP, async () => {
    const partie = await readPvp();
    if (!partie) return;
    partie.messageId = messageId;
    await writePvp(partie);
  });
}

// Action sous verrou : `fn(partie, config)` modifie la partie et renvoie un
// résultat. Une action (`resultat.coup`) note l'heure (`dernierCoupAt`,
// inactivité).
// Renvoie { partie, config, resultat } ou { partie: null }.
export async function agirPvp(fn) {
  const config = await loadDuelConfig();
  return withLock(VERROU_PVP, async () => {
    const partie = await readPvp();
    if (!partie) return { partie: null, config };
    await chargerAjouts();
    const finiAvant = partie.statut === "fini";
    const resultat = (await fn(partie, config)) || {};
    if (resultat.coup) partie.dernierCoupAt = Date.now();
    if (partie.statut === "enCours" && partie.duel?.termine) {
      partie.statut = "fini";
      partie.raisonFin ??= "jeu";
    }
    resultat.vientDeFinir = !finiAvant && partie.statut === "fini";
    if (resultat.vientDeFinir) partie.series = await finSeriesPvp(partie, new Date());
    await writePvp(partie);
    return { partie, config, resultat };
  });
}

// Le second joueur prend place (sièges tirés au sort), la partie commence.
export function rejoindrePvp(partie, discordId, nom, { rng = Math.random } = {}) {
  partie.noms[discordId] = nom;
  const [premier, second] = rng() < 0.5 ? [partie.lanceur, discordId] : [discordId, partie.lanceur];
  partie.sieges = { joueur: premier, bot: second };
  partie.duel = creerDuel({ pvp: true, now: Date.now(), difficulte: partie.difficulte ?? "normal" });
  partie.statut = "enCours";
  partie.dernierCoupAt = Date.now();
}
