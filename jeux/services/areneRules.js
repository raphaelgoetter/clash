// ============================================================
// areneRules.js — Règles pures d'Arène (`/arene`), adaptation fidèle de
// Knucklebones : chaque joueur a 3 colonnes de 3 cases (🏰 gauche, 👑 Roi,
// 🏰 droite). À son tour, on lance 1 dé et on le pose dans une de ses
// colonnes non pleines ; les dés de même valeur de la colonne adverse
// correspondante sont détruits. Fin dès qu'une grille est pleine, plus haut
// total gagnant (égalité = match nul).
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (tests, simulation).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Arène), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const NB_COLONNES = 3;
export const HAUTEUR = 3;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

export const lancerDe = (rng = Math.random) => 1 + Math.floor(rng() * 6);

// Chaque valeur compte valeur × n × n (n = dés de cette valeur dans la
// colonne) : 4-4 = (4+4)×2 = 16, 3-3-3 = 9×3 = 27.
export function scoreColonne(colonne) {
  const compte = {};
  for (const v of colonne) compte[v] = (compte[v] ?? 0) + 1;
  return Object.entries(compte).reduce((s, [v, n]) => s + Number(v) * n * n, 0);
}

export function scoreGrille(grille) {
  return grille.reduce((s, colonne) => s + scoreColonne(colonne), 0);
}

export const grillePleine = (grille) => grille.every((c) => c.length >= HAUTEUR);

export function colonnesLibres(grille) {
  return grille.map((c, i) => (c.length < HAUTEUR ? i : -1)).filter((i) => i >= 0);
}

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  return {
    grilles: { joueur: [[], [], []], bot: [[], [], []] },
    actif: commence,
    de: lancerDe(rng),
    coups: 0,
    dernier: null,
    termine: false,
    gagnant: null,
  };
}

// Effet d'une pose, sans rien modifier : points gagnés, points et dés
// détruits chez l'adversaire.
export function evaluerPose(grille, grilleAdv, colonne, valeur) {
  const avant = scoreColonne(grille[colonne]);
  const apres = scoreColonne([...grille[colonne], valeur]);
  const cible = grilleAdv[colonne];
  const restants = cible.filter((v) => v !== valeur);
  return {
    gain: apres - avant,
    pointsDetruits: scoreColonne(cible) - scoreColonne(restants),
    desDetruits: cible.length - restants.length,
  };
}

// Pose le dé courant de `id` dans `colonne`, puis fin de partie ou dé
// suivant pour l'adversaire.
export function poser(d, id, colonne, { rng = Math.random } = {}) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  const grille = d.grilles[id];
  if (!Number.isInteger(colonne) || colonne < 0 || colonne >= NB_COLONNES) {
    return { erreur: "Colonne inconnue." };
  }
  if (grille[colonne].length >= HAUTEUR) return { erreur: "Cette colonne est pleine." };

  const valeur = d.de;
  const adv = adversaire(id);
  const effet = evaluerPose(grille, d.grilles[adv], colonne, valeur);
  grille[colonne].push(valeur);
  d.grilles[adv][colonne] = d.grilles[adv][colonne].filter((v) => v !== valeur);
  d.coups += 1;
  // Dernier coup, raconté à l'adversaire
  d.dernier = { id, valeur, colonne, desDetruits: effet.desDetruits };

  if (grillePleine(grille)) {
    d.termine = true;
    d.de = null;
    const s = { joueur: scoreGrille(d.grilles.joueur), bot: scoreGrille(d.grilles.bot) };
    d.gagnant = s.joueur === s.bot ? "nul" : s.joueur > s.bot ? "joueur" : "bot";
  } else {
    d.actif = adv;
    d.de = lancerDe(rng);
  }
  return { valeur, colonne, ...effet };
}

// ── Kévina ────────────────────────────────────────────────────────

// Gourmande : maximise points gagnés + points détruits ; à égalité, la
// colonne la moins remplie (garde de la place pour les combos, et la
// préférence inverse fait chuter à ~39 % contre elle). Simulation
// (jeux/outils/arene/) : aucune variante testée ne la bat (anticipation de
// la réponse adverse, prudence face aux destructions, pondérations).
export function choixGlouton(d, id) {
  const grille = d.grilles[id];
  const grilleAdv = d.grilles[adversaire(id)];
  let meilleur = null;
  for (const c of colonnesLibres(grille)) {
    const e = evaluerPose(grille, grilleAdv, c, d.de);
    const valeur = e.gain + e.pointsDetruits;
    if (!meilleur || valeur > meilleur.valeur || (valeur === meilleur.valeur && grille[c].length < grille[meilleur.c].length)) {
      meilleur = { c, valeur };
    }
  }
  return meilleur.c;
}

export function choixHasard(d, id, rng = Math.random) {
  const libres = colonnesLibres(d.grilles[id]);
  return libres[Math.floor(rng() * libres.length)];
}
