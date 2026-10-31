// ============================================================
// pilepoilRules.js — Règles pures de Pile-Poil (`/pilepoil`), jeu de
// réflexion sans hasard : 3 piles communes (A, B, C) qui partent de 0, à
// amener EXACTEMENT à CIBLE. Chaque joueur a une main de valeurs 1 à
// VALEUR_MAX, visible de tous. À son tour, il choisit une de ses valeurs
// restantes et la pose sur une pile (sans la dépasser) ; sa main se
// recharge quand elle est vide. Une pile à CIBLE explose : +1 point, elle
// repart à 0 et son souffle (+SOUFFLE) touche les piles voisines non vides
// (A↔B, B↔C) ; une voisine qui tombe pile explose à son tour (+1 point),
// une voisine qui dépasse saute ratée (à 0, +1 pour l'adversaire). Aucune
// valeur ne rentre nulle part : le joueur défausse une valeur et fait
// sauter la pile de son choix (+1 pour l'adversaire). Premier à SEUIL
// points gagne (si les deux l'atteignent sur le même coup : le plus de
// points, à égalité celui qui a joué).
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (variété de Kévina, tests).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Pile-Poil), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const NB_PILES = 3;
export const CIBLE = 11;
export const SOUFFLE = 3;
export const SEUIL = 3;
export const VALEUR_MAX = 6;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// Main pleine : valeurs 1 à VALEUR_MAX
export const mainPleine = () => Array.from({ length: VALEUR_MAX }, (_, i) => i + 1);

// Piles voisines de la pile `k` (A↔B, B↔C)
const voisines = (k) => [k - 1, k + 1].filter((j) => j >= 0 && j < NB_PILES);

// Aucune des valeurs ne rentre sur aucune pile : le joueur doit faire
// sauter une pile.
export const bloque = (piles, valeurs) => !valeurs.some((v) => piles.some((p) => p + v <= CIBLE));

// Résout la pose de `v` sur la pile `k` (copie de `piles`) :
// { piles, explosions (piles explosées, dans l'ordre), ratees (piles
// sautées par le souffle), gain, perte }. Avec `contenu` (pièces de chaque
// pile, voir creerDuel) et `piece` (la valeur posée) : `contenu` mis à jour
// (copie) et `videes` ({ pile: nombre de pièces } des piles vidées, pour
// l'étape d'explosion).
export function resoudre(piles, k, v, contenu = null, piece = null) {
  const p = [...piles];
  const c = contenu?.map((pile) => [...pile]);
  const videes = {};
  const vider = (j) => {
    if (!c) return;
    videes[j] = c[j].length;
    c[j] = [];
  };
  p[k] += v;
  c?.[k].push(piece);
  const explosions = [];
  const ratees = [];
  const file = p[k] === CIBLE ? [k] : [];
  while (file.length) {
    const j = file.shift();
    if (p[j] === CIBLE) {
      explosions.push(j);
      p[j] = 0;
      vider(j);
      for (const x of voisines(j)) {
        if (p[x] === 0) continue;
        p[x] += SOUFFLE;
        c?.[x].push({ v: SOUFFLE, souffle: true });
        if (p[x] >= CIBLE) file.push(x);
      }
    } else if (p[j] > CIBLE) {
      ratees.push(j);
      p[j] = 0;
      vider(j);
    }
  }
  return { piles: p, explosions, ratees, gain: explosions.length, perte: ratees.length, ...(c ? { contenu: c, videes } : {}) };
}

// Piles jouables avec la valeur `v` (par défaut la valeur choisie par le
// joueur actif) : { k, type ("pose" | "explosion" | "sautee"), gain,
// perte } ; [] sans valeur choisie. Joueur bloqué : toutes les piles, à
// faire sauter.
export function coupsPossibles(d, v = d.choix) {
  if (!v) return [];
  if (bloque(d.piles, d.mains[d.actif])) {
    return d.piles.map((_, k) => ({ k, type: "sautee", gain: 0, perte: 1 }));
  }
  return d.piles.flatMap((p, k) => {
    if (p + v > CIBLE) return [];
    const r = resoudre(d.piles, k, v);
    return [{ k, type: r.gain ? "explosion" : "pose", gain: r.gain, perte: r.perte }];
  });
}

