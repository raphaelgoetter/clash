// ============================================================
// meowRules.js — Règles pures de Meow (jeu spécial de 7 jours) : trois
// bandes de chats (Roux, Chats noirs, Chartreux) squattent les 20 coins
// d'une maison, Risk simplifié en temps réel. Chaque joueur reçoit des
// chats à 3 distributions par jour, les appelle sur les coins de sa bande
// et squatte les coins voisins (crêpage de poils : dés du Risk, manche
// par manche, retraite possible). Décompte chaque soir : la bande classée
// 1re du jour marque 3 points, la 2e 2, la 3e 1.
//
// Temps réel « paresseux » : les événements horaires (distributions,
// décompte, sieste) ne sont pas déclenchés par un cron mais rattrapés dans
// l'ordre à chaque action et à chaque publication (`rattraper()`), à partir
// de l'heure de Paris.
//
// Aucune I/O : la couche Redis (meow.js) lit la partie, appelle ces
// fonctions sous verrou puis réécrit la partie. Toutes les fonctions
// modifient la partie reçue en place ; `rng` et `now` injectables pour les
// tests.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Meow), source de vérité. Équilibrage : jeux/outils/meow-simulation/simulate.mjs.
// ============================================================

import { parisOffsetMs } from "@clash/clash-royale/dateUtils.js";

// ── Bandes et carte ─────────────────────────────────────────────────

export const BANDES = [
  { id: "roux", nom: "Roux", emoji: "🟠", depart: "chambre", panier: "fenetre" },
  { id: "noirs", nom: "Chats noirs", emoji: "⚫", depart: "jardin", panier: "potager" },
  { id: "chartreux", nom: "Chartreux", emoji: "🔵", depart: "cuisine", panier: "frigo" },
];

export const ERRANTS = -1;

// `le` / `du` : formes avec article (« tient le Jardin », « part du Jardin »)
export const PIECES = {
  chambre: { nom: "Chambre", le: "la Chambre", du: "de la Chambre", coins: ["fenetre", "couette", "armoire", "carton"] },
  grenier: { nom: "Grenier", le: "le Grenier", du: "du Grenier", coins: ["malle", "chapeaux", "poutre", "lucarne"] },
  salon: { nom: "Salon", le: "le Salon", du: "du Salon", coins: ["radiateur", "canape", "tapis", "biblio"] },
  cuisine: { nom: "Cuisine", le: "la Cuisine", du: "de la Cuisine", coins: ["evier", "frigo", "corbeille", "gamelle"] },
  jardin: { nom: "Jardin", le: "le Jardin", du: "du Jardin", coins: ["arbre", "perron", "potager", "cabane"] },
};

export const NOMS_COINS = {
  fenetre: "Fenêtre",
  couette: "Couette",
  armoire: "Armoire",
  carton: "Carton",
  malle: "Malle",
  chapeaux: "Chapeaux",
  poutre: "Poutre",
  lucarne: "Lucarne",
  radiateur: "Radiateur",
  canape: "Canapé",
  tapis: "Tapis",
  biblio: "Bibliothèque",
  evier: "Évier",
  frigo: "Frigo",
  corbeille: "Corbeille",
  gamelle: "Gamelle",
  arbre: "Arbre",
  perron: "Perron",
  potager: "Potager",
  cabane: "Cabane",
};

// Carte symétrique (décision du 16/10) : chaque pièce de départ a deux
// sorties sur deux coins distincts, l'une vers le Salon, l'autre vers le
// Grenier ; aucune bande ne touche une autre au départ.
export const PASSAGES = [
  ["carton", "canape"],
  ["armoire", "malle"],
  ["evier", "chapeaux"],
  ["gamelle", "biblio"],
  ["tapis", "perron"],
  ["cabane", "lucarne"],
];

// Ordre de référence des coins (encodage de la carte, menus)
export const COINS = Object.values(PIECES).flatMap((p) => p.coins);

export const PIECE_DE = Object.fromEntries(Object.entries(PIECES).flatMap(([id, p]) => p.coins.map((c) => [c, id])));

// Dans une pièce, tous les coins se touchent ; entre pièces, seulement par
// un passage.
export const VOISINS = (() => {
  const v = Object.fromEntries(COINS.map((c) => [c, new Set()]));
  for (const p of Object.values(PIECES)) for (const a of p.coins) for (const b of p.coins) if (a !== b) v[a].add(b);
  for (const [a, b] of PASSAGES) {
    v[a].add(b);
    v[b].add(a);
  }
  return Object.fromEntries(Object.entries(v).map(([k, s]) => [k, [...s]]));
})();

export const PANIERS = BANDES.map((b) => b.panier);

export function nomCoin(id) {
  return NOMS_COINS[id] ?? id;
}

export function bande(b) {
  return BANDES[b];
}

// ── Heure de Paris ──────────────────────────────────────────────────

