// ============================================================
// bacRules.js — Règles pures du Petit Bac en duel (`/bac`) : 5 manches,
// un thème et une lettre par manche, les deux joueurs répondent en même
// temps (réponses cachées jusqu'à la fin de la manche). Jusqu'à 2
// propositions par manche, résultat immédiat ; une proposition acceptée
// remplace la précédente, une refusée ne change rien. « Passer » fige la
// réponse. Points : 1 par bonne réponse, 0,5 chacun pour la même bonne
// réponse.
//
// Validation : listes de mots par thème (jeux/data/bac/<thème>.json,
// générées par jeux/outils/bac/genererListes.mjs depuis des sources
// publiques), tolérante à la casse, aux accents, aux séparateurs, à
// l'article de tête et au pluriel ; une réponse composée est acceptée si
// son mot principal est dans la liste (« merle de Lawrence » : « merle »).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Petit Bac), source de vérité.
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOSSIER = path.resolve(__dirname, "..", "data", "bac");

export const IDS = ["joueur", "bot"];
export const NB_MANCHES = 5;
export const PROPOSITIONS_MAX = 2;
// Lettre tirée seulement si Kévina en connaît au moins MOTS_MIN_KEVINA et
// la liste au moins MOTS_MIN_ACCEPTES : pas de manche injouable
export const MOTS_MIN_KEVINA = 2;
export const MOTS_MIN_ACCEPTES = 10;

export const THEMES = {
  animaux: "Animaux",
  pays: "Pays",
  villes: "Villes",
  prenoms: "Prénoms",
  fruits: "Fruits et légumes",
  metiers: "Métiers",
  sports: "Sports",
  clash: "Cartes Clash Royale",
};

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// ── Normalisation ─────────────────────────────────────────────────────

