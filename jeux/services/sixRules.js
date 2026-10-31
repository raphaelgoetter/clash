// ============================================================
// sixRules.js — Règles pures de Six (`/six`), duel inspiré du 6 qui prend :
// pioche commune de 36 cartes (4 couleurs de 1 à 9, celles de Punto),
// 4 colonnes. À son tour, on retourne la carte du dessus de la pioche et
// on la pose sur une colonne dont la dernière carte est plus faible (au
// choix s'il y en a plusieurs) ; plus forte sur aucune colonne, elle va
// sur la colonne de son choix (pose libre). 6e carte d'une colonne : on
// ramasse les 5 premières, elle reste. Échange (ECHANGES par joueur et par
// partie) : on peut donner sa carte à l'adversaire (elle devient la
// prochaine carte) et jouer la prochaine.
// Une colonne ramassée coûte 1 point par carte, plus PENALITE_MAUDITE par
// carte de la couleur maudite. Fin dès qu'un joueur atteint SEUIL points
// ou quand la pioche est vide : le moins de points gagne.
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
// La 6e carte d'une colonne la fait ramasser
export const LIMITE = 6;
export const NB_COULEURS = 4;
export const VALEUR_MAX = 9;
// Couleur maudite (indice dans le moteur, rouge à l'affichage)
export const COULEUR_MAUDITE = 2;
export const PENALITE_CARTE = 1;
export const PENALITE_MAUDITE = 3;
// Points perdus qui terminent la partie
export const SEUIL = 15;
// Échanges par joueur et par partie
export const ECHANGES = 1;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

function melanger(cartes, rng) {
  for (let i = cartes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cartes[i], cartes[j]] = [cartes[j], cartes[i]];
  }
  return cartes;
}

// Pioche commune : 4 couleurs × valeurs 1 à 9, mélangée.
// Carte : { k (couleur 0 à 3), v (valeur) }.
function pioche(rng) {
  const cartes = [];
  for (let k = 0; k < NB_COULEURS; k++) {
    for (let v = 1; v <= VALEUR_MAX; v++) cartes.push({ k, v });
  }
  return melanger(cartes, rng);
}

export const maudite = (carte) => carte.k === COULEUR_MAUDITE;

// Points perdus en ramassant `cartes`
export const penalite = (cartes) =>
  cartes.reduce((total, c) => total + PENALITE_CARTE + (maudite(c) ? PENALITE_MAUDITE : 0), 0);

const derniere = (colonne) => colonne[colonne.length - 1];

// Type du coup « `carte` sur la colonne `c` » : "pose", "libre",
// "sixieme" (ramasse les 5 premières), ou null si la colonne est
// interdite (carte pas plus forte ici alors qu'elle l'est ailleurs).
export function typeCoup(colonnes, carte, c) {
  const monte = (col) => carte.v > derniere(col).v;
  if (!monte(colonnes[c]) && colonnes.some(monte)) return null;
  if (colonnes[c].length === LIMITE - 1) return "sixieme";
  return monte(colonnes[c]) ? "pose" : "libre";
}

// Cartes ramassées par un coup de ce type sur `colonne` ([] sans ramassage)
const ramassees = (colonne, type) => (type === "sixieme" ? [...colonne] : []);

// Colonnes après le coup (copie, `colonnes` intact)
function appliquer(colonnes, carte, c, type) {
  return colonnes.map((col, i) => (i !== c ? col : ramassees(col, type).length ? [carte] : [...col, carte]));
}

