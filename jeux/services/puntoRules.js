// ============================================================
// puntoRules.js — Règles pures de Punto (`/punto`) : grille commune de
// 5×5 cases. Chaque joueur a sa pioche de 36 cartes, 2 couleurs de 1 à 9
// élixir en double. À son tour, on retourne la carte du dessus de sa pioche
// et on la pose sur une case vide voisine d'une carte (côté ou coin), ou
// sur une carte de valeur inférieure (quelle que soit sa couleur), qu'elle
// recouvre. Le premier qui aligne 4 cartes d'une même couleur gagne.
// Carte impossible à poser : défaussée, tour suivant. Pioches vides sans
// alignement : match nul.
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (tests, simulation).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Punto), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const TAILLE = 5;
export const ALIGNEMENT = 4;
export const NB_CASES = TAILLE * TAILLE;
// La première carte de la partie se pose au centre
export const CENTRE = (TAILLE * TAILLE - 1) / 2;
// Couleurs par joueur (indices 0 et 1), valeurs de 1 à 9, chaque carte en double
export const NB_COULEURS = 2;
export const VALEUR_MAX = 9;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// Directions d'alignement : horizontale, verticale, deux diagonales
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

const ligneDe = (i) => Math.floor(i / TAILLE);
const colonneDe = (i) => i % TAILLE;
const dansGrille = (r, c) => r >= 0 && c >= 0 && r < TAILLE && c < TAILLE;

// Cases voisines (côtés et coins)
const VOISINS = Array.from({ length: NB_CASES }, (_, i) => {
  const voisins = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = ligneDe(i) + dr;
      const c = colonneDe(i) + dc;
      if ((dr || dc) && dansGrille(r, c)) voisins.push(r * TAILLE + c);
    }
  }
  return voisins;
});

function melanger(cartes, rng) {
  for (let i = cartes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cartes[i], cartes[j]] = [cartes[j], cartes[i]];
  }
  return cartes;
}

// Pioche d'un joueur : 2 couleurs × valeurs 1 à 9 × 2 exemplaires, mélangée.
// Carte : { k (couleur 0 ou 1), v (valeur) }.
function pioche(rng) {
  const cartes = [];
  for (let k = 0; k < NB_COULEURS; k++) {
    for (let v = 1; v <= VALEUR_MAX; v++) cartes.push({ k, v }, { k, v });
  }
  return melanger(cartes, rng);
}

// Même carte (couleur et valeur)
export const memeCarte = (a, b) => Boolean(a && b) && a.k === b.k && a.v === b.v;

// Case jouable par `carte` : vide et voisine d'une carte, ou occupée par une
// carte de valeur inférieure. Grille vide : le centre seulement.
export function casesJouables(grille, carte) {
  if (grille.every((x) => !x)) return [CENTRE];
  const cases = [];
  for (let i = 0; i < NB_CASES; i++) {
    const x = grille[i];
    if (x ? x.v < carte.v : VOISINS[i].some((j) => grille[j])) cases.push(i);
  }
  return cases;
}

// Cases alignées passant par la case `i` : toutes les lignes d'au moins 4
// cartes du même joueur et de la même couleur, sinon [].
export function alignementsDepuis(grille, i) {
  const x = grille[i];
  if (!x) return [];
  const meme = (j) => grille[j] && grille[j].s === x.s && grille[j].k === x.k;
  const cases = [];
  for (const [dr, dc] of DIRECTIONS) {
    const ligne = [];
    for (const sens of [1, -1]) {
      for (let k = 1; ; k++) {
        const r = ligneDe(i) + sens * k * dr;
        const c = colonneDe(i) + sens * k * dc;
        if (!dansGrille(r, c) || !meme(r * TAILLE + c)) break;
        ligne.push(r * TAILLE + c);
      }
    }
    if (ligne.length + 1 >= ALIGNEMENT) cases.push(...ligne);
  }
  return cases.length ? [i, ...cases] : [];
}

// Retourne la carte du dessus de la pioche de `id` (d.carte), en défaussant
// celles qui ne peuvent être posées nulle part (d.defausses, racontées par
// la vue) et en passant alors au joueur suivant. Pioches vides : match nul.
function tourSuivant(d, id) {
  for (let essai = 0; essai <= 2 * NB_COULEURS * VALEUR_MAX * 2; essai++) {
    const carte = d.pioches[id].pop();
    if (!carte) {
      d.termine = true;
      d.gagnant = "nul";
      d.carte = null;
      return;
    }
    d.actif = id;
    d.carte = carte;
    if (casesJouables(d.grille, carte).length) return;
    d.defausses.push({ id, carte });
    id = adversaire(id);
  }
}

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  const d = {
    // Case : null ou la carte du dessus { s (siège), k, v } ; les cartes
    // recouvertes ne comptent plus
    grille: Array(NB_CASES).fill(null),
    pioches: { joueur: pioche(rng), bot: pioche(rng) },
    actif: commence,
    // Carte à poser par le joueur actif
    carte: null,
    coups: 0,
    // Dernier coup : { id, case, carte, recouverte (carte recouverte ou null) }
    dernier: null,
    // Cartes défaussées depuis le dernier coup : [{ id, carte }]
    defausses: [],
    termine: false,
    gagnant: null,
    // Cases de l'alignement gagnant
    alignement: null,
  };
  tourSuivant(d, commence);
  return d;
}