// Minuscules, sans accents ni ligatures, lettres et chiffres seulement.
export function normaliser(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Mots ignorés en tête d'une réponse composée (articles, adjectifs) pour
// trouver son mot principal.
export const MOTS_VIDES_TETE = new Set(
  ["le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "grand", "grande", "petit", "petite", "gros", "grosse", "faux", "fausse", "vrai", "vraie", "demi", "jeune", "vieux", "vieille"].map(normaliser),
);

// Article de tête retiré (« le Mali », « l'Inde »)
const sansArticle = (s) => s.replace(/^\s*(le|la|les|un|une|des)\s+/i, "").replace(/^\s*l['’]\s*/i, "");

// Variantes au singulier d'une clé (« kiwis », « chevaux »)
function singuliers(cle) {
  const v = [cle];
  if (cle.endsWith("aux")) v.push(`${cle.slice(0, -3)}al`);
  if (/[sx]$/.test(cle)) v.push(cle.slice(0, -1));
  return v;
}

// ── Thèmes (chargés à la demande) ─────────────────────────────────────

const _themes = new Map();

export function chargerTheme(id) {
  if (!_themes.has(id)) {
    const t = JSON.parse(fs.readFileSync(path.join(DOSSIER, `${id}.json`), "utf8"));
    const cles = new Map();
    // Avec et sans article de tête (« Le Havre » : aussi « Havre »)
    for (const m of t.mots) for (const f of [m, sansArticle(m)]) if (normaliser(f) && !cles.has(normaliser(f))) cles.set(normaliser(f), m);
    const kevina = new Map();
    for (const m of t.kevina) {
      const l = normaliser(sansArticle(m))[0]?.toUpperCase();
      if (!l) continue;
      if (!kevina.has(l)) kevina.set(l, []);
      kevina.get(l).push(m);
    }
    // Mots acceptés par initiale
    const parLettre = new Map();
    for (const c of cles.keys()) parLettre.set(c[0].toUpperCase(), (parLettre.get(c[0].toUpperCase()) ?? 0) + 1);
    _themes.set(id, { id, nom: t.nom, cles, kevina, parLettre });
  }
  return _themes.get(id);
}

// Lettres jouables d'un thème (assez de mots pour Kévina et pour le joueur)
export function lettresJouables(themeId) {
  const t = chargerTheme(themeId);
  return [...t.kevina]
    .filter(([l, mots]) => mots.length >= MOTS_MIN_KEVINA && (t.parLettre.get(l) ?? 0) >= MOTS_MIN_ACCEPTES)
    .map(([l]) => l)
    .sort();
}

// Clé de liste d'une forme : la forme entière, son mot principal (et la
// partie avant un trait d'union), au singulier ; null si rien ne correspond.
function cleDans(t, forme) {
  const essais = [normaliser(forme)];
  const mots = forme.trim().split(/\s+/);
  const k = mots.findIndex((m) => !MOTS_VIDES_TETE.has(normaliser(m)));
  if (mots.length > 1 && k >= 0) essais.push(normaliser(mots[k]));
  if (k >= 0 && mots[k].includes("-")) essais.push(normaliser(mots[k].split("-")[0]));
  for (const e of essais) for (const c of singuliers(e)) if (c && t.cles.has(c)) return c;
  return null;
}

// Validation d'une réponse : { ok, cle, raison } (raison : "vide",
// "lettre", "inconnu"). La forme avec ou sans article de tête peut porter
// la lettre (« La Rochelle » vaut pour L et R).
export function valider(themeId, lettre, mot) {
  const t = chargerTheme(themeId);
  const brut = String(mot ?? "").trim();
  if (!normaliser(brut)) return { ok: false, raison: "vide" };
  const formes = [...new Set([brut, sansArticle(brut)])].filter((f) => normaliser(f));
  const bonnesLettres = formes.filter((f) => normaliser(f)[0] === lettre.toLowerCase());
  if (!bonnesLettres.length) return { ok: false, raison: "lettre" };
  for (const f of bonnesLettres) {
    const cle = cleDans(t, f);
    if (cle) return { ok: true, cle };
  }
  return { ok: false, raison: "inconnu" };
}

// Forme d'affichage d'une réponse acceptée (première lettre en majuscule)
const affichage = (mot) => {
  const m = String(mot).trim().replace(/\s+/g, " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
};

// ── Partie ────────────────────────────────────────────────────────────

function melange(a, rng) {
  const t = [...a];
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

// Nouvelle partie : 5 thèmes différents tirés d'avance, la 1re manche
// commence (`now` : début de la manche, pour le chrono).
export function creerDuel({ rng = Math.random, now = Date.now(), pvp = false } = {}) {
  const d = {
    themes: melange(Object.keys(THEMES), rng).slice(0, NB_MANCHES),
    manches: [],
    scores: { joueur: 0, bot: 0 },
    // Numéro de l'état affiché, +1 à chaque action : écarte un clic sur une
    // vue dépassée
    vue: 0,
    pvp,
    termine: false,
    gagnant: null,
  };
  nouvelleManche(d, rng, now);
  return d;
}

// Manche : thème suivant, lettre tirée parmi les lettres jouables.
function nouvelleManche(d, rng, now) {
  const theme = d.themes[d.manches.length];
  const lettres = lettresJouables(theme);
  d.manches.push({
    theme,
    lettre: lettres[Math.floor(rng() * lettres.length)],
    debut: now,
    // Réponse acceptée : { mot, cle } ; dernière refusée : { mot, raison }
    reponses: { joueur: null, bot: null },
    refus: { joueur: null, bot: null },
    essais: { joueur: 0, bot: 0 },
    // Réponse figée (2 propositions, Passer, fin du temps)
    fige: { joueur: false, bot: false },
    points: null,
  });
}

export const mancheCourante = (d) => d.manches.at(-1);
// Manche en cours de jeu (pas encore close)
export const mancheOuverte = (d) => !d.termine && mancheCourante(d).points === null;

// Proposition de `id` : { erreur } ou { ok, raison }. Acceptée, elle
// remplace la réponse précédente ; la 2e proposition fige la réponse.
export function proposer(d, id, mot) {
  if (d.termine) return { erreur: "termine" };
  const m = mancheCourante(d);
  if (m.points !== null) return { erreur: "close" };
  if (m.fige[id]) return { erreur: "fige" };
  const v = valider(m.theme, m.lettre, mot);
  m.essais[id] += 1;
  if (v.ok) {
    m.reponses[id] = { mot: affichage(mot), cle: v.cle };
    m.refus[id] = null;
  } else m.refus[id] = { mot: String(mot ?? "").trim().slice(0, 40), raison: v.raison };
  if (m.essais[id] >= PROPOSITIONS_MAX) m.fige[id] = true;
  d.vue += 1;
  if (m.fige.joueur && m.fige.bot) cloreManche(d);
  return { ok: v.ok, raison: v.raison ?? null };
}

// « Passer » : la réponse de `id` est figée (sa réponse acceptée compte).
export function passer(d, id) {
  if (d.termine) return { erreur: "termine" };
  const m = mancheCourante(d);
  if (m.points !== null) return { erreur: "close" };
  if (m.fige[id]) return { erreur: "fige" };
  m.fige[id] = true;
  d.vue += 1;
  if (m.fige.joueur && m.fige.bot) cloreManche(d);
  return {};
}

// Fin de la manche (les deux réponses figées, ou temps écoulé) : points,
// fin de partie après la 5e.
export function cloreManche(d) {
  const m = mancheCourante(d);
  if (m.points !== null) return;
  m.fige = { joueur: true, bot: true };
  const [a, b] = [m.reponses.joueur, m.reponses.bot];
  const meme = a && b && a.cle === b.cle;
  m.points = { joueur: a ? (meme ? 0.5 : 1) : 0, bot: b ? (meme ? 0.5 : 1) : 0 };
  d.scores.joueur += m.points.joueur;
  d.scores.bot += m.points.bot;
  d.vue += 1;
  if (d.manches.length >= NB_MANCHES) {
    d.termine = true;
    const [j, k] = [d.scores.joueur, d.scores.bot];
    d.gagnant = j === k ? "nul" : j > k ? "joueur" : "bot";
  }
}

// Temps de la manche écoulé (`delaiMs` depuis son début)
export const tempsEcoule = (d, delaiMs, now = Date.now()) => mancheOuverte(d) && now - mancheCourante(d).debut > delaiMs;

// Manche suivante, après la pause sur le résultat
export function mancheSuivante(d, { rng = Math.random, now = Date.now() } = {}) {
  if (d.termine) return { erreur: "termine" };
  if (mancheOuverte(d)) return { erreur: "ouverte" };
  nouvelleManche(d, rng, now);
  d.vue += 1;
  return {};
}

// ── Kévina ────────────────────────────────────────────────────────────

// Réponse de Kévina : un mot courant du thème au hasard, trouvé avec la
// probabilité `trouve` (sinon rien) ; réponse figée aussitôt.
export function jouerKevina(d, id, { trouve = 0.8, rng = Math.random } = {}) {
  const m = mancheCourante(d);
  const pool = chargerTheme(m.theme).kevina.get(m.lettre) ?? [];
  if (pool.length && rng() < trouve) proposer(d, id, pool[Math.floor(rng() * pool.length)]);
  if (!m.fige[id]) passer(d, id);
}

// Score affiché : « 2,5 »
export const formatPoints = (n) => String(n).replace(".", ",");
