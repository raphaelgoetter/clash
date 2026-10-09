// ============================================================
// marioclash.js — Mario Clash, course communautaire façon Mario Kart sur
// plateau à 49 cases, départ case 0 et arrivée case 48 (thème Clash Royale). Couche métier : config statique,
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
// 2) objets appliqués (Accélérateur/Bombe/Banane, puis Carapace bleue) 3) sorts. L'Étoile
// protège ainsi contre TOUT le reste de la journée : elle RENVOIE les
// objets adverses (l'attaquant recule) et bloque les sorts (y compris un
// sort qu'on se lancerait à soi-même).
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
const NARRATIFS_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "marioclash", "narratifs.json");

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

let _narratifsCache = null;

export async function loadNarratifs() {
  if (_narratifsCache) return _narratifsCache;
  const raw = await fs.readFile(NARRATIFS_JSON_PATH, "utf8");
  _narratifsCache = JSON.parse(raw);
  return _narratifsCache;
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
  // colorIndex figé à la création, par ordre d'arrivée (jamais un hash sur
  // discordId — voir marioclashImage.js pour le pourquoi : un hash fait
  // collision entre deux joueurs bien avant d'épuiser la palette).
  // L'index reste stable toute la manche, même si d'autres joueurs
  // rejoignent ensuite.
  const colorIndex = Object.keys(await readJoueurs()).length;
  const fresh = { username: username || "?", position: 0, points: 0, objet: null, dernierAchatJour: null, colorIndex };
  await writeJoueur(discordId, fresh);
  return fresh;
}

// ── Ligne d'arrivée ──────────────────────────────────────────────────
// Un joueur qui atteint la case d'arrivée a TERMINÉ sa course : il ne joue
// plus (dé, sort, boutique refusés), n'est plus ciblable (objets, Carapace,
// échange aléatoire) et plus aucun effet ne modifie sa position. Son jour
// d'arrivée (`arriveJour`) fixe son rang : premier arrivé = vainqueur.
export function estArrive(joueur, config) {
  return config?.case_arrivee != null && (joueur?.position ?? 0) >= config.case_arrivee;
}

// ── Boutique — résolution immédiate au clic ─────────────────────────
// Pas de clôture différée : achat individuel, sans interaction avec
// d'autres joueurs (contrairement au dé/objet/sort, voir en-tête).

export async function purchaseItem(discordId, username, itemId, jour, config) {
  const item = config.objets[itemId];
  if (!item) return { status: "unknownItem" };
  const joueur = await ensureJoueur(discordId, username);
  if (estArrive(joueur, config)) return { status: "arrived", joueur };
  // Achat et activation ne font plus qu'un (voir handleBoutiqueSelect) :
  // l'objet acheté est toujours mis en file pour la clôture du jour même,
  // donc "un seul objet à la fois" n'a plus lieu d'être vérifié ici — seul
  // le cap "un objet par jour" reste pertinent.
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
  return sorts[Math.floor(rng() * sorts.length)] || sorts[0];
}

// ── Concentration — chaque jour SANS sort charge la jauge du joueur
// (config.concentration_max, 2), incrémentée à la clôture ; le sort
// suivant est tiré sans les effets dont `retire_concentration` <= niveau
// (Gel au niveau 1, puis Recul au niveau 2), et remet la jauge à 0.
// Équilibrage : attendre ne rapporte quasiment rien de plus en moyenne par
// jour, mais réduit le risque (voir règles).
// `retire` : sort sorti du jeu, plus jamais tiré, mais gardé dans la config
// pour appliquer à la clôture ceux déjà lancés avant le changement.
export function sortsDisponibles(sorts, niveau = 0) {
  return sorts.filter((s) => !s.retire && (!s.retire_concentration || s.retire_concentration > niveau));
}

// Parmi `candidats` ([id, ecart] avec ecart ≠ 0), ceux à `portee` cases
// d'écart au plus ; si personne n'est à portée, le périmètre s'élargit au(x)
// plus proche(s) hors portée (ex aequo inclus).
function dansPorteeOuPlusProches(candidats, portee) {
  const dansPortee = candidats.filter(([, ecart]) => Math.abs(ecart) <= portee);
  if (dansPortee.length || !candidats.length) return dansPortee;
  const min = Math.min(...candidats.map(([, ecart]) => Math.abs(ecart)));
  return candidats.filter(([, ecart]) => Math.abs(ecart) === min);
}

