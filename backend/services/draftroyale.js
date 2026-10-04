// ============================================================
// draftroyale.js — Draft Royale, jeu spécial de 7 jours : chaque joueur
// construit un deck de 8 cartes qui marque des points de synergie (thèmes,
// bonus de deck, majorités de rareté, contrat, popularité). Couche métier :
// config statique, catalogue, règles PURES (score, vœux, clôture), état de
// la partie, actions quotidiennes, historique, manches.
//
// Stockage : Upstash Redis (mêmes conventions que marioclash.js) — espace
// de clés `draftroyale:*`.
//
// Trois actions par jour, une fois chacune :
//   - Piocher : résolue EN DIRECT au clic (action individuelle, comme le dé
//     de Mario Clash) — jamais une carte déjà en main ni la carte déposée
//     en attente de retour.
//   - Marché : dépôt d'une carte (J1 à J6, facultatif, retirée de la main
//     tout de suite) et, le lendemain d'un dépôt, jusqu'à 3 vœux classés sur
//     le marché de la veille. Les vœux se résolvent UNE SEULE FOIS à la
//     clôture (computeCloture, fonction pure, `rng` injectable) : chaque
//     carte déposée peut être prise par `copies_par_depot` joueurs, servis
//     par popularité décroissante puis au hasard. Sans vœu obtenu, le joueur
//     récupère sa propre carte. Résolution différée (et non au premier
//     clic) : l'heure de connexion ne doit donner aucun avantage.
//   - Contrat : objectif de thème secret (J1 à J4), bonus = points du palier
//     × (multiplicateur du jour de signature − 1), rien en cas d'échec.
//
// ⚠️ Toute modification de barème doit suivre CONTRIBUTING.md (section
// Draft Royale), source de vérité des formules.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { filterCardPool, RARITIES } from "./cards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "draftroyale", "draftroyale.json");
const CARD_NAMES_PATH = path.resolve(__dirname, "..", "..", "data", "cardNames.json");

const STATE_KEY = "draftroyale:state";
const JOUEURS_KEY = "draftroyale:joueurs";
const HISTORIQUE_KEY = "draftroyale:historique";
const RESULTAT_KEY = "draftroyale:resultat";
const MANCHES_KEY = "draftroyale:manches";
const MANCHE_SEQ_KEY = "draftroyale:manche_seq";
const actionsKey = (jour) => `draftroyale:actions:${jour}`;
const marcheKey = (jour) => `draftroyale:marche:${jour}`;

export { RARITIES };

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

export function cardsFromKeys(keys, catalog) {
  return (keys || []).map((k) => catalog.get(k)).filter(Boolean);
}

// ── Règles pures : thèmes, contrats, score ─────────────────────────

export function matchesCritere(card, critere) {
  return Object.entries(critere).every(([field, value]) => card[field] === value);
}

export function countTheme(cards, theme) {
  return cards.filter((c) => matchesCritere(c, theme.critere)).length;
}

// Palier atteint (index dans config.paliers) ou -1.
function palierAtteint(count, config) {
  let index = -1;
  config.paliers.forEach((p, i) => {
    if (count >= p) index = i;
  });
  return index;
}

export function multiplicateurDuJour(config, jour) {
  return config.contrat_multiplicateurs[String(jour)] ?? null;
}

// Contrats proposés : chaque thème à chaque palier ("squelettes:4").
export function contratsDisponibles(config) {
  return config.themes.flatMap((theme) =>
    config.paliers.map((palier, i) => ({
      id: `${theme.id}:${palier}`,
      themeId: theme.id,
      palier,
      points: theme.points[i],
      label: `${palier} ${theme.label}`,
    })),
  );
}

export function findContrat(config, contratId) {
  return contratsDisponibles(config).find((c) => c.id === contratId) || null;
}

// Bonus d'un contrat réussi (arrondi à l'entier le plus proche).
export function contratBonus(contrat) {
  return Math.round(contrat.points * (contrat.multiplicateur - 1));
}

export function contratReussi(cards, contrat, config) {
  const theme = config.themes.find((t) => t.id === contrat.themeId);
  return !!theme && countTheme(cards, theme) >= contrat.palier;
}

