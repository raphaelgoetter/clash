// ============================================================
// tourneboulRules.js — Règles pures de Tourneboule (`/tourneboule`), jeu de
// réflexion sans hasard : plateau 5×5 dont la case centrale est bloquée ;
// au départ, un pion de chaque joueur à côté du centre (le premier joueur
// au-dessus, le second en dessous). À son tour, le joueur pose un pion sur
// une case vide VOISINE (côté ou coin) d'un pion ou du rocher (réserve
// illimitée, pas de déplacement). Chaque ligne horizontale, verticale ou
// diagonale de pions adverses que le pion posé encadre avec un autre de ses
// pions change de camp. Plateau plein (11 coups chacun) : le plus de pions
// gagne ; égalité : le plus de coins, puis l'auteur du dernier
// retournement ; sinon match nul.
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (variété de Kévina, tests).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Tourneboule), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const TAILLE = 5;
export const NB_CASES = TAILLE * TAILLE;
// Case centrale bloquée
export const ROC = (NB_CASES - 1) / 2;
export const COINS = [0, TAILLE - 1, NB_CASES - TAILLE, NB_CASES - 1];
// Pions de départ, à côté du rocher : premier joueur au-dessus, second en
// dessous (loin des coins ; un départ en diagonale du rocher rendait les
// coins accessibles dès le premier coup)
export const DEPART = { joueur: ROC - TAILLE, bot: ROC + TAILLE };
// Lignes de retournement et voisinage : 8 directions (côtés et coins)
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

const dansGrille = (r, c) => r >= 0 && c >= 0 && r < TAILLE && c < TAILLE;

// Pions adverses retournés si `id` pose en `i` : toutes les lignes
// (horizontales, verticales, diagonales) de pions adverses contiguës,
// fermées par un pion de `id`.
export function retournements(grille, i, id) {
  const adv = adversaire(id);
  const r0 = Math.floor(i / TAILLE);
  const c0 = i % TAILLE;
  const retournes = [];
  for (const [dr, dc] of DIRECTIONS) {
    const ligne = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (dansGrille(r, c) && grille[r * TAILLE + c] === adv) {
      ligne.push(r * TAILLE + c);
      r += dr;
      c += dc;
    }
    if (ligne.length && dansGrille(r, c) && grille[r * TAILLE + c] === id) retournes.push(...ligne);
  }
  return retournes;
}

// Cases vides
export const casesLibres = (grille) => grille.flatMap((x, i) => (x === null ? [i] : []));

// Case voisine (côté ou coin) d'un pion ou du rocher
function aUnVoisin(grille, i) {
  const r0 = Math.floor(i / TAILLE);
  const c0 = i % TAILLE;
  return DIRECTIONS.some(([dr, dc]) => dansGrille(r0 + dr, c0 + dc) && grille[(r0 + dr) * TAILLE + c0 + dc] !== null);
}

// Cases où le joueur actif peut poser : vides et voisines d'un pion ou du
// rocher (toutes les cases vides s'il n'y en a aucune, cas théorique)
export function casesJouables(grille) {
  const libres = casesLibres(grille);
  const voisines = libres.filter((i) => aUnVoisin(grille, i));
  return voisines.length ? voisines : libres;
}

export const compter = (grille, id) => grille.filter((x) => x === id).length;

export function creerDuel({ commence = "joueur" } = {}) {
  const grille = Array(NB_CASES).fill(null);
  grille[ROC] = "roc";
  // Le premier joueur (« joueur », qui commence toujours) au-dessus du centre
  grille[DEPART.joueur] = "joueur";
  grille[DEPART.bot] = "bot";
  return {
    // Case : null (vide), "roc" (centre bloqué), "joueur" ou "bot"
    grille,
    actif: commence,
    coups: 0,
    // Numéro de l'état affiché, +1 à chaque coup : écarte un clic sur une
    // vue dépassée
    vue: 0,
    // Dernier coup : { id, case, retournes (cases retournées) }
    dernier: null,
    // Auteur du dernier retournement (départage)
    dernierRetournement: null,
    termine: false,
    gagnant: null,
    // Fin : "majorite" | "coins" | "retournement" (départages) | "nul"
    fin: null,
  };
}

// Vainqueur sur un plateau plein : { gagnant, fin }.
export function resultat(grille, dernierRetournement) {
  const diff = compter(grille, "joueur") - compter(grille, "bot");
  if (diff) return { gagnant: diff > 0 ? "joueur" : "bot", fin: "majorite" };
  const coins = COINS.filter((i) => grille[i] === "joueur").length - COINS.filter((i) => grille[i] === "bot").length;
  if (coins) return { gagnant: coins > 0 ? "joueur" : "bot", fin: "coins" };
  if (dernierRetournement) return { gagnant: dernierRetournement, fin: "retournement" };
  return { gagnant: "nul", fin: "nul" };
}

