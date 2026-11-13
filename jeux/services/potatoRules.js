// ============================================================
// potatoRules.js — Règles pures de Potato (patate chaude en duel) et jeu
// de Kévina. Aucune dépendance Redis ni Discord.
//
// Une patate part de TEMP_DEPART ; elle explose à une température secrète
// (le seuil, tiré entre SEUIL_MIN et SEUIL_MAX à chaque manche). À son
// tour, on la chauffe de +5, +10 ou +15 °C puis on la passe : celui qui
// atteint le seuil la fait exploser et perd la manche. Premier à
// MANCHES_GAGNANTES manches. Indices : la patate fume (écart ≤ FUME) puis
// siffle (écart ≤ SIFFLE). Un peu plus d'un tour sur trois, un événement
// tombe pour le joueur actif (Glaçon, Four, Thermomètre, Gants, Retour à
// l'envoyeur, Courant d'air, Chauffe imposée).
//
// Sièges du moteur : "joueur" et "bot" (en 1v1, deux joueurs).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Potato), source de vérité.
// ============================================================

export const MANCHES_GAGNANTES = 2;
export const TEMP_DEPART = 40;
export const SEUIL_MIN = 70;
export const SEUIL_MAX = 130;
export const PAS = 5;
export const CHAUFFES = [5, 10, 15];
export const FUME = 25;
export const SIFFLE = 10;
export const GLACON = 15;
export const P_EVENEMENT = 0.4;
export const EVENEMENTS = ["glacon", "four", "thermo", "gants", "retour", "courant", "impose"];
// Chauffe imposée : seule la chauffe n° CHAUFFE_IMPOSEE (+10 °C) est permise
export const CHAUFFE_IMPOSEE = 1;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// État visible de la patate selon l'écart au seuil
export function indice(ecart) {
  if (ecart <= SIFFLE) return "siffle";
  return ecart <= FUME ? "fume" : "froide";
}

export const etatPatate = (d) => indice(d.seuil - d.temp);

// État montré à tous : caché pendant un Courant d'air
export const etatVisible = (d) => (d.evenement?.type === "courant" ? "cache" : etatPatate(d));

// Événement du tour de `id` (null s'il n'en a pas)
export const evenementDe = (d, id) => (d.evenement?.id === id ? d.evenement : null);

// Repères de la manche : température à laquelle la patate a été vue fumer,
// puis siffler, pour la première fois (null : pas encore)
export function reperes(d) {
  const premier = (etats) => d.obs.find((o) => etats.includes(o.i))?.t ?? null;
  return { fume: premier(["fume", "siffle"]), siffle: premier(["siffle"]) };
}

// Chauffes proposées à `id` (doublées par le Four)
export const chauffesDe = (d, id) => CHAUFFES.map((c) => c * (evenementDe(d, id)?.type === "four" ? 2 : 1));

// Chauffe n° `k` permise à `id` (Chauffe imposée : +10 °C seulement)
export const chauffePermise = (d, id, k) => k >= 0 && k < CHAUFFES.length && (evenementDe(d, id)?.type !== "impose" || k === CHAUFFE_IMPOSEE);

function tirerSeuil(rng) {
  const n = (SEUIL_MAX - SEUIL_MIN) / PAS + 1;
  return SEUIL_MIN + Math.floor(rng() * n) * PAS;
}

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  const d = {
    manches: { joueur: 0, bot: 0 },
    // Résultat de chaque manche : { gagnant, perdant, seuil, temp, chauffes }
    historique: [],
    // Numéro de l'état affiché, +1 à chaque action : écarte un clic sur une
    // vue dépassée
    vue: 0,
    termine: false,
    gagnant: null,
    // Dernière action : { id, chauffe, evenement, explose?, gants?, manche }
    dernier: null,
  };
  nouvelleManche(d, commence, rng);
  return d;
}

function nouvelleManche(d, commence, rng) {
  Object.assign(d, {
    numero: d.historique.length + 1,
    commence,
    seuil: tirerSeuil(rng),
    temp: TEMP_DEPART,
    // Chauffes de la manche : [{ id, v }] (v : degrés ajoutés)
    chauffes: [],
    // Indices vus à chaque début de tour : [{ t, i }] ; bornes hautes
    // révélées par les Gants : [températures qui auraient fait exploser]
    obs: [],
    bornes: [],
    actif: commence,
    evenement: null,
  });
  debutTour(d, rng);
}

// Début de tour : événement éventuel (Glaçon appliqué aussitôt), puis
// indice visible noté (sauf pendant un Courant d'air). `rejoue` : le joueur
// rejoue après un Retour à l'envoyeur (pas de second Retour d'affilée).
function debutTour(d, rng, { rejoue = false } = {}) {
  d.evenement = null;
  if (rng() < P_EVENEMENT) {
    // Glaçon sans effet à température de départ : un autre événement
    const possibles = EVENEMENTS.filter((e) => !(e === "glacon" && d.temp <= TEMP_DEPART) && !(e === "retour" && rejoue));
    const type = possibles[Math.floor(rng() * possibles.length)];
    d.evenement = { type, id: d.actif };
    if (type === "glacon") {
      d.evenement.avant = d.temp;
      d.temp = Math.max(TEMP_DEPART, d.temp - GLACON);
    }
  }
  if (d.evenement?.type !== "courant") d.obs.push({ t: d.temp, i: etatPatate(d) });
  // Patate reçue brûlante (renvoyée par des Gants) : elle explose aussitôt,
  // sauf si un Glaçon l'a refroidie sous le seuil ou si ses propres Gants
  // permettent de la renvoyer
  if (d.temp >= d.seuil && d.evenement?.type !== "gants") cloreManche(d, d.actif, rng, { renvoi: true });
}