// Adversaires ciblables par un objet "adversaire". Avec `portee` (Banane),
// seuls les joueurs situés devant soi, à `portee` cases au plus, sont
// éligibles (élargi au prochain joueur devant si personne n'est à portée)
// — évaluée sur les positions au moment du choix, pas à la clôture.
// Joueurs arrivés exclus (protégés, voir estArrive()).
export function ciblesObjet(joueurs, discordId, item, config) {
  const posJoueur = joueurs[discordId]?.position ?? 0;
  const autres = Object.entries(joueurs).filter(([id, j]) => id !== discordId && !estArrive(j, config));
  const nom = (id) => joueurs[id].username;
  if (item.portee == null) return autres.map(([id]) => ({ discordId: id, username: nom(id) }));
  const devant = autres
    .map(([id, j]) => [id, (j.position ?? 0) - posJoueur])
    .filter(([, ecart]) => ecart > 0);
  return dansPorteeOuPlusProches(devant, item.portee).map(([id]) => ({ discordId: id, username: nom(id) }));
}

// Partenaires possibles du sort d'échange aléatoire : avec `portee`, joueurs
// à `portee` cases d'écart au plus, devant OU derrière (même case exclue,
// l'échange n'y changerait rien), élargi au(x) plus proche(s) sinon.
// Joueurs arrivés exclus (protégés, voir estArrive()).
export function partenairesEchange(joueurs, targetId, portee, config) {
  const autres = Object.keys(joueurs).filter((id) => id !== targetId && !estArrive(joueurs[id], config));
  if (portee == null) return autres;
  const posCible = joueurs[targetId]?.position ?? 0;
  const candidats = autres
    .map((id) => [id, (joueurs[id].position ?? 0) - posCible])
    .filter(([, ecart]) => ecart !== 0);
  return dansPorteeOuPlusProches(candidats, portee).map(([id]) => id);
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
//
// ⚠️ L'Or quotidien n'est PAS un octroi automatique (décision explicite,
// revenue sur la conception initiale) : il faut lancer le dé pour le
// gagner — jamais deux fois le même jour, comme le reste de l'action.
//
// Le joueur CHOISIT son dé (config.des : classique / prudent / épargne) :
// arbitrage avancer vs Or, et précision pour viser ou éviter une case
// spéciale.
// `faces` : dé à faces explicites (Dé Farceur : 0 ou 7), sinon min..max.
export function rollDieOfType(de, rng = Math.random) {
  if (Array.isArray(de.faces)) return de.faces[Math.floor(rng() * de.faces.length)];
  return de.min + Math.floor(rng() * (de.max - de.min + 1));
}

// Cases spéciales (config.cases_speciales, calquées sur les cases
// illustrées du plateau) : déclenchées UNIQUEMENT quand le dé y arrête le
// joueur — jamais par un objet/sort à la clôture (le dé est le seul
// déplacement que le joueur maîtrise). Pas d'enchaînement : la case
// d'arrivée d'un Turbo/Feu n'est pas réévaluée.
export function applyCaseSpeciale(position, points, config) {
  const caseSpeciale = config.cases_speciales?.[position] || null;
  if (!caseSpeciale) return { position, points, caseSpeciale: null };
  return {
    position: clampPosition(position + (caseSpeciale.avance || 0), config.case_arrivee),
    points: Math.max(0, points + (caseSpeciale.or || 0)),
    caseSpeciale,
  };
}

export async function rollDiceForPlayer(jour, discordId, deId, config, rng = Math.random) {
  const actions = await readActions(jour);
  if (actions[discordId]?.dice) return { status: "alreadyRolled" };
  const joueur = await readJoueur(discordId);
  if (!joueur) return { status: "unknownPlayer" };
  if (estArrive(joueur, config)) return { status: "arrived" };
  // Dé imposé par le sort de la veille (Dé Farceur) : remplace le dé choisi.
  // Un dé `reserve_sort` ne peut jamais être choisi librement.
  if (joueur.deImpose && config.des[joueur.deImpose]) deId = joueur.deImpose;
  else if (config.des[deId]?.reserve_sort) return { status: "unknownDie" };
  const de = config.des[deId];
  if (!de) return { status: "unknownDie" };
  // Gel/Rage/dé imposé : posés par le sort de la veille (voir
  // computeCloture), valables pour le dé de ce jour uniquement. Gel : 1 case
  // quel que soit le dé (l'Or du dé reste acquis). Rage : bonus ajouté au
  // résultat. Un seul sort par jour : jamais cumulés.
  const valeur = rollDieOfType(de, rng);
  const avance = joueur.gel ? 1 : valeur + (joueur.rage || 0);
  const positionDe = clampPosition(joueur.position + avance, config.case_arrivee);
  // Sur place (0 au Dé Farceur) : la case où l'on se trouve déjà ne se
  // redéclenche pas.
  const { position, points, caseSpeciale } =
    avance > 0
      ? applyCaseSpeciale(positionDe, joueur.points + de.or, config)
      : { position: positionDe, points: joueur.points + de.or, caseSpeciale: null };
  const arriveJour = position >= config.case_arrivee ? jour : null;
  await writeJoueur(discordId, { ...joueur, position, points, gel: false, rage: 0, deImpose: null, arriveJour });
  // Détail du lancer conservé pour le bilan du Journal (voir computeCloture) :
  // le dé est résolu ici, mais n'apparaîtrait sinon nulle part après coup.
  await updateAction(jour, discordId, {
    dice: true,
    diceValue: valeur,
    diceAvance: avance,
    deId,
    positionDe,
    caseSpeciale: caseSpeciale ? positionDe : null,
  });
  return {
    status: "ok", de, valeur, avance, gel: !!joueur.gel, rage: joueur.rage || 0,
    positionAvant: joueur.position, positionDe, position, pointsGagnes: de.or, points, caseSpeciale,
  };
}

// ── Sort — toujours sur SOI-MÊME (décision explicite : un sort ne doit
// jamais infliger un effet négatif à un adversaire qui n'a rien demandé),
// effet tiré au sort DÈS LE CLIC et annoncé immédiatement ; seule
// l'APPLICATION (déplacement, blocage éventuel par l'Étoile si on est
// devenu immunisé entre-temps) reste différée à la clôture, dans l'ordre
// de résolution documenté en tête de fichier. Aucun choix du joueur sur
// l'effet (voir data/marioclash/marioclash.json), seul levier : ne PAS
// lancer pour charger la Concentration — seul l'échange aléatoire implique
// un second joueur, tiré au sort à la clôture parmi tous les participants
// (voir plus bas).
export async function castSpellForPlayer(jour, discordId, config, rng = Math.random) {
  const actions = await readActions(jour);
  if (actions[discordId]?.spell) return { status: "alreadyCast" };
  const joueurs = await readJoueurs();
  const joueur = joueurs[discordId];
  if (!joueur) return { status: "unknownPlayer" };
  if (estArrive(joueur, config)) return { status: "arrived" };
  const concentration = joueur.concentration || 0;
  const sort = rollSort(sortsDisponibles(config.sorts, concentration), rng);
  await writeJoueur(discordId, { ...joueur, concentration: 0 });
  await updateAction(jour, discordId, { spell: { target: discordId, sortId: sort.id, concentration } });
  return { status: "ok", target: discordId, sort, concentration };
}

// `actionsRaw`/`joueursAvant` : objets { discordId: {...} }, déjà
// désérialisés (aucun I/O ici). Retourne { joueursApres, lignes,
// immunises } — `lignes` est une liste de faits bruts (pas de texte
// narratif, voir handler pour la mise en forme Discord).
export function computeCloture({ actionsRaw, joueursAvant, config, jour = null, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j };
  const lignes = [];

  // 0) Lancers de dé du jour — DÉJÀ appliqués au clic (rollDiceForPlayer),
  // simplement rapportés ici pour le bilan personnel du Journal.
  for (const [id, action] of Object.entries(actionsRaw)) {
    if (!joueurs[id] || !action.dice) continue;
    lignes.push({
      type: "de",
      discordId: id,
      deId: action.deId || null,
      valeur: action.diceValue,
      avance: action.diceAvance ?? action.diceValue,
      positionDe: action.positionDe ?? null,
      caseSpeciale: action.caseSpeciale ?? null,
    });
  }

  // Gel/Rage posés hier ne valaient que pour le dé d'aujourd'hui (déjà
  // consommés au clic s'il a été lancé) : on les purge AVANT les sorts du
  // jour, qui peuvent en poser de nouveaux pour demain. Même passe : la
  // jauge de Concentration monte pour qui n'a pas lancé de sort aujourd'hui
  // (celle des lanceurs a déjà été remise à 0 au clic).
  for (const [id, joueur] of Object.entries(joueurs)) {
    joueur.gel = false;
    joueur.rage = 0;
    joueur.deImpose = null;
    if (!actionsRaw[id]?.spell) {
      joueur.concentration = Math.min(config.concentration_max ?? 0, (joueur.concentration || 0) + 1);
    }
  }

  // 1) Objets déjà actifs ce jour → immunité (Étoile).
  const immunises = new Set();
  for (const [id, action] of Object.entries(actionsRaw)) {
    const joueur = joueurs[id];
    if (!joueur || !action.item || !joueur.objet) continue;
    if (config.objets[joueur.objet]?.invincible) immunises.add(id);
  }

  // 2) Sorts — AVANT les objets : l'objet (choix délibéré, payé) a le
  // dernier mot sur le sort (aléatoire). Cible et effet déjà tirés au clic
  // (castSpellForPlayer), on se contente ici de les APPLIQUER (ou de les
  // bloquer si la cible est immunisée) : jamais un second tirage.
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
    // Arrivé entre le lancer du sort et la clôture (dé du jour) : sort
    // sans effet, sa course est terminée.
    if (estArrive(cible, config)) {
      lignes.push({ type: "sort", discordId: id, effet: "arrivee", cibleId: targetId });
      continue;
    }
    const sort = config.sorts.find((s) => s.id === action.spell.sortId) || rollSort(sortsDisponibles(config.sorts), rng);
    if (sort.avance) {
      cible.position = clampPosition(cible.position + sort.avance, config.case_arrivee);
    }
    if (sort.perdOr) {
      cible.points = Math.max(0, cible.points - sort.perdOr);
    }
    if (sort.pointsBoutique) {
      cible.points += sort.pointsBoutique;
    }
    if (sort.gel) cible.gel = true;
    if (sort.rage) cible.rage = sort.rage;
    if (sort.de_impose) cible.deImpose = sort.de_impose;
    // Clone : rejoue le déplacement du dé du jour (bonus Rage/Gel compris),
    // sans case spéciale (déclenchées par le dé seul). Sans dé : sans effet.
    let valeurClone = null;
    if (sort.clone) {
      valeurClone = actionsRaw[targetId]?.diceAvance ?? actionsRaw[targetId]?.diceValue ?? 0;
      cible.position = clampPosition(cible.position + valeurClone, config.case_arrivee);
    }
    let autreEchangeId = null;
    if (sort.echangeAleatoire) {
      const autres = partenairesEchange(joueurs, targetId, sort.portee, config);
      if (autres.length) {
        autreEchangeId = autres[Math.floor(rng() * autres.length)];
        const posCible = cible.position;
        cible.position = joueurs[autreEchangeId].position;
        joueurs[autreEchangeId].position = posCible;
      }
    }
    lignes.push({ type: "sort", discordId: id, cibleId: targetId, sortId: sort.id, sortLabel: sort.label, autreEchangeId, valeurClone });
  }
  // 3) Objets appliqués (hors Étoile, déjà traitée ci-dessus), après les sorts.
  // Carapaces bleues (cible "leader") résolues APRÈS tous les autres objets,
  // sur le classement de ce moment-là (une Banane qui fait passer quelqu'un
  // en tête détourne donc la Carapace vers lui) — classement figé une seule
  // fois pour toutes les Carapaces du jour, sinon leur effet dépendrait de
  // l'ordre (arbitraire) des actions. Jamais le lanceur (s'il mène, elle
  // frappe son poursuivant) ; à égalité, départage par pseudo, même ordre
  // que le classement affiché.
  const estCarapace = ([id]) => config.objets[joueurs[id]?.objet]?.cible === "leader";
  const actionsOrdonnees = [
    ...Object.entries(actionsRaw).filter((e) => !estCarapace(e)),
    ...Object.entries(actionsRaw).filter(estCarapace),
  ];
  let classementCarapace = null;
  const leaderHorsDe = (id) => {
    classementCarapace ??= Object.entries(joueurs)
      .filter(([, j]) => !estArrive(j, config))
      .map(([jid, j]) => ({ id: jid, position: j.position, username: j.username || "" }))
      .sort((x, y) => y.position - x.position || x.username.localeCompare(y.username));
    return classementCarapace.find((j) => j.id !== id)?.id || null;
  };
  for (const [id, action] of actionsOrdonnees) {
    const joueur = joueurs[id];
    if (!joueur || !action.item || !joueur.objet) continue;
    const itemId = joueur.objet;
    const item = config.objets[itemId];
    if (!item || item.invincible) {
      if (item?.invincible) joueur.objet = null; // Étoile consommée telle quelle
      continue;
    }
    // Objet acheté avant d'avoir franchi l'arrivée (dé du jour) : course
    // terminée, objet annulé et remboursé.
    if (estArrive(joueur, config)) {
      joueur.points += item.cout || 0;
      lignes.push({ type: "objet", discordId: id, itemId, effet: "arrivee", valeur: item.cout || 0 });
      joueur.objet = null;
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
    // cible === "adversaire" (choisie à l'achat) ou "leader" (automatique)
    const targetId = item.cible === "leader" ? leaderHorsDe(id) : action.item.target;
    const cible = targetId ? joueurs[targetId] : null;
    if (!cible) { joueur.objet = null; continue; }
    // Cible arrivée depuis l'achat (dé du jour ou effet antérieur de la
    // clôture) : protégée, objet remboursé.
    if (estArrive(cible, config)) {
      joueur.points += item.cout || 0;
      lignes.push({ type: "objet", discordId: id, itemId, effet: "arrivee", cibleId: targetId, valeur: item.cout || 0 });
      joueur.objet = null;
      continue;
    }
    // L'Étoile RENVOIE l'objet : l'attaquant recule à la place de sa cible
    // (dissuasion, les achats du jour restent cachés jusqu'au bilan). Le
    // renvoi ne peut pas lui-même être bloqué : l'attaquant a acheté cet
    // objet-ci, il ne peut pas avoir d'Étoile active le même jour.
    if (immunises.has(targetId)) {
      const recul = item.recul_renvoi ?? item.recul ?? 0;
      joueur.position = clampPosition(joueur.position - recul, config.case_arrivee);
      lignes.push({ type: "objet", discordId: id, itemId, effet: "renvoi", cibleId: targetId, valeur: recul });
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

  // Objet acheté mais jamais activé (Bombe/Banane dont le select de cible a
  // été abandonné : l'Or est débité à l'achat, la cible choisie ensuite) :
  // remboursé et retiré, sinon il bloquerait la boutique les jours suivants.
  for (const [id, joueur] of Object.entries(joueurs)) {
    if (!joueur.objet || actionsRaw[id]?.item) continue;
    const cout = config.objets[joueur.objet]?.cout || 0;
    joueur.points += cout;
    lignes.push({ type: "objet", discordId: id, itemId: joueur.objet, effet: "rembourse", valeur: cout });
    joueur.objet = null;
  }

  // Le dé n'est plus résolu ici : action individuelle sans interaction avec
  // les autres joueurs, elle est résolue EN DIRECT au clic (voir
  // rollDiceForPlayer()) — même principe que la boutique.

  // Arrivées par sort/objet du jour : datées du jour clôturé.
  for (const joueur of Object.values(joueurs)) {
    if (estArrive(joueur, config) && joueur.arriveJour == null) joueur.arriveJour = jour;
  }

  return { joueursApres: joueurs, lignes, immunises: [...immunises] };
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run
// de postMarioClash.js, pour prévisualiser le bilan du jour actif ET l'état
// du jour suivant sans clôturer réellement. Même principe que
// previewCloture() de bossraid.js.
export async function previewCloture(jour, config) {
  const [actionsRaw, joueursAvant] = await Promise.all([readActions(jour), readJoueurs()]);
  const { joueursApres, lignes, immunises } = computeCloture({ actionsRaw, joueursAvant, config, jour });
  const jourSuivant = jour + 1;
  if (jourSuivant > config.duree_jours) {
    return { termine: true, joueurs: joueursApres, joueursAvant, lignes, immunises };
  }
  return { termine: false, jourSuivant, joueurs: joueursApres, joueursAvant, lignes, immunises };
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
  const { joueursApres, lignes, immunises } = computeCloture({ actionsRaw, joueursAvant, config, jour });

  // Instantané des positions/Or après clôture : permet de retracer le
  // parcours exact de chaque joueur jour après jour (récit de fin de course).
  const positions = Object.fromEntries(
    Object.entries(joueursApres).map(([id, j]) => [id, { position: j.position, points: j.points }]),
  );
  await writeHistoriqueEntry(jour, { lignes, immunises, positions, resolvedAt: new Date().toISOString() });
  await clearActions(jour);

  for (const [id, j] of Object.entries(joueursApres)) {
    await writeJoueur(id, j);
  }

  const jourSuivant = jour + 1;
  if (jourSuivant > config.duree_jours) {
    return { termine: true, joueurs: joueursApres, joueursAvant, lignes };
  }
  return { termine: false, jourSuivant, joueurs: joueursApres, joueursAvant, lignes };
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