// Pose un pion du joueur actif `id` en `i`, retourne les lignes encadrées,
// puis fin de partie (plateau plein) ou tour adverse.
export function poser(d, id, i) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!Number.isInteger(i) || i < 0 || i >= NB_CASES || d.grille[i] !== null) return { erreur: "Case occupée." };
  if (!casesJouables(d.grille).includes(i)) return { erreur: "Case sans voisin." };

  d.grille[i] = id;
  const retournes = retournements(d.grille, i, id);
  for (const j of retournes) d.grille[j] = id;
  if (retournes.length) d.dernierRetournement = id;
  d.coups += 1;
  d.vue += 1;
  d.dernier = { id, case: i, retournes };

  if (!casesLibres(d.grille).length) {
    d.termine = true;
    Object.assign(d, resultat(d.grille, d.dernierRetournement));
  } else {
    d.actif = adversaire(id);
  }
  return { case: i, retournes };
}

// ── Recherche (Kévina, simulation) ───────────────────────────────

const VICTOIRE = 1000;

// Évaluation positionnelle : un coin vaut 8 pions, une case de bord 2 (plus
// difficiles à reprendre) ; un pion voisin d'un coin encore vide coûte 4
// (il ouvre ce coin à l'adversaire). Sans elle, « coins puis bords » battait
// Kévina.
const POIDS = Array.from({ length: NB_CASES }, (_, i) => {
  const r = Math.floor(i / TAILLE);
  const c = i % TAILLE;
  if (COINS.includes(i)) return 8;
  return r === 0 || c === 0 || r === TAILLE - 1 || c === TAILLE - 1 ? 2 : 1;
});
const ACCES = 4;
const VOISINS_COIN = COINS.map((coin) => {
  const r0 = Math.floor(coin / TAILLE);
  const c0 = coin % TAILLE;
  return DIRECTIONS.filter(([dr, dc]) => dansGrille(r0 + dr, c0 + dc)).map(([dr, dc]) => (r0 + dr) * TAILLE + c0 + dc);
});

// Valeur de `grille` pour `id` (positive : avantage à `id`)
export function evaluer(grille, id) {
  const adv = adversaire(id);
  let v = 0;
  for (let i = 0; i < NB_CASES; i++) {
    if (grille[i] === id) v += POIDS[i];
    else if (grille[i] === adv) v -= POIDS[i];
  }
  COINS.forEach((coin, k) => {
    if (grille[coin] !== null) return;
    for (const x of VOISINS_COIN[k]) {
      if (grille[x] === id) v -= ACCES;
      else if (grille[x] === adv) v += ACCES;
    }
  });
  return v;
}

// Negamax alpha-bêta pour `id` (au trait) sur `grille` ; feuilles :
// évaluation positionnelle (`evaluer()`). Coups qui retournent le plus
// examinés d'abord.
function negamax(grille, id, dernierRet, prof, alpha, beta) {
  const libres = casesLibres(grille);
  if (!libres.length) {
    const { gagnant } = resultat(grille, dernierRet);
    const ecart = compter(grille, id) - compter(grille, adversaire(id));
    return gagnant === "nul" ? 0 : gagnant === id ? VICTOIRE + ecart : -VICTOIRE + ecart;
  }
  if (prof === 0) return evaluer(grille, id);
  const fils = casesJouables(grille)
    .map((i) => {
      const g = [...grille];
      g[i] = id;
      const ret = retournements(g, i, id);
      for (const j of ret) g[j] = id;
      return { g, ret: ret.length };
    })
    .sort((a, b) => b.ret - a.ret);
  let best = -Infinity;
  for (const f of fils) {
    const v = -negamax(f.g, adversaire(id), f.ret ? id : dernierRet, prof - 1, -beta, -alpha);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Valeur de chaque coup du joueur actif avec une recherche de `profondeur`
// coups (le sien compris) : [{ i, score }].
export function evaluerCoups(d, profondeur) {
  const id = d.actif;
  return casesJouables(d.grille).map((i) => {
    const g = [...d.grille];
    g[i] = id;
    const ret = retournements(g, i, id);
    for (const j of ret) g[j] = id;
    return { i, score: -negamax(g, adversaire(id), ret.length ? id : d.dernierRetournement, profondeur - 1, -Infinity, Infinity) };
  });
}

// Kévina : recherche à `profondeur` coups (le sien compris), meilleur coup
// tiré au sort parmi les ex aequo. Avec la probabilité `erreur`, coup tiré
// au sort parmi ceux à `marge` points d'évaluation au plus du meilleur : des erreurs qui
// laissent sa chance au joueur, jamais un coup qui perd ou rate une
// victoire en vue. Réglages : `profondeur_kevina`, `erreur_kevina`,
// `marge_kevina` de duel.json. Renvoie la case.
export function choixKevina(d, id, { profondeur = 3, erreur = 0, marge = 2, rng = Math.random } = {}) {
  const coups = evaluerCoups(d, profondeur);
  const max = Math.max(...coups.map((x) => x.score));
  const seuil = Math.abs(max) >= VICTOIRE / 2 || rng() >= erreur ? max : max - marge;
  const meilleurs = coups.filter((x) => x.score >= seuil);
  return meilleurs[Math.floor(rng() * meilleurs.length)].i;
}

export function choixHasard(d, rng = Math.random) {
  const cases = casesJouables(d.grille);
  return cases[Math.floor(rng() * cases.length)];
}