function averageElixir(cards) {
  return cards.reduce((s, c) => s + c.elixir, 0) / cards.length;
}

// Score d'un deck SANS les majorités (elles dépendent des autres joueurs)
// ni la popularité. `contrat` : contrat signé ({ themeId, palier, points,
// multiplicateur }) ou null.
export function scoreDeck(cards, contrat, config) {
  const details = [];
  for (const theme of config.themes) {
    const count = countTheme(cards, theme);
    const i = palierAtteint(count, config);
    if (i >= 0) details.push({ id: `theme_${theme.id}`, label: `${config.paliers[i]} ${theme.label}`, points: theme.points[i] });
  }
  const b = config.bonus;
  if (RARITIES.every((r) => cards.some((c) => c.rarity === r))) details.push({ id: "raretes", label: b.raretes.label, points: b.raretes.points });
  if (cards.length >= 3 && averageElixir(cards) <= b.cycle.seuil) details.push({ id: "cycle", label: b.cycle.label, points: b.cycle.points });
  if (cards.length >= 3 && averageElixir(cards) >= b.lourd.seuil) details.push({ id: "lourd", label: b.lourd.label, points: b.lourd.points });
  const trio =
    cards.some((c) => c.type === "troop" || c.type === "flying") &&
    cards.some((c) => c.type === "spell") &&
    cards.some((c) => c.type === "building");
  if (trio) details.push({ id: "trio", label: b.trio.label, points: b.trio.points });
  if (contrat && contratReussi(cards, contrat, config)) {
    details.push({ id: "contrat", label: `Contrat ${contrat.label} (×${contrat.multiplicateur})`, points: contratBonus(contrat) });
  }
  return { details, total: details.reduce((s, d) => s + d.points, 0) };
}

export function popularitePoints(joueur, config) {
  return Math.min(config.popularite_max, joueur.popularite || 0);
}

// Deck final : si la main dépasse la taille du deck (9 cartes au J7), on
// retire une à une la carte dont l'absence garde le meilleur score (contrat
// compris). À score égal, on retire la carte de rareté la plus basse, puis
// la moins chère : les majorités de rareté ne sont jamais pénalisées.
export function choisirDeckFinal(keys, contrat, config, catalog) {
  let deck = [...keys];
  while (deck.length > config.taille_deck) {
    let best = null;
    deck.forEach((key, i) => {
      const reste = deck.filter((_, j) => j !== i);
      const card = catalog.get(key);
      const candidat = {
        i,
        score: scoreDeck(cardsFromKeys(reste, catalog), contrat, config).total,
        rarete: card ? RARITIES.indexOf(card.rarity) : -1,
        elixir: card?.elixir ?? 0,
      };
      if (
        !best ||
        candidat.score > best.score ||
        (candidat.score === best.score && (candidat.rarete < best.rarete || (candidat.rarete === best.rarete && candidat.elixir < best.elixir)))
      ) {
        best = candidat;
      }
    });
    deck.splice(best.i, 1);
  }
  return deck;
}

// Nombre de cartes données à un joueur qui rejoint au jour `jour` : les
// cartes de départ + une par jour manqué, pour qu'il puisse encore
// atteindre un deck complet.
export function cartesDeDepart(jour, config) {
  return config.cartes_depart + Math.max(0, (Number(jour) || 1) - 1);
}

// Carte aléatoire jamais présente dans `exclues` (main + carte déposée en
// attente de retour). null si le catalogue est épuisé.
export function tirerCarte(exclues, catalog, rng = Math.random) {
  const interdites = new Set(exclues);
  const possibles = [...catalog.keys()].filter((k) => !interdites.has(k));
  if (!possibles.length) return null;
  return possibles[Math.floor(rng() * possibles.length)];
}

// Cartes que le joueur peut demander en vœu : celles du marché de la
// veille, sans doublon, qu'il ne possède pas, hors la carte qu'il a
// lui-même déposée (elle lui revient de toute façon par défaut).
export function cartesSouhaitables(marche, joueur, jour) {
  const possedees = new Set(joueur.main || []);
  const propre = depotDuJour(joueur, jour - 1)?.key;
  return [...new Set(marche.map((m) => m.key))].filter((k) => !possedees.has(k) && k !== propre);
}

