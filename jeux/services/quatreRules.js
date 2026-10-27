// ============================================================
// quatreRules.js — Règles pures de Quatre à la suite (`/quatre`) : grille
// commune de 7 colonnes sur 6 rangées. À son tour, on lâche un pion dans
// une colonne non pleine, il tombe tout en bas. Le premier qui aligne 4
// pions (horizontale, verticale ou diagonale) gagne ; grille pleine sans
// alignement = match nul.
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (tests, simulation).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Quatre à la suite), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const NB_COLONNES = 7;
export const HAUTEUR = 6;
export const ALIGNEMENT = 4;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// Directions d'alignement : horizontale, verticale, deux diagonales
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

// Colonnes : tableaux de pions (siège) du bas vers le haut.
const caseDe = (colonnes, c, r) =>
  c >= 0 && c < NB_COLONNES && r >= 0 ? (colonnes[c][r] ?? null) : null;

export const grillePleine = (colonnes) => colonnes.every((c) => c.length >= HAUTEUR);

export function colonnesLibres(colonnes) {
  return colonnes.map((c, i) => (c.length < HAUTEUR ? i : -1)).filter((i) => i >= 0);
}

// Cases alignées passant par le pion (c, r) : toutes les lignes d'au moins
// 4 pions de même siège, sinon [].
export function alignementsDepuis(colonnes, c, r) {
  const id = caseDe(colonnes, c, r);
  if (!id) return [];
  const cases = [];
  for (const [dc, dr] of DIRECTIONS) {
    const ligne = [[c, r]];
    for (const sens of [1, -1]) {
      for (let k = 1; caseDe(colonnes, c + sens * k * dc, r + sens * k * dr) === id; k++) {
        ligne.push([c + sens * k * dc, r + sens * k * dr]);
      }
    }
    if (ligne.length >= ALIGNEMENT) cases.push(...ligne.filter(([x, y]) => x !== c || y !== r));
  }
  return cases.length ? [[c, r], ...cases] : [];
}

export function creerDuel({ commence = "joueur" } = {}) {
  return {
    colonnes: Array.from({ length: NB_COLONNES }, () => []),
    actif: commence,
    coups: 0,
    dernier: null,
    termine: false,
    gagnant: null,
    // Cases [colonne, rangée] de l'alignement gagnant
    alignement: null,
  };
}

// Lâche un pion de `id` dans `colonne`, puis fin de partie ou tour adverse.
export function poser(d, id, colonne) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!Number.isInteger(colonne) || colonne < 0 || colonne >= NB_COLONNES) {
    return { erreur: "Colonne inconnue." };
  }
  if (d.colonnes[colonne].length >= HAUTEUR) return { erreur: "Cette colonne est pleine." };

  d.colonnes[colonne].push(id);
  const rangee = d.colonnes[colonne].length - 1;
  d.coups += 1;
  // Dernier coup, raconté à l'adversaire
  d.dernier = { id, colonne, rangee };

  const alignement = alignementsDepuis(d.colonnes, colonne, rangee);
  if (alignement.length) {
    d.termine = true;
    d.gagnant = id;
    d.alignement = alignement;
  } else if (grillePleine(d.colonnes)) {
    d.termine = true;
    d.gagnant = "nul";
  } else {
    d.actif = adversaire(id);
  }
  return { colonne, rangee, victoire: alignement.length > 0 };
}

// ── Kévina ────────────────────────────────────────────────────────

// Toutes les fenêtres de 4 cases de la grille (69), pour l'évaluation.
const FENETRES = [];
for (let c = 0; c < NB_COLONNES; c++) {
  for (let r = 0; r < HAUTEUR; r++) {
    for (const [dc, dr] of DIRECTIONS) {
      const fin = [c + (ALIGNEMENT - 1) * dc, r + (ALIGNEMENT - 1) * dr];
      if (fin[0] < 0 || fin[0] >= NB_COLONNES || fin[1] < 0 || fin[1] >= HAUTEUR) continue;
      FENETRES.push(Array.from({ length: ALIGNEMENT }, (_, k) => [c + k * dc, r + k * dr]));
    }
  }
}