const FORMAT_PARIS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// { date: "AAAA-MM-JJ", h, min } à Paris
export function parisParts(ms) {
  const p = Object.fromEntries(FORMAT_PARIS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), min: Number(p.minute) };
}

// Instant UTC (ms) de `date` à `h` heures pile, heure de Paris
export function parisInstant(date, h) {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d, h);
  let t = base - parisOffsetMs(new Date(base));
  t = base - parisOffsetMs(new Date(t));
  return t;
}

export function ajouterJours(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function joursEntre(a, b) {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

// Numéro du jour de jeu (1 = jour du lancement) à l'instant `ms`
export function jourDe(partie, ms) {
  return joursEntre(partie.jourDebut, parisParts(ms).date) + 1;
}

// Sieste de 0 h à `fin_sieste` : aucun squat
export function enSieste(ms, config) {
  return parisParts(ms).h < config.fin_sieste;
}

// Événements horaires strictement après `de` et jusqu'à `a` inclus, dans
// l'ordre : sieste (0 h), distributions, décompte. `heure_decompte` peut
// valoir 24 (minuit, décision du 16/10) : le décompte du jour D tombe alors
// à 0 h le lendemain, juste avant la sieste du lendemain (même instant,
// mais généré avec la date D, donc trié avant).
export function evenementsEntre(de, a, config) {
  const out = [];
  const fin = parisParts(a).date;
  const horaires = [[0, "sieste"], ...config.distributions.map((h) => [h, "distribution"]), [config.heure_decompte, "decompte"]];
  for (let date = ajouterJours(parisParts(de).date, -1); date <= fin; date = ajouterJours(date, 1)) {
    for (const [h, type] of horaires) {
      const t = parisInstant(date, h);
      if (t > de && t <= a) out.push({ t, type, date });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

// Prochaine distribution après `ms` (pour l'affichage : « avant 20h »)
export function prochaineDistribution(ms, config) {
  const { date } = parisParts(ms);
  for (const jour of [date, ajouterJours(date, 1)])
    for (const h of config.distributions) {
      const t = parisInstant(jour, h);
      if (t > ms) return { t, h };
    }
  return null;
}

// ── Horloge de la partie ────────────────────────────────────────────
// Heure réelle, décalée de `partie.decalage` sur le salon de test seulement
// (chaque `npm run meow:test` avance la partie d'un jour ou d'une
// distribution, voir avancerHorloge() dans meow.js).
export function horloge(partie) {
  return Date.now() + (partie?.decalage ?? 0);
}

// ── Partie ──────────────────────────────────────────────────────────

export function creerPartie() {
  return {
    demarree: false,
    termine: false,
    joueurs: {},
    coins: {},
    combats: {},
    messages: [[], [], []],
    points: [0, 0, 0],
    decomptes: [],
    journal: [],
    jourDebut: null,
    debut: null,
    curseur: null,
  };
}

export function nbInscrits(partie) {
  return Object.keys(partie.joueurs).length;
}

export function inscrire(partie, discordId, username, { config }) {
  if (partie.demarree) return { erreur: "inscriptions" };
  if (partie.joueurs[discordId]) return { erreur: "dejaInscrit" };
  if (nbInscrits(partie) >= config.effectif_max) return { erreur: "complet" };
  // Numéro d'arrivée strictement croissant (même après une désinscription)
  partie.seqInscription = (partie.seqInscription ?? nbInscrits(partie)) + 1;
  partie.joueurs[discordId] = { username, arrivee: partie.seqInscription };
  return { ok: true };
}

export function desinscrire(partie, discordId) {
  if (partie.demarree) return { erreur: "lancee" };
  if (!partie.joueurs[discordId]) return { erreur: "pasInscrit" };
  delete partie.joueurs[discordId];
  return { ok: true };
}

function melanger(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function tailles(partie) {
  const t = [0, 0, 0];
  for (const j of Object.values(partie.joueurs)) if (j.bande != null) t[j.bande]++;
  return t;
}

// Lancement : bandes égales tirées au sort parmi les premiers inscrits ; le
// ou les 1-2 derniers inscrits (en plus d'un multiple de 3) vont chacun dans
// une bande différente, tirée au sort (décision du 16/10 : les derniers
// inscrits seront sans doute les moins actifs, autant qu'ils grossissent
// les bandes plutôt que d'en priver une d'un joueur régulier). Puis 2 chats
// par coin des pièces de départ, 2 chats errants par coin du Salon et du
// Grenier, et une première distribution immédiate.
export function demarrer(partie, { config, now = horloge(partie), rng = Math.random }) {
  const ordreBandes = melanger([0, 1, 2], rng);
  const ids = Object.keys(partie.joueurs).sort((a, b) => partie.joueurs[a].arrivee - partie.joueurs[b].arrivee);
  const nbDerniers = ids.length % 3;
  const premiers = melanger(ids.slice(0, ids.length - nbDerniers), rng);
  const derniers = ids.slice(ids.length - nbDerniers);
  const bandeDe = new Map([...premiers.map((id, k) => [id, k % 3]), ...derniers.map((id, k) => [id, ordreBandes[k]])]);
  ids.forEach((id) => {
    Object.assign(partie.joueurs[id], {
      bande: bandeDe.get(id),
      stock: 0,
      frac: 0,
      squats: 0,
      coinsPris: 0,
      chatsDeloges: 0,
      jourActif: null,
    });
  });
  for (const c of COINS) partie.coins[c] = { b: ERRANTS, n: config.chats_errants };
  BANDES.forEach((bd, b) => {
    for (const c of PIECES[bd.depart].coins) partie.coins[c] = { b, n: config.chats_depart };
  });
  partie.demarree = true;
  partie.debut = new Date(now).toISOString();
  partie.jourDebut = parisParts(now).date;
  partie.curseur = now;
  distribuer(partie, { config, t: now });
  return partie;
}

// ── Situation de la carte ───────────────────────────────────────────

export function coinsVerrouilles(partie) {
  const s = new Set();
  for (const c of Object.values(partie.combats)) (s.add(c.s), s.add(c.t));
  return s;
}

export function piecesTenues(partie, b) {
  return Object.keys(PIECES).filter((p) => PIECES[p].coins.every((c) => partie.coins[c].b === b));
}

export function coinsDe(partie, b) {
  return COINS.filter((c) => partie.coins[c].b === b);
}

// Menace d'un coin : plus forte pile adverse voisine (chats engageables,
// errants exclus : ils ne squattent jamais) moins les chats présents.
export function menace(partie, c) {
  const b = partie.coins[c].b;
  let m = 0;
  for (const v of VOISINS[c]) {
    const cv = partie.coins[v];
    if (cv.b !== b && cv.b !== ERRANTS) m = Math.max(m, cv.n - 1);
  }
  return m - partie.coins[c].n;
}

export function frontiere(partie, b) {
  return coinsDe(partie, b).filter((c) => VOISINS[c].some((v) => partie.coins[v].b !== b));
}

// Coin le plus menacé parmi `coins` (hors combats en cours) ; à égalité,
// le premier dans l'ordre de la carte.
function plusMenace(partie, coins) {
  const libres = coins.filter((c) => !coinsVerrouilles(partie).has(c));
  if (!libres.length) return null;
  return libres.reduce((best, c) => (menace(partie, c) > menace(partie, best) ? c : best));
}

// Placement automatique (sieste, croquettes) : coin de la bande le plus
// menacé, sinon son panier.
function coinAuto(partie, b) {
  return plusMenace(partie, frontiere(partie, b)) ?? plusMenace(partie, coinsDe(partie, b)) ?? BANDES[b].panier;
}

// ── Événements horaires ─────────────────────────────────────────────

// Distribution : `chats_par_distribution` chats par joueur (stock plafonné), recharge équilibrée
// (une petite bande reçoit au total autant qu'une grande, par fractions
// cumulées), squats remis à zéro, croquettes des pièces complètes.
function distribuer(partie, { config, t }) {
  const ts = tailles(partie);
  const max = Math.max(...ts);
  for (const j of Object.values(partie.joueurs)) {
    if (j.bande == null) continue;
    // `chats_par_distribution` (2 depuis le 16/10) ; une petite bande cumule
    // en plus sa part manquante, versée chat par chat
    let gain = config.chats_par_distribution;
    j.frac += (max / ts[j.bande] - 1) * config.chats_par_distribution;
    while (j.frac >= 1 - 1e-9) {
      gain++;
      j.frac -= 1;
    }
    j.stock = Math.min(config.stock_max, j.stock + gain);
    j.squats = 0;
    j.deplacements = 0;
  }
  for (let b = 0; b < 3; b++) {
    for (const p of piecesTenues(partie, b)) {
      const n = config.croquettes[p] ?? 0;
      if (!n) continue;
      const cible = plusMenace(partie, PIECES[p].coins);
      if (!cible) continue;
      partie.coins[cible].n += n;
      noter(partie, { t, k: "croquettes", b, piece: p, coin: cible, n });
    }
  }
}

// Décompte du soir : chaque coin tenu rapporte `points_territoire` (1)
// point à sa bande (décision du 16/10 : barème en une phrase, remplace le
// classement du soir 3/2/1 avec +2 par pièce entière, jugé incompréhensible ;
// les pièces entières ne rapportent plus que des croquettes).
function decompter(partie, { config, t, jour }) {
  const coins = [0, 1, 2].map((b) => coinsDe(partie, b).length);
  const gains = coins.map((n) => n * config.points_territoire);
  gains.forEach((g, b) => (partie.points[b] += g));
  partie.decomptes.push({ jour, coins, gains });
  noter(partie, { t, k: "decompte", j: jour, jour, gains });
  if (jour >= config.duree_jours) partie.termine = true;
}

// Sieste (0 h) : 1 seul chat non appelé par joueur s'installe sur le coin
// le plus menacé de sa bande, les autres restent en réserve (décision du
// 16/10, avant : toute la réserve). Noté dans `j.nuit` pour la vue Jouer du
// lendemain.
function siester(partie, { t }) {
  const poses = [0, 0, 0];
  for (const j of Object.values(partie.joueurs)) {
    if (j.bande == null || j.stock <= 0) continue;
    const c = coinAuto(partie, j.bande);
    partie.coins[c].n += 1;
    poses[j.bande] += 1;
    j.stock -= 1;
    j.nuit = { jour: jourDe(partie, t), coin: c };
  }
  if (poses.some(Boolean)) noter(partie, { t, k: "sieste", poses });
}

// Événement « mercenaires » (décision du 16/10) : à la première
// distribution du jour `mercenaires.jour` (3), la bande dernière aux points
// (à égalité, celle qui a le moins de coins) reçoit `par_joueur` (1) chat
// par joueur (4 pour une bande de 4), posés sur son coin le plus menacé. Peu d'effet sur l'équilibre en
// simulation, mais un coup de pouce visible pour une bande en difficulté.
function envoyerMercenaires(partie, { config, t }) {
  const b = classementBandes(partie).at(-1).b;
  const n = config.mercenaires.par_joueur * tailles(partie)[b];
  const coin = coinAuto(partie, b);
  partie.coins[coin].n += n;
  partie.mercenaires = { jour: jourDe(partie, t), b, n, coin };
  noter(partie, { t, k: "mercenaires", b, n, coin });
}

// Combat abandonné (aucun clic pendant `delai_combat_minutes`) : retraite
// automatique.
function expirerCombats(partie, { config, now }) {
  for (const [id, c] of Object.entries(partie.combats)) {
    if (now - c.maj >= config.delai_combat_minutes * 60_000) retraite(partie, id, { now, auto: true });
  }
}

// Rattrape dans l'ordre tous les événements horaires passés depuis le
// dernier passage. À appeler avant toute action et toute publication.
export function rattraper(partie, { config, now = horloge(partie), rng = Math.random }) {
  if (!partie.demarree || partie.termine) return partie;
  expirerCombats(partie, { config, now });
  for (const e of evenementsEntre(partie.curseur, now, config)) {
    // Jour de jeu de l'événement d'après sa date (un décompte de minuit
    // compte pour la journée qui s'achève)
    const jour = joursEntre(partie.jourDebut, e.date) + 1;
    if (e.type === "distribution") {
      distribuer(partie, { config, t: e.t });
      if (config.mercenaires && jour === config.mercenaires.jour && !partie.mercenaires) envoyerMercenaires(partie, { config, t: e.t });
      if (partie.pnjActifs) for (const id of Object.keys(partie.joueurs).filter(estPnj)) jouerPnj(partie, id, { config, now: e.t, rng });
    }
    else if (e.type === "decompte") decompter(partie, { config, t: e.t, jour });
    else siester(partie, { t: e.t });
    if (partie.termine) break;
  }
  partie.curseur = now;
  return partie;
}

// ── Journal ─────────────────────────────────────────────────────────

const JOURNAL_MAX = 400;

function noter(partie, entree) {
  partie.journal.push({ j: partie.jourDebut ? jourDe(partie, entree.t) : 0, ...entree });
  if (partie.journal.length > JOURNAL_MAX) partie.journal.splice(0, partie.journal.length - JOURNAL_MAX);
}

// ── Actions des joueurs ─────────────────────────────────────────────

function verifierJoueur(partie, discordId) {
  if (!partie.demarree) return "pasLancee";
  if (partie.termine) return "termine";
  if (partie.joueurs[discordId]?.bande == null) return "inconnu";
  return null;
}

// Appeler `n` chats de son stock sur un coin de sa bande.
export function appeler(partie, discordId, coin, n, { now = horloge(partie) } = {}) {
  const err = verifierJoueur(partie, discordId);
  if (err) return { erreur: err };
  const j = partie.joueurs[discordId];
  if (!partie.coins[coin] || partie.coins[coin].b !== j.bande) return { erreur: "pasTonCoin" };
  if (coinsVerrouilles(partie).has(coin)) return { erreur: "verrouille" };
  if (j.stock <= 0) return { erreur: "stockVide" };
  const k = Math.max(1, Math.min(j.stock, Math.floor(Number(n)) || 1));
  partie.coins[coin].n += k;
  j.stock -= k;
  j.jourActif = jourDe(partie, now);
  noter(partie, { t: now, k: "appel", p: discordId, coin, n: k });
  return { ok: true, n: k };
}

// Déplacer : 1 chat d'un coin de sa bande vers un coin voisin de sa bande
// (1 chat reste toujours sur place), `deplacements_par_distribution` fois
// entre deux distributions (décision du 16/10), à toute heure.
export function deplacementsRestants(j, config) {
  return Math.max(0, config.deplacements_par_distribution - (j.deplacements ?? 0));
}

// Déplacements possibles, les plus utiles d'abord (vers le coin le plus
// menacé, depuis la plus grosse pile).
export function deplacementsPossibles(partie, b) {
  const bloques = coinsVerrouilles(partie);
  const out = [];
  for (const s of coinsDe(partie, b)) {
    if (partie.coins[s].n < 2 || bloques.has(s)) continue;
    for (const t of VOISINS[s]) {
      if (partie.coins[t].b !== b || bloques.has(t)) continue;
      out.push({ s, t, ns: partie.coins[s].n, nt: partie.coins[t].n, menace: menace(partie, t) });
    }
  }
  return out.sort((x, y) => y.menace - x.menace || y.ns - x.ns || x.nt - y.nt);
}

export function deplacer(partie, discordId, s, t, { config, now = horloge(partie) }) {
  const err = verifierJoueur(partie, discordId);
  if (err) return { erreur: err };
  const j = partie.joueurs[discordId];
  if (deplacementsRestants(j, config) <= 0) return { erreur: "plafondDeplacements" };
  if (!deplacementsPossibles(partie, j.bande).some((o) => o.s === s && o.t === t)) return { erreur: "deplacementImpossible" };
  partie.coins[s].n -= 1;
  partie.coins[t].n += 1;
  j.deplacements = (j.deplacements ?? 0) + 1;
  j.jourActif = jourDe(partie, now);
  return { ok: true };
}

// Squats possibles depuis les coins de sa bande : coin de départ avec au
// moins 2 chats (1 reste garder), cible voisine d'une autre bande ou
// errante, jamais un panier ni un coin en plein combat.
export function squatsPossibles(partie, b) {
  const bloques = coinsVerrouilles(partie);
  const out = [];
  for (const s of coinsDe(partie, b)) {
    if (partie.coins[s].n < 2 || bloques.has(s)) continue;
    for (const t of VOISINS[s]) {
      if (partie.coins[t].b === b || PANIERS.includes(t) || bloques.has(t)) continue;
      const a = partie.coins[s].n - 1;
      out.push({ s, t, a, d: partie.coins[t].n, p: pVictoire(a, partie.coins[t].n) });
    }
  }
  return out.sort((x, y) => y.p - x.p || y.a - x.a);
}

export function squatsRestants(j, config) {
  return Math.max(0, config.squats_par_distribution - (j.squats ?? 0));
}

// Lance un squat : 1 chat reste garder le coin de départ, les autres
// partent ; première manche jouée aussitôt.
export function lancerSquat(partie, discordId, s, t, { config, now = horloge(partie), rng = Math.random }) {
  const err = verifierJoueur(partie, discordId);
  if (err) return { erreur: err };
  const j = partie.joueurs[discordId];
  if (partie.combats[discordId]) return { erreur: "combatEnCours" };
  if (enSieste(now, config)) return { erreur: "sieste" };
  if (squatsRestants(j, config) <= 0) return { erreur: "plafondSquats" };
  const option = squatsPossibles(partie, j.bande).find((o) => o.s === s && o.t === t);
  if (!option) return { erreur: "squatImpossible" };
  partie.combats[discordId] = { s, t, a: option.a, aInit: option.a, d: option.d, dInit: option.d, def: partie.coins[t].b, debut: now, maj: now, manches: [] };
  partie.coins[s].n = 1;
  j.squats = (j.squats ?? 0) + 1;
  j.jourActif = jourDe(partie, now);
  return { ok: true, ...jouerManche(partie, discordId, { now, rng }) };
}

function lancerDes(n, rng) {
  return Array.from({ length: n }, () => 1 + Math.floor(rng() * 6)).sort((x, y) => y - x);
}

// Une manche du crêpage de poils : jusqu'à 3 dés contre 2, on compare
// les plus hauts dés deux à deux, le plus petit perd un chat, l'égalité
// profite au défenseur (le chat chez lui tient bon).
export function jouerManche(partie, discordId, { now = horloge(partie), rng = Math.random } = {}) {
  const c = partie.combats[discordId];
  if (!c) return { erreur: "pasDeCombat" };
  const da = lancerDes(Math.min(3, c.a), rng);
  const dd = lancerDes(Math.min(2, c.d), rng);
  let pa = 0;
  let pd = 0;
  for (let k = 0; k < Math.min(da.length, dd.length); k++) (da[k] > dd[k] ? pd++ : pa++);
  c.a -= pa;
  c.d -= pd;
  c.maj = now;
  c.manches.push({ da, dd, pa, pd });
  partie.coins[c.t].n = c.d;
  partie.joueurs[discordId].chatsDeloges += pd;
  const manche = { da, dd, pa, pd };
  if (c.d <= 0) return { manche, fin: terminerCombat(partie, discordId, "victoire", now) };
  if (c.a <= 0) return { manche, fin: terminerCombat(partie, discordId, "defaite", now) };
  return { manche };
}

export function jusquauBout(partie, discordId, { now = horloge(partie), rng = Math.random } = {}) {
  if (!partie.combats[discordId]) return { erreur: "pasDeCombat" };
  let r;
  do r = jouerManche(partie, discordId, { now, rng });
  while (!r.fin && !r.erreur);
  return r;
}

export function retraite(partie, discordId, { now = horloge(partie), auto = false } = {}) {
  if (!partie.combats[discordId]) return { erreur: "pasDeCombat" };
  return { fin: terminerCombat(partie, discordId, auto ? "retraiteAuto" : "retraite", now) };
}

function terminerCombat(partie, discordId, issue, now) {
  const c = partie.combats[discordId];
  const j = partie.joueurs[discordId];
  delete partie.combats[discordId];
  if (issue === "victoire") {
    partie.coins[c.t] = { b: j.bande, n: c.a };
    j.coinsPris++;
    // Exploit de la partie (compte-rendu final) : victoire la moins probable
    // au lancement. Gardé à part, le journal ne conserve que les dernières entrées.
    const p = pVictoire(c.aInit, c.dInit);
    if (!partie.exploit || p < partie.exploit.p) partie.exploit = { p, p_id: discordId, b: j.bande, def: c.def, vers: c.t, aInit: c.aInit, dInit: c.dInit, j: jourDe(partie, now) };
  } else if (issue !== "defaite") {
    partie.coins[c.s].n += c.a;
  }
  const entree = { t: now, k: "squat", issue, p: discordId, b: j.bande, def: c.def, de: c.s, vers: c.t, aInit: c.aInit, dInit: c.dInit, a: c.a, d: c.d };
  noter(partie, entree);
  return entree;
}

// ── PNJ (salon de test uniquement) ──────────────────────────────────
// Joueurs fictifs qui jouent à chaque distribution, pour animer une partie
// de test : tous leurs chats sur le coin le plus menacé (sinon sur le coin
// le plus garni, pour préparer un squat), puis leurs squats tant qu'une
// cible offre au moins 60 % de réussite, joués jusqu'au bout.

export function estPnj(id) {
  return String(id).startsWith("pnj-");
}

export function jouerPnj(partie, id, { config, now, rng = Math.random }) {
  const j = partie.joueurs[id];
  if (!j || j.bande == null || partie.termine) return;
  if (j.stock > 0) {
    const front = frontiere(partie, j.bande).filter((c) => !coinsVerrouilles(partie).has(c));
    if (front.length) {
      const menace0 = front.reduce((best, c) => (menace(partie, c) > menace(partie, best) ? c : best));
      const garni = front.reduce((best, c) => (partie.coins[c].n > partie.coins[best].n ? c : best));
      appeler(partie, id, menace(partie, menace0) > 0 ? menace0 : garni, j.stock, { now });
    }
  }
  const dep = deplacementsPossibles(partie, j.bande)[0];
  if (dep && dep.menace > 0 && deplacementsRestants(j, config) > 0) deplacer(partie, id, dep.s, dep.t, { config, now });
  if (enSieste(now, config)) return;
  while (squatsRestants(j, config) > 0) {
    const cible = squatsPossibles(partie, j.bande)[0];
    if (!cible || cible.p < 0.6) break;
    const r = lancerSquat(partie, id, cible.s, cible.t, { config, now, rng });
    if (r.erreur) break;
    if (!r.fin) jusquauBout(partie, id, { now, rng });
  }
}

// ── Messagerie de bande ─────────────────────────────────────────────
// Messages signés, visibles uniquement par la bande de l'auteur (décision du
// 16/10, adaptée de la messagerie anonyme de Goblin Hunters), live.

const MESSAGES_GARDES = 30;

export function messagesBande(partie, b) {
  return partie.messages?.[b] ?? [];
}

export function messagesRestants(partie, discordId, { config, now = horloge(partie) }) {
  const j = partie.joueurs[discordId];
  const n = j?.messagesJour?.jour === jourDe(partie, now) ? j.messagesJour.n : 0;
  return Math.max(0, config.messages_par_jour - n);
}

// Messages de la bande arrivés depuis la dernière lecture du joueur
export function nouveauxMessages(partie, discordId) {
  const j = partie.joueurs[discordId];
  if (j?.bande == null) return 0;
  return messagesBande(partie, j.bande).filter((m) => m.p !== discordId && m.t > (j.vuMessages ?? 0)).length;
}

export function marquerLus(partie, discordId, { now = horloge(partie) } = {}) {
  if (partie.joueurs[discordId]) partie.joueurs[discordId].vuMessages = now;
}

export function posterMessage(partie, discordId, texte, { config, now = horloge(partie) }) {
  const err = verifierJoueur(partie, discordId);
  if (err) return { erreur: err };
  const txt = String(texte ?? "").replace(/\s+/g, " ").trim().slice(0, config.message_max);
  if (!txt) return { erreur: "messageVide" };
  if (messagesRestants(partie, discordId, { config, now }) <= 0) return { erreur: "plafondMessages" };
  const j = partie.joueurs[discordId];
  const jour = jourDe(partie, now);
  j.messagesJour = { jour, n: (j.messagesJour?.jour === jour ? j.messagesJour.n : 0) + 1 };
  partie.messages ??= [[], [], []];
  partie.messages[j.bande] = [...partie.messages[j.bande], { p: discordId, t: now, txt }].slice(-MESSAGES_GARDES);
  j.vuMessages = now;
  return { ok: true };
}

// ── Probabilités (affichées dans le menu Squatter) ──────────────────

const ROUNDS = (() => {
  const out = {};
  for (const na of [1, 2, 3])
    for (const nd of [1, 2]) {
      const res = {};
      const total = 6 ** (na + nd);
      for (let i = 0; i < total; i++) {
        let x = i;
        const a = [];
        const d = [];
        for (let k = 0; k < na; k++) (a.push((x % 6) + 1), (x = Math.floor(x / 6)));
        for (let k = 0; k < nd; k++) (d.push((x % 6) + 1), (x = Math.floor(x / 6)));
        a.sort((p, q) => q - p);
        d.sort((p, q) => q - p);
        let pa = 0;
        let pd = 0;
        for (let k = 0; k < Math.min(na, nd); k++) (a[k] > d[k] ? pd++ : pa++);
        res[`${pa},${pd}`] = (res[`${pa},${pd}`] || 0) + 1 / total;
      }
      out[`${na},${nd}`] = Object.entries(res).map(([k, p]) => [...k.split(",").map(Number), p]);
    }
  return out;
})();

const memoVictoire = new Map();

// Probabilité que `a` chats engagés délogent `d` chats en jouant jusqu'au bout
export function pVictoire(a, d) {
  if (d <= 0) return 1;
  if (a <= 0) return 0;
  const cle = a * 1000 + d;
  if (memoVictoire.has(cle)) return memoVictoire.get(cle);
  let p = 0;
  for (const [pa, pd, pr] of ROUNDS[`${Math.min(3, a)},${Math.min(2, d)}`]) p += pr * pVictoire(a - pa, d - pd);
  memoVictoire.set(cle, p);
  return p;
}

// ── Classements ─────────────────────────────────────────────────────

export function scoreCaid(j, config) {
  return (j.coinsPris ?? 0) * config.caid.coin + (j.chatsDeloges ?? 0) * config.caid.chat;
}

// Bandes : points cumulés, puis territoires tenus à cet instant.
export function classementBandes(partie) {
  return [0, 1, 2]
    .map((b) => ({ b, points: partie.points[b], territoires: coinsDe(partie, b).length }))
    .sort((x, y) => y.points - x.points || y.territoires - x.territoires);
}

export function classementCaid(partie, config) {
  return Object.entries(partie.joueurs)
    .filter(([, j]) => j.bande != null)
    .map(([discordId, j]) => ({ discordId, username: j.username, bande: j.bande, score: scoreCaid(j, config), coinsPris: j.coinsPris, chatsDeloges: j.chatsDeloges }))
    .sort((x, y) => y.score - x.score || y.coinsPris - x.coinsPris || x.username.localeCompare(y.username));
}

// ── Compte-rendu final ──────────────────────────────────────────────

const ORDINAUX = ["1res", "2es", "3es"];

function pts(n) {
  return `${n} pt${n > 1 ? "s" : ""}`;
}

// 3-4 phrases sur la partie terminée : déroulé de la course (points
// cumulés soir par soir), record de territoires, exploit le moins probable,
// effet des mercenaires. Une phrase est omise si la donnée manque.
export function compteRendu(partie) {
  const phrases = [];
  const cumul = [0, 0, 0];
  const soirs = partie.decomptes.map((d) => {
    d.gains.forEach((g, b) => (cumul[b] += g));
    return [...cumul];
  });
  const final = classementBandes(partie);
  const w = final[0].b;
  const rang = (pts, b) => pts.filter((x) => x > pts[b]).length;
  if (soirs.length) {
    const ecart = final[0].points - final[1].points;
    if (ecart === 0) phrases.push(`Impossible de départager les ${BANDES[w].nom} et les ${BANDES[final[1].b].nom} aux points au bout des ${soirs.length} jours.`);
    else {
      const seul = (pts, b) => rang(pts, b) === 0 && pts.filter((x) => x === pts[b]).length === 1;
      const justesse = ecart <= 3 ? `, avec ${pts(ecart)} d'avance seulement` : "";
      const dernierJour = soirs.map((pts, k) => (rang(pts, w) === 2 ? k + 1 : 0)).filter(Boolean).at(-1);
      let depuis = soirs.length;
      while (depuis > 1 && seul(soirs[depuis - 2], w)) depuis--;
      if (depuis === 1 && seul(soirs[0], w)) phrases.push(`Les ${BANDES[w].nom} ont mené de bout en bout${justesse}.`);
      else if (dernierJour) phrases.push(`Encore derniers au soir du Jour ${dernierJour}, les ${BANDES[w].nom} ont renversé la partie${justesse}.`);
      else phrases.push(`Les ${BANDES[w].nom} ont pris la tête au Jour ${depuis} pour ne plus la lâcher${justesse}.`);
    }
    let record = null;
    partie.decomptes.forEach((d, k) => d.coins.forEach((n, b) => {
      if (!record || n > record.n) record = { n, b, jour: k + 1 };
    }));
    if (record?.n) phrases.push(`Record de la partie : ${record.n} territoires tenus par les ${BANDES[record.b].nom} au soir du Jour ${record.jour}.`);
  }
  const e = partie.exploit;
  if (e && e.p < 0.5) {
    const adv = e.def === ERRANTS ? "chats errants" : BANDES[e.def].nom;
    phrases.push(`Plus bel exploit : ${BANDES[e.b].emoji} **${partie.joueurs[e.p_id]?.username ?? "?"}** a délogé ${e.dInit} ${adv} ${elision("de", nomCoin(e.vers))} avec seulement ${e.aInit} chat${e.aInit > 1 ? "s" : ""} (${Math.round(e.p * 100)} % de chances).`);
  }
  const m = partie.mercenaires;
  if (m) {
    const r = final.findIndex((x) => x.b === m.b);
    const nom = BANDES[m.b].nom;
    if (r === 0) phrases.push(`Les mercenaires arrivés au Jour ${m.jour} ont porté les ${nom} jusqu'à la victoire.`);
    else if (r === 1) phrases.push(`Les mercenaires arrivés au Jour ${m.jour} ont aidé les ${nom} à remonter à la 2e place.`);
    else phrases.push(`Malgré les mercenaires arrivés au Jour ${m.jour}, les ${nom} finissent ${ORDINAUX[r]}.`);
  }
  return phrases.slice(0, 4);
}

// ── Texte du journal ────────────────────────────────────────────────

function nomBande(b) {
  return b === ERRANTS ? "chats errants" : `${BANDES[b].emoji} ${BANDES[b].nom}`;
}

// « de Malle », « d'Armoire »
function elision(mot, nom) {
  return /^[aeiouyéèêh]/i.test(nom) ? `${mot.slice(0, -1)}'${nom}` : `${mot} ${nom}`;
}

export function texteJournal(partie, e) {
  const qui = (id) => `**${partie.joueurs[id]?.username ?? "?"}**`;
  if (e.k === "squat") {
    const de = nomCoin(e.de);
    const vers = nomCoin(e.vers);
    const adv = e.def === ERRANTS ? "les chats errants" : `les ${BANDES[e.def].nom}`;
    if (e.issue === "victoire") return `${BANDES[e.b].emoji} ${qui(e.p)} a délogé ${adv} ${elision("de", vers)} (depuis ${de}).`;
    if (e.issue === "defaite") return `${BANDES[e.b].emoji} ${qui(e.p)} a échoué devant ${vers} (depuis ${de}).`;
    return `${BANDES[e.b].emoji} ${qui(e.p)} a battu en retraite devant ${vers} (depuis ${de})${e.issue === "retraiteAuto" ? " faute de réponse" : ""}.`;
  }
  if (e.k === "mercenaires") return `⚔️ Des mercenaires rejoignent les ${BANDES[e.b].nom} : +${e.n} chats sur ${nomCoin(e.coin)} !`;
  if (e.k === "croquettes") return `🍖 ${nomBande(e.b)} : croquettes servies dans ${PIECES[e.piece].le} (+${e.n} sur ${nomCoin(e.coin)}).`;
  if (e.k === "appel") return `🐱 ${qui(e.p)} a appelé ${e.n} chat${e.n > 1 ? "s" : ""} sur ${nomCoin(e.coin)}.`;
  if (e.k === "sieste") return `😴 Sieste : ${e.poses.map((n, b) => (n ? `${n} ${BANDES[b].nom}` : null)).filter(Boolean).join(", ")} installés tout seuls.`;
  if (e.k === "decompte") return `📊 Décompte du jour ${e.jour} : ${[0, 1, 2].map((b) => `${BANDES[b].emoji} +${e.gains[b]}`).join(" · ")}`;
  return "";
}
