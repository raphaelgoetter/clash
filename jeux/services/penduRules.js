// ============================================================
// penduRules.js — Règles pures du Pendu en duel (`/pendu`, 1v1 seulement) :
// les deux joueurs cherchent le MÊME mot, chacun de son côté, sans voir
// l'avancement de l'autre ; le mot et les deux potences ne sont dévoilés
// qu'une fois les deux parties finies.
//
// Duel : { mot (forme affichée, accents compris), cible (lettres A-Z sans
// accent), joueurs: { joueur, bot } (sièges du moteur, comme les autres
// duels), termine, gagnant: "joueur" | "bot" | "nul" | null, abandon }.
// Joueur : { lettres: [proposées, dans l'ordre], erreurs, motsFaux: [mots
// proposés à tort], fin: null | "trouve" | "pendu" | "temps", dernierCoupAt }.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Pendu), source de vérité.
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOTS_JSON_PATH = path.resolve(__dirname, "..", "data", "pendu", "mots.json");

export const ERREURS_MAX = 6;
// Mot proposé à tort : deux traits d'un coup
export const ERREURS_MOT_FAUX = 2;
export const VOYELLES = ["A", "E", "I", "O", "U", "Y"];
export const CONSONNES = [..."BCDFGHJKLMNPQRSTVWXZ"];
export const SIEGES = ["joueur", "bot"];

export const adversaire = (siege) => (siege === "joueur" ? "bot" : "joueur");

// Lettres sans accent, en majuscules (« Éléphant » → « ELEPHANT »)
export const normaliser = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

let _mots = null;
export function chargerMots() {
  if (!_mots) _mots = JSON.parse(fs.readFileSync(MOTS_JSON_PATH, "utf8")).mots;
  return _mots;
}

export function tirerMot({ rng = Math.random } = {}) {
  const mots = chargerMots();
  return mots[Math.floor(rng() * mots.length)];
}

const nouveauJoueur = (now) => ({ lettres: [], erreurs: 0, motsFaux: [], fin: null, dernierCoupAt: now });

export function creerDuel({ mot = null, now = Date.now(), rng = Math.random } = {}) {
  const m = mot ?? tirerMot({ rng });
  return {
    mot: m,
    cible: normaliser(m),
    joueurs: { joueur: nouveauJoueur(now), bot: nouveauJoueur(now) },
    termine: false,
    gagnant: null,
    abandon: null,
  };
}

// Motif vu par un joueur : lettres trouvées, « _ » ailleurs (« EL_PH_NT »).
// Partie finie par « trouve » : mot entier.
export function motif(d, siege) {
  const j = d.joueurs[siege];
  if (j.fin === "trouve") return d.cible;
  return [...d.cible].map((c) => (j.lettres.includes(c) ? c : "_")).join("");
}

export const lettresFausses = (d, siege) => d.joueurs[siege].lettres.filter((l) => !d.cible.includes(l));

// Lettres du mot découvertes (positions), départage de deux pendus
export const lettresDecouvertes = (d, siege) => [...motif(d, siege)].filter((c) => c !== "_").length;

export const enCours = (d, siege) => !d.termine && d.joueurs[siege].fin === null;

function ajouterErreurs(j, n) {
  j.erreurs = Math.min(ERREURS_MAX, j.erreurs + n);
  if (j.erreurs >= ERREURS_MAX) j.fin = "pendu";
}

// Propose une lettre. Renvoie { ok: true, present, nb } ou { erreur }.
export function proposerLettre(d, siege, lettre, { now = Date.now() } = {}) {
  const l = normaliser(lettre);
  if (l.length !== 1) return { erreur: "lettre" };
  const j = d.joueurs[siege];
  if (!enCours(d, siege)) return { erreur: "fini" };
  if (j.lettres.includes(l)) return { erreur: "dejaJouee" };
  j.lettres.push(l);
  j.dernierCoupAt = now;
  const nb = [...d.cible].filter((c) => c === l).length;
  if (!nb) ajouterErreurs(j, 1);
  else if (!motif(d, siege).includes("_")) j.fin = "trouve";
  finirSiPossible(d);
  return { ok: true, present: nb > 0, nb };
}

// Propose le mot entier (accents et casse ignorés). Faux : ERREURS_MOT_FAUX
// traits. Renvoie { ok: true, juste } ou { erreur }.
export function proposerMot(d, siege, mot, { now = Date.now() } = {}) {
  const m = normaliser(mot);
  if (!m) return { erreur: "vide" };
  const j = d.joueurs[siege];
  if (!enCours(d, siege)) return { erreur: "fini" };
  j.dernierCoupAt = now;
  const juste = m === d.cible;
  if (juste) j.fin = "trouve";
  else {
    j.motsFaux.push(String(mot).trim().slice(0, 40));
    ajouterErreurs(j, ERREURS_MOT_FAUX);
  }
  finirSiPossible(d);
  return { ok: true, juste };
}

// Délai dépassé (`delaiMs` sans action) : le joueur est pendu (fin
// "temps"). Renvoie les sièges concernés.
export function appliquerDelais(d, delaiMs, now = Date.now()) {
  if (d.termine) return [];
  const sieges = SIEGES.filter((s) => enCours(d, s) && now - d.joueurs[s].dernierCoupAt > delaiMs);
  for (const s of sieges) d.joueurs[s].fin = "temps";
  finirSiPossible(d);
  return sieges;
}

// Échéance (ms) du joueur encore en jeu, null s'il a fini
export const echeance = (d, siege, delaiMs) => (enCours(d, siege) ? d.joueurs[siege].dernierCoupAt + delaiMs : null);

// Départage, une fois les deux parties finies : le mot trouvé l'emporte ;
// deux mots trouvés : le moins d'erreurs (égalité : nul) ; deux pendus :
// le plus de lettres découvertes (égalité : nul).
export function departager(d) {
  const [a, b] = SIEGES.map((s) => d.joueurs[s]);
  const trouveA = a.fin === "trouve";
  const trouveB = b.fin === "trouve";
  if (trouveA !== trouveB) return trouveA ? "joueur" : "bot";
  const [x, y] = trouveA ? [b.erreurs, a.erreurs] : [lettresDecouvertes(d, "joueur"), lettresDecouvertes(d, "bot")];
  return x === y ? "nul" : x > y ? "joueur" : "bot";
}

function finirSiPossible(d) {
  if (d.termine || SIEGES.some((s) => d.joueurs[s].fin === null)) return;
  d.termine = true;
  d.gagnant = departager(d);
}

// Abandon : défaite immédiate, quelle que soit la partie de l'adversaire
export function abandonner(d, siege) {
  if (d.termine) return { erreur: "termine" };
  Object.assign(d, { termine: true, gagnant: adversaire(siege), abandon: siege });
  return { ok: true };
}