// Les coups permis de `carte` (par défaut celle du joueur actif), un par
// colonne autorisée : { c, type, penalite }.
export function coupsPossibles(d, carte = d.carte) {
  return d.colonnes.flatMap((col, c) => {
    const type = typeCoup(d.colonnes, carte, c);
    return type ? [{ c, type, penalite: penalite(ramassees(col, type)) }] : [];
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
    // Cartes ramassées par chaque joueur, dans l'ordre (récapitulatif de fin)
    ramassees: { joueur: [], bot: [] },
    // Échanges restants de chaque joueur ; `echangeCeTour` : le joueur
    // actif a échangé sa carte ce tour-ci
    echanges: { joueur: ECHANGES, bot: ECHANGES },
    echangeCeTour: false,
    coups: 0,
    // Numéro de l'état affiché, +1 à chaque action (coup ou échange) :
    // écarte un clic sur une vue dépassée
    vue: 0,
    // Dernier coup : { id, carte, colonne, type, ramassees, penalite, echange }
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
  const points = penalite(prises);
  d.colonnes = appliquer(d.colonnes, carte, c, type);
  d.points[id] += points;
  d.ramassees[id].push(...prises);
  d.coups += 1;
  d.vue += 1;
  d.dernier = { id, carte, colonne: c, type, ramassees: prises, penalite: points, echange: d.echangeCeTour };
  d.echangeCeTour = false;

  if (d.points[id] >= SEUIL || !d.pioche.length) {
    d.termine = true;
    d.fin = d.points[id] >= SEUIL ? "seuil" : "pioche";
    d.carte = null;
    const { joueur, bot } = d.points;
    d.gagnant = joueur === bot ? "nul" : joueur < bot ? "joueur" : "bot";
  } else {
    d.actif = adversaire(id);
    d.carte = d.pioche.pop();
  }
  return { carte, type, penalite: points };
}

// Échange permis au joueur actif `id` : il lui en reste, pas déjà fait ce
// tour-ci, et une prochaine carte existe.
export function echangePermis(d, id) {
  return !d.termine && d.actif === id && d.echanges?.[id] > 0 && !d.echangeCeTour && d.pioche.length > 0;
}

// Échange : la carte du joueur actif devient la prochaine carte (celle de
// l'adversaire), il joue la prochaine à la place.
export function echanger(d, id) {
  if (!echangePermis(d, id)) return { erreur: "Échange impossible." };
  const donnee = d.carte;
  d.carte = d.pioche.pop();
  d.pioche.push(donnee);
  d.echanges[id] -= 1;
  d.echangeCeTour = true;
  d.vue += 1;
  return { donnee, recue: d.carte };
}

// ── Kévina ────────────────────────────────────────────────────────

// Coût fictif d'un échange pour Kévina (ressource rare : seulement s'il
// rapporte nettement)
const COUT_ECHANGE = 2;

// Points que l'adversaire perdra au mieux à son tour avec `carte` (la
// prochaine, visible de tous ; 0 sans carte).
function penaliteAdverse(colonnes, carte) {
  if (!carte) return 0;
  return Math.min(...coupsPossibles({ colonnes }, carte).map((x) => x.penalite));
}

// Valeurs des coups de `carte` (l'adversaire recevra `suivante`) : points
// perdus moins ceux que l'adversaire perdra au mieux à son tour suivant.
function valeurs(d, carte, suivante) {
  return coupsPossibles(d, carte).map((coup) => {
    const apres = appliquer(d.colonnes, carte, coup.c, coup.type);
    return { c: coup.c, v: coup.penalite - penaliteAdverse(apres, suivante) };
  });
}

// Kévina minimise ses points perdus moins ceux que l'adversaire perdra au
// mieux à son tour suivant avec la prochaine carte (visible de tous), sans
// anticipation plus lointaine. Elle échange si c'est nettement meilleur
// (COUT_ECHANGE). `marge` : colonne tirée au sort parmi celles à `marge`
// points au plus de la meilleure (variété, et des erreurs qui laissent sa
// chance au joueur). Réglage : `marge_kevina` de duel.json.
// Renvoie { echange, c } : échanger d'abord si `echange`, puis jouer `c`
// (colonne choisie pour la carte reçue).
export function choixKevina(d, id, { marge = 0, rng = Math.random } = {}) {
  const sansEchange = valeurs(d, d.carte, prochaine(d));
  const avecEchange = echangePermis(d, id) ? valeurs(d, prochaine(d), d.carte) : [];
  const min = (vs) => Math.min(...vs.map((x) => x.v));
  const echange = avecEchange.length > 0 && min(avecEchange) + COUT_ECHANGE < min(sansEchange);
  const choix = echange ? avecEchange : sansEchange;
  const meilleurs = choix.filter((x) => x.v <= min(choix) + marge);
  return { echange, c: meilleurs[Math.floor(rng() * meilleurs.length)].c };
}

// Joueur « de bon sens » (simulation) : le moins de points perdus, puis
// la plus petite marche au-dessus de la dernière carte.
export function choixSimple(d) {
  const cle = (x) => x.penalite * 100 + (x.type === "pose" ? d.carte.v - derniere(d.colonnes[x.c]).v : 20);
  return coupsPossibles(d).reduce((b, x) => (cle(x) < cle(b) ? x : b)).c;
}

export function choixHasard(d, rng = Math.random) {
  const coups = coupsPossibles(d);
  return coups[Math.floor(rng() * coups.length)].c;
}