// Pose la carte du joueur actif `id` sur la case `i`, puis fin de partie ou
// tour adverse (sa carte retournée).
export function poser(d, id, i) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!Number.isInteger(i) || i < 0 || i >= NB_CASES) return { erreur: "Case inconnue." };
  if (!casesJouables(d.grille, d.carte).includes(i)) return { erreur: "Case interdite." };

  const carte = d.carte;
  const recouverte = d.grille[i];
  d.grille[i] = { s: id, k: carte.k, v: carte.v };
  d.coups += 1;
  d.dernier = { id, case: i, carte, recouverte };
  d.defausses = [];
  d.carte = null;

  const alignement = alignementsDepuis(d.grille, i);
  if (alignement.length) {
    d.termine = true;
    d.gagnant = id;
    d.alignement = alignement;
  } else {
    tourSuivant(d, adversaire(id));
  }
  return { case: i, carte, recouverte, victoire: alignement.length > 0 };
}

// ── Kévina ────────────────────────────────────────────────────────

// Toutes les fenêtres de 4 cases alignées de la grille (28).
const FENETRES = [];
for (let r = 0; r < TAILLE; r++) {
  for (let c = 0; c < TAILLE; c++) {
    for (const [dr, dc] of DIRECTIONS) {
      if (!dansGrille(r + (ALIGNEMENT - 1) * dr, c + (ALIGNEMENT - 1) * dc)) continue;
      FENETRES.push(Array.from({ length: ALIGNEMENT }, (_, k) => (r + k * dr) * TAILLE + c + k * dc));
    }
  }
}

// Potentiel de `id` : fenêtres sans carte étrangère (autre joueur ou autre
// couleur), au cube du nombre de cartes de la couleur (une fenêtre de 3
// cartes vaut bien plus que trois fenêtres d'une carte). `solidite` :
// bonus pour les cartes chères, plus dures à recouvrir.
function potentiel(grille, id, solidite = 0) {
  let total = 0;
  for (const fenetre of FENETRES) {
    let k = null;
    let n = 0;
    let somme = 0;
    for (const i of fenetre) {
      const x = grille[i];
      if (!x) continue;
      if (x.s !== id || (k !== null && x.k !== k)) {
        n = 0;
        break;
      }
      k = x.k;
      n++;
      somme += x.v;
    }
    if (n) total += n * n * n * (1 + (solidite * somme) / (VALEUR_MAX * n));
  }
  return total;
}

// Risque que `id` gagne à son prochain coup : pour chaque case qui
// compléterait un alignement d'une de ses couleurs, probabilité que sa
// prochaine carte (inconnue) soit de cette couleur et assez forte pour
// s'y poser. Approximation sur une pioche complète : 1 chance sur 2 pour la
// couleur, (9 − valeur recouverte) / 9 pour la valeur.
function risque(grille, id) {
  let total = 0;
  for (let k = 0; k < NB_COULEURS; k++) {
    for (let i = 0; i < NB_CASES; i++) {
      const x = grille[i];
      if (x?.s === id && x.k === k) continue;
      if (!x && !VOISINS[i].some((j) => grille[j])) continue;
      grille[i] = { s: id, k, v: VALEUR_MAX };
      const gagne = alignementsDepuis(grille, i).length > 0;
      grille[i] = x;
      if (gagne) total += (1 / NB_COULEURS) * ((VALEUR_MAX - (x?.v ?? 0)) / VALEUR_MAX);
    }
  }
  return total;
}

// Kévina joue la case qui maximise son potentiel moins `defense` fois celui
// de l'adversaire, moins `prudence` fois le risque qu'il gagne au coup
// suivant (`solidite` : voir potentiel()). Elle gagne dès qu'elle peut.
// `marge` : case tirée au sort parmi celles à `marge` points au plus de la
// meilleure (variété, et des erreurs qui laissent sa chance au joueur).
// Réglages : `defense_kevina`, `prudence_kevina`, `solidite_kevina`,
// `marge_kevina` de duel.json.
export function choixKevina(d, id, { defense = 1, prudence = 0, solidite = 0, marge = 0, rng = Math.random } = {}) {
  const grille = [...d.grille];
  const cases = casesJouables(grille, d.carte);
  const adv = adversaire(id);
  const valeurs = [];
  for (const i of cases) {
    const avant = grille[i];
    grille[i] = { s: id, k: d.carte.k, v: d.carte.v };
    if (alignementsDepuis(grille, i).length) return i;
    const v = potentiel(grille, id, solidite) - defense * potentiel(grille, adv, solidite) - prudence * 1000 * risque(grille, adv);
    grille[i] = avant;
    valeurs.push({ i, v });
  }
  const max = Math.max(...valeurs.map((x) => x.v));
  const meilleures = valeurs.filter((x) => x.v >= max - marge).map((x) => x.i);
  return meilleures[Math.floor(rng() * meilleures.length)];
}

export function choixHasard(d, id, rng = Math.random) {
  const cases = casesJouables(d.grille, d.carte);
  return cases[Math.floor(rng() * cases.length)];
}