// Centre d'abord : meilleur élagage alpha-bêta
const ORDRE = [3, 2, 4, 1, 5, 0, 6];
const VICTOIRE = 100_000;

// Position vue par `id` : menaces ouvertes (3 pions + 1 case vide, 2 + 2)
// et pions de la colonne centrale, qui entre dans le plus d'alignements.
function evaluer(colonnes, id) {
  const adv = adversaire(id);
  let score = 0;
  for (const r of colonnes[3]) score += r === id ? 3 : -3;
  for (const fenetre of FENETRES) {
    let miens = 0;
    let siens = 0;
    for (const [c, r] of fenetre) {
      const v = colonnes[c][r];
      if (v === id) miens++;
      else if (v === adv) siens++;
    }
    if (miens && siens) continue;
    if (miens === 3) score += 5;
    else if (miens === 2) score += 2;
    else if (siens === 3) score -= 5;
    else if (siens === 2) score -= 2;
  }
  return score;
}

function gagneEn(colonnes, c, id) {
  colonnes[c].push(id);
  const gagne = alignementsDepuis(colonnes, c, colonnes[c].length - 1).length > 0;
  colonnes[c].pop();
  return gagne;
}

// Negamax alpha-bêta : valeur de la position pour `id`, qui doit jouer.
// Une victoire rapide vaut plus qu'une victoire lointaine.
function negamax(colonnes, id, profondeur, alpha, beta) {
  const libres = ORDRE.filter((c) => colonnes[c].length < HAUTEUR);
  if (!libres.length) return 0;
  for (const c of libres) if (gagneEn(colonnes, c, id)) return VICTOIRE + profondeur;
  if (profondeur === 0) return evaluer(colonnes, id);
  let meilleur = -Infinity;
  for (const c of libres) {
    colonnes[c].push(id);
    const v = -negamax(colonnes, adversaire(id), profondeur - 1, -beta, -alpha);
    colonnes[c].pop();
    if (v > meilleur) meilleur = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return meilleur;
}

// Kévina voit `profondeur` coups à l'avance (le sien compris) : elle gagne
// dès qu'elle peut, bloque toute victoire adverse immédiate, mais ne voit
// pas les pièges plus lointains. Pendant les `ouverture` premiers coups de
// la partie (les deux joueurs), colonne tirée au sort parmi les coups à
// `marge` points au plus du meilleur : sans marge, l'ouverture est presque
// toujours la même. Au-delà, seulement entre coups exactement égaux (une
// marge sur toute la partie l'affaiblit trop). Une victoire ou une défaite
// vue vaut des dizaines de milliers de points : ces coups restent forcés.
// Réglages : `profondeur_kevina`, `marge_kevina`, `ouverture_kevina` de
// duel.json.
export function choixKevina(d, id, { profondeur = 4, marge = 0, ouverture = Infinity, rng = Math.random } = {}) {
  const colonnes = d.colonnes.map((c) => [...c]);
  const libres = ORDRE.filter((c) => colonnes[c].length < HAUTEUR);
  for (const c of libres) if (gagneEn(colonnes, c, id)) return c;
  const valeurs = libres.map((c) => {
    colonnes[c].push(id);
    const v = -negamax(colonnes, adversaire(id), profondeur - 1, -Infinity, Infinity);
    colonnes[c].pop();
    return { c, v };
  });
  const max = Math.max(...valeurs.map((x) => x.v));
  // Victoire ou défaite en vue : seulement les coups exactement égaux (la
  // plus rapide, ou la plus lointaine)
  const seuil = Math.abs(max) >= VICTOIRE / 2 || d.coups >= ouverture ? max : max - marge;
  const meilleurs = valeurs.filter((x) => x.v >= seuil).map((x) => x.c);
  return meilleurs[Math.floor(rng() * meilleurs.length)];
}

export function choixHasard(d, id, rng = Math.random) {
  const libres = colonnesLibres(d.colonnes);
  return libres[Math.floor(rng() * libres.length)];
}