// Dépôts d'un joueur : liste [{ key, jour, at }] — au plus deux à la fois
// (celui de la veille, en attente de ses vœux, et celui du jour).
export function depotDuJour(joueur, jour) {
  return (joueur.depots || []).find((d) => Number(d.jour) === Number(jour)) || null;
}

function clesDeposees(joueur) {
  return (joueur.depots || []).map((d) => d.key);
}

// ── Clôture (fonction pure) ─────────────────────────────────────────

function shuffle(array, rng) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Résolution des vœux du jour `jour` sur le marché de la veille
// (`marcheVeille` = [{ key, discordId, at, copies? }]). Une entrée sans
// déposant (`discordId` null, cartes du Marchand du Draft en duel) ne
// rapporte de popularité à personne ; `copies` remplace alors
// `copies_par_depot`. Mute `joueurs` (copie fournie par l'appelant) et
// renvoie les lignes du bilan.
export function resoudreVoeux({ jour, joueurs, actionsRaw, marcheVeille, config, rng = Math.random }) {
  const lignes = [];
  // Stock : `copies_par_depot` exemplaires par carte déposée, attribués au
  // premier déposant d'abord (ordre de dépôt) pour la popularité.
  const stock = new Map();
  for (const m of [...marcheVeille].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))) {
    const slots = stock.get(m.key) || [];
    for (let i = 0; i < (m.copies ?? config.copies_par_depot); i++) slots.push(m.discordId ?? null);
    stock.set(m.key, slots);
  }

  // Ordre de service : popularité (avant clôture) décroissante, puis hasard.
  const demandeurs = shuffle(
    Object.entries(joueurs).filter(([, j]) => depotDuJour(j, jour - 1)),
    rng,
  ).sort(([, a], [, b]) => (b.popularite || 0) - (a.popularite || 0));

  const gains = new Map();
  for (const [id, joueur] of demandeurs) {
    const depot = depotDuJour(joueur, jour - 1);
    const possedees = new Set(joueur.main);
    const voeux = (actionsRaw[id]?.voeux || []).filter(Boolean);
    let obtenu = null;
    voeux.forEach((key, rang) => {
      if (obtenu || possedees.has(key) || key === depot.key) return;
      const slots = stock.get(key);
      if (!slots?.length) return;
      obtenu = { key, rang: rang + 1, deposantId: slots.shift() };
    });
    if (obtenu) {
      joueur.main.push(obtenu.key);
      lignes.push({ type: "voeu", discordId: id, key: obtenu.key, rang: obtenu.rang, rendue: depot.key });
      if (obtenu.deposantId !== id && joueurs[obtenu.deposantId]) {
        joueurs[obtenu.deposantId].popularite = (joueurs[obtenu.deposantId].popularite || 0) + 1;
        const cle = `${obtenu.deposantId}|${obtenu.key}`;
        gains.set(cle, (gains.get(cle) || 0) + 1);
      }
    } else {
      if (!possedees.has(depot.key)) joueur.main.push(depot.key);
      lignes.push({ type: "retour", discordId: id, key: depot.key, sansVoeu: voeux.length === 0 });
    }
    joueur.depots = joueur.depots.filter((d) => d !== depot);
  }
  for (const [cle, nb] of gains) {
    const [discordId, key] = cle.split("|");
    lignes.push({ type: "popularite", discordId, key, nb });
  }
  return lignes;
}

