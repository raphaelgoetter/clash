// ============================================================
// sixRules.js — Règles pures de Six (`/six`), duel inspiré du 6 qui prend :
// pioche commune de 36 cartes (4 couleurs de 1 à 9, celles de Punto),
// 4 colonnes. À son tour, on retourne la carte du dessus de la pioche et
// on la pose sur une colonne :
// - plus forte que sa dernière carte : elle s'y ajoute ;
// - pas plus forte, alors qu'elle l'est sur une autre colonne : on
//   ramasse la colonne (ramassage volontaire), la carte la remplace ;
// - plus forte sur aucune colonne : elle s'y ajoute quand même (pose
//   libre) ;
// - 6e carte d'une colonne : on ramasse les 5 premières, elle reste.
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
// "sixieme" (ramasse les 5 premières) ou "volontaire" (ramasse tout).
export function typeCoup(colonnes, carte, c) {
  const monte = (col) => carte.v > derniere(col).v;
  if (monte(colonnes[c]) || !colonnes.some(monte)) {
    if (colonnes[c].length === LIMITE - 1) return "sixieme";
    return monte(colonnes[c]) ? "pose" : "libre";
  }
  return "volontaire";
}

// Cartes ramassées par un coup de ce type sur `colonne` ([] sans ramassage)
const ramassees = (colonne, type) => (type === "sixieme" || type === "volontaire" ? [...colonne] : []);

// Colonnes après le coup (copie, `colonnes` intact)
function appliquer(colonnes, carte, c, type) {
  return colonnes.map((col, i) => (i !== c ? col : ramassees(col, type).length ? [carte] : [...col, carte]));
}

// Les coups possibles de `carte` (par défaut celle du joueur actif), un
// par colonne : { c, type, penalite }.
export function coupsPossibles(d, carte = d.carte) {
  return d.colonnes.map((col, c) => {
    const type = typeCoup(d.colonnes, carte, c);
    return { c, type, penalite: penalite(ramassees(col, type)) };
  });
}

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
    coups: 0,
    // Dernier coup : { id, carte, colonne, type, ramassees, penalite }
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
  const prises = ramassees(d.colonnes[c], type);
  const points = penalite(prises);
  d.colonnes = appliquer(d.colonnes, carte, c, type);
  d.points[id] += points;
  d.coups += 1;
  d.dernier = { id, carte, colonne: c, type, ramassees: prises, penalite: points };

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

// ── Kévina ────────────────────────────────────────────────────────

// Points que l'adversaire perdra au mieux à son tour, en moyenne sur sa
// carte inconnue (une carte de la pioche, dont l'ordre est secret).
function penaliteAdverse(colonnes, inconnues) {
  if (!inconnues.length) return 0;
  const auMieux = (carte) =>
    Math.min(...colonnes.map((col, c) => penalite(ramassees(col, typeCoup(colonnes, carte, c)))));
  return inconnues.reduce((s, carte) => s + auMieux(carte), 0) / inconnues.length;
}

// Kévina minimise ses points perdus moins ceux que l'adversaire perdra au
// mieux à son tour suivant, sans anticipation plus lointaine. `marge` :
// colonne tirée au sort parmi celles à `marge` points au plus de la
// meilleure (variété, et des erreurs qui laissent sa chance au joueur).
// Réglage : `marge_kevina` de duel.json. Renvoie la colonne.
export function choixKevina(d, id, { marge = 0, rng = Math.random } = {}) {
  const valeurs = coupsPossibles(d).map((coup) => {
    const apres = appliquer(d.colonnes, d.carte, coup.c, coup.type);
    return { c: coup.c, v: coup.penalite - penaliteAdverse(apres, d.pioche) };
  });
  const min = Math.min(...valeurs.map((x) => x.v));
  const meilleurs = valeurs.filter((x) => x.v <= min + marge);
  return meilleurs[Math.floor(rng() * meilleurs.length)].c;
}

// Joueur « de bon sens » (simulation) : le moins de points perdus, puis
// la plus petite marche au-dessus de la dernière carte.
export function choixSimple(d) {
  const cle = (x) => x.penalite * 100 + (x.type === "pose" ? d.carte.v - derniere(d.colonnes[x.c]).v : 20);
  return coupsPossibles(d).reduce((b, x) => (cle(x) < cle(b) ? x : b)).c;
}

export function choixHasard(d, rng = Math.random) {
  return Math.floor(rng() * NB_COLONNES);
}