export function creerDuel({ commence = "joueur" } = {}) {
  return {
    piles: Array(NB_PILES).fill(0),
    // Pièces de chaque pile, dans l'ordre (affichage) : { v, id } pour une
    // valeur posée par `id`, { v: SOUFFLE, souffle: true } pour un souffle
    contenu: Array.from({ length: NB_PILES }, () => []),
    // Valeurs restantes de chaque joueur (visibles de tous)
    mains: { joueur: mainPleine(), bot: mainPleine() },
    actif: commence,
    // Valeur choisie par le joueur actif (null : pas encore choisie)
    choix: null,
    points: { joueur: 0, bot: 0 },
    coups: 0,
    // Numéro de l'état affiché, +1 à chaque action (choix de valeur ou
    // coup) : écarte un clic sur une vue dépassée
    vue: 0,
    // Dernier coup : { id, valeur, pile, type, explosions, ratees, gain,
    // perte, videes ({ pile: nombre de pièces } des piles vidées) }
    dernier: null,
    termine: false,
    gagnant: null,
  };
}

// Le joueur actif choisit la valeur `v` de sa main (premier clic).
export function choisirValeur(d, id, v) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!d.mains[id].includes(v)) return { erreur: "Valeur déjà jouée." };
  d.choix = v;
  d.vue += 1;
  return { choix: v };
}

// Pose la valeur choisie du joueur actif `id` sur la pile `k` (second
// clic), puis fin de partie (SEUIL atteint) ou tour adverse.
export function jouer(d, id, k) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!d.choix) return { erreur: "Choisis d'abord une valeur." };
  if (!Number.isInteger(k) || k < 0 || k >= NB_PILES) return { erreur: "Pile inconnue." };

  const v = d.choix;
  const adv = adversaire(id);
  let r;
  if (bloque(d.piles, d.mains[id])) {
    // Joueur bloqué : la pile choisie saute, +1 pour l'adversaire
    const piles = [...d.piles];
    piles[k] = 0;
    const contenu = d.contenu.map((pile, j) => (j === k ? [] : pile));
    r = { piles, contenu, videes: { [k]: d.contenu[k].length }, explosions: [], ratees: [k], gain: 0, perte: 1, type: "sautee" };
  } else {
    if (d.piles[k] + v > CIBLE) return { erreur: "Cette valeur dépasserait la cible." };
    r = resoudre(d.piles, k, v, d.contenu, { v, id });
    r.type = r.gain ? "explosion" : "pose";
  }
  d.piles = r.piles;
  d.contenu = r.contenu;
  d.mains[id] = d.mains[id].filter((x) => x !== v);
  if (!d.mains[id].length) d.mains[id] = mainPleine();
  d.points[id] += r.gain;
  d.points[adv] += r.perte;
  d.coups += 1;
  d.vue += 1;
  d.choix = null;
  d.dernier = { id, valeur: v, pile: k, type: r.type, explosions: r.explosions, ratees: r.ratees, gain: r.gain, perte: r.perte, videes: r.videes };

  if (d.points[id] >= SEUIL || d.points[adv] >= SEUIL) {
    d.termine = true;
    // Les deux à SEUIL ou plus sur le même coup : le plus de points, à
    // égalité celui qui a joué (il a déclenché l'explosion)
    d.gagnant = d.points[id] >= d.points[adv] ? id : adv;
  } else {
    d.actif = adv;
  }
  return { valeur: v, type: r.type, gain: r.gain, perte: r.perte };
}

// ── Recherche (Kévina, simulation) ───────────────────────────────

