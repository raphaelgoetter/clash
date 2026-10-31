// ============================================================
// sixRules.js — Règles pures de Six (`/six`), duel de collecte inspiré du
// 6 qui prend : pioche commune de 45 cartes de 1 à 9 (cartes de Punto) en
// 3 couleurs : celle du premier joueur et celle du second (en double),
// neutre (une fois). 4 colonnes. À son tour, on retourne la carte du
// dessus de la pioche et on la pose sur une colonne dont la dernière carte
// est plus faible (au choix s'il y en a plusieurs) ; plus forte nulle
// part, elle va sur la colonne de son choix (pose libre). La 6e carte
// d'une colonne la ferme : on marque 1 point par carte de SA couleur parmi
// les 5 ramassées, la 6e reste. La prochaine carte (celle de l'adversaire)
// est visible. Premier à SEUIL points gagne ; pioche vide avant : le plus
// de points gagne.
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (tests, simulation).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Six), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const NB_COLONNES = 4;
// La 6e carte d'une colonne la ferme
export const LIMITE = 6;
export const VALEUR_MAX = 9;
// Couleurs du moteur : celle de chaque joueur, et la neutre
export const COULEUR = { joueur: 0, bot: 1 };
export const NEUTRE = 2;
// Exemplaires de chaque valeur par couleur (joueur, bot, neutre)
const EXEMPLAIRES = [2, 2, 1];
// Points qui font gagner
export const SEUIL = 5;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

function melanger(cartes, rng) {
  for (let i = cartes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cartes[i], cartes[j]] = [cartes[j], cartes[i]];
  }
  return cartes;
}

// Pioche commune : valeurs 1 à 9, 2 exemplaires dans la couleur de chaque
// joueur, 1 en neutre (45 cartes), mélangée. Carte : { k (couleur), v }.
function pioche(rng) {
  const cartes = [];
  EXEMPLAIRES.forEach((n, k) => {
    for (let v = 1; v <= VALEUR_MAX; v++) for (let e = 0; e < n; e++) cartes.push({ k, v });
  });
  return melanger(cartes, rng);
}

// Cartes de la couleur de `id` parmi `cartes` (celles qui lui rapportent)
export const sesCartes = (cartes, id) => cartes.filter((c) => c.k === COULEUR[id]);

const derniere = (colonne) => colonne[colonne.length - 1];

// Type du coup « `carte` sur la colonne `c` » : "pose", "libre", "fermeture"
// (6e carte : ramasse les 5 premières), ou null si la colonne est interdite
// (carte pas plus forte ici alors qu'elle l'est ailleurs).
export function typeCoup(colonnes, carte, c) {
  const monte = (col) => carte.v > derniere(col).v;
  if (!monte(colonnes[c]) && colonnes.some(monte)) return null;
  if (colonnes[c].length === LIMITE - 1) return "fermeture";
  return monte(colonnes[c]) ? "pose" : "libre";
}

// Cartes ramassées par un coup de ce type sur `colonne` ([] sans fermeture)
const ramassees = (colonne, type) => (type === "fermeture" ? [...colonne] : []);

// Colonnes après le coup (copie, `colonnes` intact)
function appliquer(colonnes, carte, c, type) {
  return colonnes.map((col, i) => (i !== c ? col : type === "fermeture" ? [carte] : [...col, carte]));
}

// Les coups permis de `carte` (par défaut celle du joueur actif) pour `id`
// (par défaut le joueur actif), un par colonne autorisée :
// { c, type, gain (points marqués) }.
export function coupsPossibles(d, carte = d.carte, id = d.actif) {
  return d.colonnes.flatMap((col, c) => {
    const type = typeCoup(d.colonnes, carte, c);
    return type ? [{ c, type, gain: sesCartes(ramassees(col, type), id).length }] : [];
  });
}