// Classement final : decks de 8 choisis, majorités (tous les ex aequo en
// tête marquent, au moins 1 carte), popularité plafonnée. Départage :
// popularité brute, puis ordre d'arrivée dans le jeu.
export function computeFinal({ joueurs, config, catalog }) {
  const resultats = Object.entries(joueurs).map(([discordId, j]) => {
    const deck = choisirDeckFinal(j.main || [], j.contrat, config, catalog);
    const cards = cardsFromKeys(deck, catalog);
    const { details } = scoreDeck(cards, j.contrat, config);
    return { discordId, username: j.username, deck, cards, details, popularite: j.popularite || 0, arrivee: j.arrivee ?? 0, contrat: j.contrat || null };
  });
  for (const maj of config.majorites) {
    const counts = resultats.map((r) => r.cards.filter((c) => c.rarity === maj.rarete).length);
    const max = Math.max(0, ...counts);
    if (max < 1) continue;
    resultats.forEach((r, i) => {
      if (counts[i] === max) r.details.push({ id: `maj_${maj.id}`, label: maj.label, points: maj.points });
    });
  }
  for (const r of resultats) {
    const pop = Math.min(config.popularite_max, r.popularite);
    if (pop > 0) r.details.push({ id: "popularite", label: "Popularité", points: pop });
    r.score = r.details.reduce((s, d) => s + d.points, 0);
    delete r.cards;
  }
  return resultats.sort((a, b) => b.score - a.score || b.popularite - a.popularite || a.arrivee - b.arrivee);
}

// Clôture du jour `jour` : vœux sur le marché de la veille, marché du jour
// (dépôts du jour), et classement final au dernier jour. Aucune I/O.
export function computeCloture({ jour, joueursAvant, actionsRaw, marcheVeille, config, catalog, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j, main: [...(j.main || [])], depots: [...(j.depots || [])] };

  const lignes = resoudreVoeux({ jour, joueurs, actionsRaw, marcheVeille, config, rng });

  const marcheJour = Object.entries(joueurs)
    .map(([discordId, j]) => ({ discordId, depot: depotDuJour(j, jour) }))
    .filter(({ depot }) => depot)
    .map(({ discordId, depot }) => ({ key: depot.key, discordId, at: depot.at || null }));

  const final = jour >= config.duree_jours ? computeFinal({ joueurs, config, catalog }) : null;
  return { joueursApres: joueurs, marcheJour, lignes, final };
}

// ── État de la partie ──────────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Joueurs ─────────────────────────────────────────────────────────
// HASH discordId → JSON { username, main: [cardKey], contrat, depots,
// popularite, arrivee }. Participation libre : un joueur est créé au tout
// premier clic, avec ses cartes de départ.

export async function readJoueurs() {
  return hgetallJson(JOUEURS_KEY);
}

export async function readJoueur(discordId) {
  return fromJson(await getRedis().hget(JOUEURS_KEY, discordId));
}

export async function writeJoueur(discordId, joueur) {
  await getRedis().hset(JOUEURS_KEY, { [discordId]: toJson(joueur) });
}

export async function ensureJoueur(discordId, username, jour, rng = Math.random) {
  const existing = await readJoueur(discordId);
  if (existing) {
    if (username && existing.username !== username) {
      const updated = { ...existing, username };
      await writeJoueur(discordId, updated);
      return updated;
    }
    return existing;
  }
  const [config, catalog, joueurs] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readJoueurs()]);
  const main = [];
  for (let i = 0; i < cartesDeDepart(jour, config); i++) {
    const key = tirerCarte(main, catalog, rng);
    if (key) main.push(key);
  }
  const fresh = { username: username || "?", main, contrat: null, depots: [], popularite: 0, arrivee: Object.keys(joueurs).length };
  await writeJoueur(discordId, fresh);
  return fresh;
}

// ── Actions quotidiennes ────────────────────────────────────────────
// HASH discordId → JSON { pioche, depot, voeux: [k1, k2, k3], contrat }.

async function updateAction(jour, discordId, patch) {
  const current = fromJson(await getRedis().hget(actionsKey(jour), discordId)) || {};
  const updated = { ...current, ...patch };
  await getRedis().hset(actionsKey(jour), { [discordId]: toJson(updated) });
  return updated;
}

export async function readActions(jour) {
  return hgetallJson(actionsKey(jour));
}

export async function readAction(jour, discordId) {
  return fromJson(await getRedis().hget(actionsKey(jour), discordId)) || {};
}

// Pioche — résolue en direct, une fois par jour.
export async function piocher(jour, discordId, username, rng = Math.random) {
  const action = await readAction(jour, discordId);
  if (action.pioche) return { status: "alreadyDrawn", key: action.pioche };
  const joueur = await ensureJoueur(discordId, username, jour, rng);
  const catalog = await loadCatalog();
  const key = tirerCarte([...joueur.main, ...clesDeposees(joueur)], catalog, rng);
  if (!key) return { status: "empty" };
  const updated = { ...joueur, main: [...joueur.main, key] };
  await writeJoueur(discordId, updated);
  await updateAction(jour, discordId, { pioche: key });
  return { status: "ok", key, joueur: updated };
}