// `id` chauffe la patate avec la chauffe n° `k` (0, 1, 2).
export function chauffer(d, id, k, { rng = Math.random } = {}) {
  if (d.termine) return { erreur: "termine" };
  if (d.actif !== id) return { erreur: "pasTonTour" };
  if (!chauffePermise(d, id, k)) return { erreur: k >= 0 && k < CHAUFFES.length ? "impose" : "choix" };
  const chauffe = chauffesDe(d, id)[k];
  const evenement = evenementDe(d, id);
  d.vue += 1;
  const avant = d.temp;
  if (avant + chauffe >= d.seuil) {
    // Gants : la patate passe brûlante à l'adversaire (chauffe comprise) ;
    // elle lui explose dans les mains au début de son tour, sauf si son
    // événement le sauve (debutTour())
    if (evenement?.type === "gants") {
      const manches = d.historique.length;
      d.temp = avant + chauffe;
      d.chauffes.push({ id, v: chauffe });
      d.bornes.push(d.temp);
      d.dernier = { id, chauffe, evenement, gants: true, manche: d.numero };
      passer(d, rng);
      return d.historique.length > manches ? { explose: true } : {};
    }
    d.temp = avant + chauffe;
    d.chauffes.push({ id, v: chauffe });
    d.dernier = { id, chauffe, evenement, explose: true, manche: d.numero };
    cloreManche(d, id, rng);
    return { explose: true };
  }
  d.temp = avant + chauffe;
  d.chauffes.push({ id, v: chauffe });
  d.dernier = { id, chauffe, evenement, manche: d.numero };
  // Retour à l'envoyeur : la patate revient, le même joueur rejoue
  if (evenement?.type === "retour") {
    d.dernier.retour = true;
    debutTour(d, rng, { rejoue: true });
    return {};
  }
  passer(d, rng);
  return {};
}

function passer(d, rng) {
  d.actif = adversaire(d.actif);
  debutTour(d, rng);
}

// Manche perdue par `perdant` : point à l'autre, partie gagnée à
// MANCHES_GAGNANTES, sinon nouvelle manche que le perdant commence.
// `renvoi` : explosion d'une patate renvoyée par des Gants.
function cloreManche(d, perdant, rng, { renvoi = false } = {}) {
  const gagnant = adversaire(perdant);
  d.historique.push({ gagnant, perdant, seuil: d.seuil, temp: d.temp, chauffes: d.chauffes.map((c) => ({ ...c })), ...(renvoi ? { renvoi: true } : {}) });
  d.manches[gagnant] += 1;
  if (d.manches[gagnant] >= MANCHES_GAGNANTES) {
    Object.assign(d, { termine: true, gagnant, evenement: null });
    return;
  }
  nouvelleManche(d, perdant, rng);
}

// ── Kévina ───────────────────────────────────────────────────────────────
// Kévina garde en tête les seuils encore possibles (indices vus depuis le
// début de la manche, bornes révélées par les Gants) et choisit la chauffe
// qui minimise son risque d'explosion tout en maximisant celui de
// l'adversaire au tour suivant (même avec sa plus petite chauffe).
// Égalité : au hasard. Avec la probabilité `erreur`, chauffe au hasard
// (jamais contre une Chauffe imposée). Retour à l'envoyeur : seul son propre
// risque compte, puisqu'elle rejoue.

// Seuils compatibles avec tout ce qui est public dans la manche
export function seuilsPossibles(d) {
  const max = Math.min(SEUIL_MAX, ...d.bornes);
  const out = [];
  for (let s = SEUIL_MIN; s <= max; s += PAS) {
    if (s > d.temp && d.obs.every((o) => indice(s - o.t) === o.i)) out.push(s);
  }
  return out.length ? out : [d.seuil];
}

const part = (set, t) => set.filter((s) => t >= s).length / set.length;

export function choixKevina(d, id, { erreur = 0, rng = Math.random } = {}) {
  const ev = evenementDe(d, id);
  if (ev?.type === "impose") return CHAUFFE_IMPOSEE;
  if (rng() < erreur) return Math.floor(rng() * CHAUFFES.length);
  // Gants : aucun risque, et chauffer au maximum donne le plus de chances
  // de renvoyer une patate brûlante
  if (ev?.type === "gants") return CHAUFFES.length - 1;
  const set = ev?.type === "thermo" ? [d.seuil] : seuilsPossibles(d);
  const valeurs = chauffesDe(d, id).map((c) => {
    const t = d.temp + c;
    const p = part(set, t);
    const reste = set.filter((s) => s > t);
    // Retour à l'envoyeur : c'est elle qui rejoue, piéger l'adversaire ne sert à rien
    const q = reste.length && ev?.type !== "retour" ? part(reste, t + CHAUFFES[0]) : 0;
    return -p + (1 - p) * q;
  });
  const best = Math.max(...valeurs);
  const ex = valeurs.map((v, k) => (v >= best - 1e-9 ? k : -1)).filter((k) => k >= 0);
  return ex[Math.floor(rng() * ex.length)];
}