// Prochaine carte de la pioche (celle de l'adversaire au tour suivant),
// visible de tous ; null si la pioche est vide.
export const prochaine = (d) => d.pioche[d.pioche.length - 1] ?? null;

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  const cartes = pioche(rng);
  const colonnes = Array.from({ length: NB_COLONNES }, () => [cartes.pop()]);
  return {
    colonnes,
    pioche: cartes,
    // Carte à poser par le joueur actif (visible de tous)
    carte: cartes.pop(),
    actif: commence,
    points: { joueur: 0, bot: 0 },
    // Cartes marquées par chaque joueur (de sa couleur), dans l'ordre
    // (récapitulatif de fin)
    marquees: { joueur: [], bot: [] },
    coups: 0,
    // Numéro de l'état affiché, +1 à chaque coup : écarte un clic sur une
    // vue dépassée
    vue: 0,
    // Dernier coup : { id, carte, colonne, type, ramassees, gain }
    dernier: null,
    termine: false,
    gagnant: null,
    // Fin : "seuil" (un joueur a atteint SEUIL points) ou "pioche" (vide)
    fin: null,
  };
}

// Pose la carte du joueur actif `id` sur la colonne `c`, puis fin de
// partie (seuil atteint ou pioche vide) ou tour adverse (carte retournée).
export function jouer(d, id, c) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!Number.isInteger(c) || c < 0 || c >= NB_COLONNES) return { erreur: "Coup inconnu." };

  const carte = d.carte;
  const type = typeCoup(d.colonnes, carte, c);
  if (!type) return { erreur: "Colonne interdite." };
  const prises = ramassees(d.colonnes[c], type);
  const marquees = sesCartes(prises, id);
  d.colonnes = appliquer(d.colonnes, carte, c, type);
  d.points[id] += marquees.length;
  d.marquees[id].push(...marquees);
  d.coups += 1;
  d.vue += 1;
  d.dernier = { id, carte, colonne: c, type, ramassees: prises, gain: marquees.length };

  if (d.points[id] >= SEUIL || !d.pioche.length) {
    d.termine = true;
    d.fin = d.points[id] >= SEUIL ? "seuil" : "pioche";
    d.carte = null;
    const { joueur, bot } = d.points;
    d.gagnant = joueur === bot ? "nul" : joueur > bot ? "joueur" : "bot";
  } else {
    d.actif = adversaire(id);
    d.carte = d.pioche.pop();
  }
  return { carte, type, gain: marquees.length };
}

// ── Kévina ────────────────────────────────────────────────────────

// Points que `id` marquera au mieux à son tour avec `carte` (la prochaine,
// visible de tous ; 0 sans carte).
function gainAdverse(colonnes, id, carte) {
  if (!carte) return 0;
  return Math.max(...coupsPossibles({ colonnes }, carte, id).map((x) => x.gain));
}

// Marche au-dessus de la dernière carte (départage : la plus petite garde
// les colonnes souples)
const marche = (d, x) => (x.type === "pose" ? d.carte.v - derniere(d.colonnes[x.c]).v : 20);

// Kévina maximise ses points marqués moins ceux que l'adversaire marquera
// au mieux à son tour suivant avec la prochaine carte (visible de tous),
// sans anticipation plus lointaine ; à égalité, la plus petite marche.
// `marge` : colonne tirée au sort parmi celles à `marge` points au plus de
// la meilleure (variété, et des erreurs qui laissent sa chance au joueur).
// Réglage : `marge_kevina` de duel.json. Renvoie la colonne.
export function choixKevina(d, id, { marge = 0, rng = Math.random } = {}) {
  const valeurs = coupsPossibles(d).map((x) => {
    const apres = appliquer(d.colonnes, d.carte, x.c, x.type);
    return { c: x.c, v: x.gain - gainAdverse(apres, adversaire(id), prochaine(d)) - marche(d, x) / 100 };
  });
  const max = Math.max(...valeurs.map((x) => x.v));
  const meilleurs = valeurs.filter((x) => x.v >= max - marge);
  return meilleurs[Math.floor(rng() * meilleurs.length)].c;
}

// Joueur « de bon sens » (simulation) : le plus de points tout de suite,
// puis la plus petite marche ; ne regarde pas ce que l'adversaire pourra
// fermer. Renvoie la colonne.
export function choixSimple(d) {
  const cle = (x) => -x.gain * 100 + marche(d, x);
  return coupsPossibles(d).reduce((b, x) => (cle(x) < cle(b) ? x : b)).c;
}

export function choixHasard(d, rng = Math.random) {
  const coups = coupsPossibles(d);
  return coups[Math.floor(rng() * coups.length)].c;
}