// Dépôt au marché — J1 à `jour_dernier_depot`, une carte par jour, retirée
// de la main tout de suite (définitif).
export async function deposer(jour, discordId, key, config) {
  if (Number(jour) > config.jour_dernier_depot) return { status: "tooLate" };
  const action = await readAction(jour, discordId);
  if (action.depot) return { status: "alreadyDeposited" };
  const joueur = await readJoueur(discordId);
  if (!joueur) return { status: "unknownPlayer" };
  if (!joueur.main.includes(key)) return { status: "notInHand" };
  if (depotDuJour(joueur, jour)) return { status: "alreadyDeposited" };
  const updated = {
    ...joueur,
    main: joueur.main.filter((k) => k !== key),
    depots: [...(joueur.depots || []), { key, jour: Number(jour), at: new Date().toISOString() }],
  };
  await writeJoueur(discordId, updated);
  await updateAction(jour, discordId, { depot: key });
  return { status: "ok", joueur: updated };
}

// Vœu de rang `rang` (1 à nb_voeux), modifiable jusqu'à la clôture.
// Une même carte ne peut occuper qu'un rang : elle est retirée des autres.
export async function enregistrerVoeu(jour, discordId, rang, key, config) {
  const joueur = await readJoueur(discordId);
  if (!joueur || !depotDuJour(joueur, Number(jour) - 1)) return { status: "noDeposit" };
  const marche = await readMarche(Number(jour) - 1);
  if (!cartesSouhaitables(marche, joueur, Number(jour)).includes(key)) return { status: "unavailable" };
  const action = await readAction(jour, discordId);
  const voeux = Array.from({ length: config.nb_voeux }, (_, i) => action.voeux?.[i] ?? null).map((k) => (k === key ? null : k));
  voeux[rang - 1] = key;
  await updateAction(jour, discordId, { voeux });
  return { status: "ok", voeux };
}

// Contrat — J1 à J4 (jours ayant un multiplicateur), une signature par jour.
export async function signerContrat(jour, discordId, username, contratId, config) {
  const multiplicateur = multiplicateurDuJour(config, jour);
  if (!multiplicateur) return { status: "tooLate" };
  const contrat = findContrat(config, contratId);
  if (!contrat) return { status: "unknown" };
  const action = await readAction(jour, discordId);
  if (action.contrat) return { status: "alreadySigned" };
  const joueur = await ensureJoueur(discordId, username, jour);
  if (joueur.contrat?.id === contrat.id) return { status: "same" };
  const signe = { ...contrat, multiplicateur, jour: Number(jour) };
  await writeJoueur(discordId, { ...joueur, contrat: signe });
  await updateAction(jour, discordId, { contrat: true });
  return { status: "ok", contrat: signe };
}

// ── Marché (dépôts figés à la clôture) ──────────────────────────────

export async function readMarche(jour) {
  return fromJson(await getRedis().get(marcheKey(jour))) || [];
}

async function writeMarche(jour, marche) {
  await getRedis().set(marcheKey(jour), toJson(marche));
}

// ── Clôture ─────────────────────────────────────────────────────────

async function loadClotureInputs(jour) {
  const [config, catalog, joueursAvant, actionsRaw, marcheVeille] = await Promise.all([
    loadDraftRoyaleConfig(),
    loadCatalog(),
    readJoueurs(),
    readActions(jour),
    readMarche(jour - 1),
  ]);
  return { config, catalog, joueursAvant, actionsRaw, marcheVeille };
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

  await writeHistoriqueEntry(jour, { lignes: closure.lignes, resolvedAt: new Date().toISOString() });
  await writeMarche(jour, closure.marcheJour);
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
  await getRedis().del(STATE_KEY, JOUEURS_KEY, HISTORIQUE_KEY, RESULTAT_KEY);
  await scanDelete("draftroyale:actions:*");
  await scanDelete("draftroyale:marche:*");
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