// État réduit pour la recherche : { piles, mains: [actif, adversaire], points: [actif, adversaire] }
const etatDe = (d) => ({
  piles: d.piles,
  mains: [d.mains[d.actif], d.mains[adversaire(d.actif)]],
  points: [d.points[d.actif], d.points[adversaire(d.actif)]],
});

// Coups de l'état réduit pour le joueur actif : { v, k, piles, gain, perte }
function coupsEtat(e) {
  const main = e.mains[0];
  const bloq = bloque(e.piles, main);
  const coups = [];
  for (const v of main) {
    for (let k = 0; k < NB_PILES; k++) {
      if (bloq) {
        const piles = [...e.piles];
        piles[k] = 0;
        coups.push({ v, k, piles, gain: 0, perte: 1 });
      } else if (e.piles[k] + v <= CIBLE) {
        const r = resoudre(e.piles, k, v);
        coups.push({ v, k, piles: r.piles, gain: r.gain, perte: r.perte });
      }
    }
  }
  return coups;
}

// État après le coup, vu par l'adversaire (qui devient actif)
function apres(e, c) {
  let main = e.mains[0].filter((x) => x !== c.v);
  if (!main.length) main = mainPleine();
  return { piles: c.piles, mains: [e.mains[1], main], points: [e.points[1] + c.perte, e.points[0] + c.gain] };
}

const VICTOIRE = 1000;

// Negamax alpha-bêta pour le joueur actif de `e` ; feuilles : écart de
// points.
function negamax(e, prof, alpha, beta) {
  const [moi, lui] = e.points;
  if (lui >= SEUIL && lui >= moi) return -VICTOIRE;
  if (moi >= SEUIL) return VICTOIRE;
  if (prof === 0) return (moi - lui) * 100;
  let best = -Infinity;
  for (const c of coupsEtat(e)) {
    const v = -negamax(apres(e, c), prof - 1, -beta, -alpha);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Valeur de chaque coup du joueur actif de `d` avec une recherche de
// `profondeur` coups (le sien compris) : [{ v, k, score }].
export function evaluerCoups(d, profondeur) {
  const e = etatDe(d);
  return coupsEtat(e).map((c) => {
    const n = apres(e, c);
    // Coup gagnant ou perdant tout de suite : pas de recherche
    const [lui, moi] = n.points;
    const score =
      moi >= SEUIL && moi >= lui ? VICTOIRE : lui >= SEUIL ? -VICTOIRE : -negamax(n, profondeur - 1, -Infinity, Infinity);
    return { v: c.v, k: c.k, score };
  });
}

// Kévina : recherche à `profondeur` coups (le sien compris), meilleur coup
// tiré au sort parmi les ex aequo. Avec la probabilité `erreur`, coup tiré
// au sort parmi ceux à `marge` (en centièmes de point) au plus du meilleur :
// des erreurs qui laissent sa chance au joueur, jamais un coup qui perd ou
// rate une victoire en vue. Réglages : `profondeur_kevina`,
// `erreur_kevina`, `marge_kevina` de duel.json. Renvoie { v, k } : choisir
// la valeur `v`, puis jouer la pile `k`.
export function choixKevina(d, id, { profondeur = 2, erreur = 0, marge = 100, rng = Math.random } = {}) {
  const coups = evaluerCoups(d, profondeur);
  const max = Math.max(...coups.map((x) => x.score));
  const seuil = Math.abs(max) >= VICTOIRE || rng() >= erreur ? max : max - marge;
  const meilleurs = coups.filter((x) => x.score >= seuil);
  const { v, k } = meilleurs[Math.floor(rng() * meilleurs.length)];
  return { v, k };
}

// Joueur au hasard (simulation)
export function choixHasard(d, rng = Math.random) {
  const coups = coupsEtat(etatDe(d));
  const { v, k } = coups[Math.floor(rng() * coups.length)];
  return { v, k };
}
