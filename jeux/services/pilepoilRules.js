// ============================================================
// pilepoilRules.js — Règles pures de Pile-Poil (`/pilepoil`) : 3 piles
// communes (A, B, C) qui partent de 0, à amener EXACTEMENT à CIBLE.
// À son tour, le joueur actif a 2 dés : son lancer et le dé laissé par
// l'adversaire. Il en joue un sur une pile (sans la dépasser), l'autre
// passe à l'adversaire. Une pile à CIBLE explose : +1 point, elle repart à
// 0 et son souffle (+SOUFFLE) touche les piles voisines non vides (A↔B,
// B↔C) ; une voisine qui tombe pile explose à son tour (+1 point), une
// voisine qui dépasse saute ratée (à 0, +1 pour l'adversaire). Aucun dé ne
// rentre nulle part : le joueur fait sauter la pile de son choix (+1 pour
// l'adversaire). Premier à SEUIL points gagne (si les deux l'atteignent sur
// le même coup : le plus de points, à égalité celui qui a joué).
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (tests, simulation).
//
// Joueurs : "joueur" (commence toujours contre Kévina, tiré au sort en 1v1)
// et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Pile-Poil), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const NB_PILES = 3;
export const CIBLE = 10;
export const SOUFFLE = 3;
export const SEUIL = 6;
const FACES = 6;

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

const lancer = (rng) => 1 + Math.floor(rng() * FACES);

// Piles voisines de la pile `k` (A↔B, B↔C)
const voisines = (k) => [k - 1, k + 1].filter((j) => j >= 0 && j < NB_PILES);

// Dé sélectionné par le joueur actif (`d.choix`) et l'autre
export const deJoue = (d) => (d.choix === "laisse" ? d.laisse : d.de);
export const deAutre = (d) => (d.choix === "laisse" ? d.de : d.laisse);

// Aucun des deux dés ne rentre sur aucune pile : le joueur doit faire
// sauter une pile.
export const bloque = (piles, des) => !des.some((v) => piles.some((p) => p + v <= CIBLE));

// Résout la pose de `v` sur la pile `k` (copie de `piles`) :
// { piles, explosions (piles explosées, dans l'ordre), ratees (piles
// sautées par le souffle), gain, perte }. Avec `contenu` (pièces de chaque
// pile, voir creerDuel) et `piece` (le dé posé) : `contenu` mis à jour
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

// Coups possibles sur les piles avec le dé `v` (par défaut celui que le
// joueur actif a sélectionné) : { k, type ("pose" | "explosion" |
// "sautee"), gain, perte }. Joueur bloqué : toutes les piles, à faire
// sauter.
export function coupsPossibles(d, v = deJoue(d)) {
  if (bloque(d.piles, [d.de, d.laisse])) {
    return d.piles.map((_, k) => ({ k, type: "sautee", gain: 0, perte: 1 }));
  }
  return d.piles.flatMap((p, k) => {
    if (p + v > CIBLE) return [];
    const r = resoudre(d.piles, k, v);
    return [{ k, type: r.gain ? "explosion" : "pose", gain: r.gain, perte: r.perte }];
  });
}

// Dé présélectionné en début de tour : le lancer, sauf s'il ne rentre sur
// aucune pile alors que le dé laissé, lui, rentre (sinon tous les boutons
// de pile seraient grisés).
function choixInitial(d) {
  const rentre = (v) => d.piles.some((p) => p + v <= CIBLE);
  return !rentre(d.de) && rentre(d.laisse) ? "laisse" : "lancer";
}

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  const d = {
    piles: Array(NB_PILES).fill(0),
    // Pièces de chaque pile, dans l'ordre (affichage) : { v, id } pour un
    // dé posé par `id`, { v: SOUFFLE, souffle: true } pour un souffle
    contenu: Array.from({ length: NB_PILES }, () => []),
    actif: commence,
    // Lancer du joueur actif et dé laissé par l'adversaire (au premier
    // tour, un second lancer) ; `choix` : dé sélectionné pour jouer
    de: lancer(rng),
    laisse: lancer(rng),
    choix: "lancer",
    points: { joueur: 0, bot: 0 },
    coups: 0,
    // Numéro de l'état affiché, +1 à chaque action (coup ou changement de
    // dé) : écarte un clic sur une vue dépassée
    vue: 0,
    // Dernier coup : { id, de, pile, type, explosions, ratees, gain, perte,
    // videes ({ pile: nombre de pièces } des piles vidées) }
    dernier: null,
    termine: false,
    gagnant: null,
  };
  d.choix = choixInitial(d);
  return d;
}

// 🔄 : le joueur actif sélectionne l'autre dé.
export function changerDe(d, id) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  d.choix = d.choix === "laisse" ? "lancer" : "laisse";
  d.vue += 1;
  return { choix: d.choix };
}

// Joue le dé sélectionné du joueur actif `id` sur la pile `k`, puis fin
// de partie (SEUIL atteint) ou tour adverse : l'autre dé lui passe, avec
// un nouveau lancer.
export function jouer(d, id, k, { rng = Math.random } = {}) {
  if (d.termine) return { erreur: "Partie terminée." };
  if (d.actif !== id) return { erreur: "Ce n'est pas ton tour." };
  if (!Number.isInteger(k) || k < 0 || k >= NB_PILES) return { erreur: "Pile inconnue." };

  const v = deJoue(d);
  const passe = deAutre(d);
  const adv = adversaire(id);
  let r;
  if (bloque(d.piles, [d.de, d.laisse])) {
    // Joueur bloqué : la pile choisie saute, +1 pour l'adversaire
    const piles = [...d.piles];
    piles[k] = 0;
    const contenu = d.contenu.map((pile, j) => (j === k ? [] : pile));
    r = { piles, contenu, videes: { [k]: d.contenu[k].length }, explosions: [], ratees: [k], gain: 0, perte: 1, type: "sautee" };
  } else {
    if (d.piles[k] + v > CIBLE) return { erreur: "Ce dé dépasserait la cible." };
    r = resoudre(d.piles, k, v, d.contenu, { v, id });
    r.type = r.gain ? "explosion" : "pose";
  }
  d.piles = r.piles;
  d.contenu = r.contenu;
  d.points[id] += r.gain;
  d.points[adv] += r.perte;
  d.coups += 1;
  d.vue += 1;
  d.dernier = { id, de: v, pile: k, type: r.type, explosions: r.explosions, ratees: r.ratees, gain: r.gain, perte: r.perte, videes: r.videes };

  if (d.points[id] >= SEUIL || d.points[adv] >= SEUIL) {
    d.termine = true;
    // Les deux à SEUIL ou plus sur le même coup : le plus de points, à
    // égalité celui qui a joué (il a déclenché l'explosion)
    d.gagnant = d.points[id] >= d.points[adv] ? id : adv;
  } else {
    d.actif = adv;
    d.laisse = passe;
    d.de = lancer(rng);
    d.choix = choixInitial(d);
  }
  return { de: v, type: r.type, gain: r.gain, perte: r.perte };
}

// ── Kévina ────────────────────────────────────────────────────────

// Tous les coups du joueur actif, avec ses deux dés : { choix ("lancer" |
// "laisse"), k, gain, perte, piles (après), passe (dé laissé à
// l'adversaire) }.
function tousLesCoups(d) {
  const coups = [];
  for (const choix of ["lancer", "laisse"]) {
    const v = choix === "laisse" ? d.laisse : d.de;
    const passe = choix === "laisse" ? d.de : d.laisse;
    if (bloque(d.piles, [d.de, d.laisse])) {
      d.piles.forEach((_, k) => {
        const piles = [...d.piles];
        piles[k] = 0;
        coups.push({ choix, k, gain: 0, perte: 1, piles, passe });
      });
      continue;
    }
    d.piles.forEach((p, k) => {
      if (p + v > CIBLE) return;
      const r = resoudre(d.piles, k, v);
      coups.push({ choix, k, gain: r.gain, perte: r.perte, piles: r.piles, passe });
    });
  }
  return coups;
}

// Bilan (points marqués − points donnés) du meilleur coup de l'adversaire
// au tour suivant, en moyenne sur son lancer (il aura aussi le dé `passe`).
function bilanAdverse(piles, passe) {
  let total = 0;
  for (let r = 1; r <= FACES; r++) {
    const coups = tousLesCoups({ piles, de: r, laisse: passe });
    total += Math.max(...coups.map((x) => x.gain - x.perte));
  }
  return total / FACES;
}

// Kévina maximise son bilan du coup (points marqués − points donnés) moins
// le bilan moyen du meilleur coup adverse au tour suivant (avec le dé
// qu'elle lui laisse), sans anticipation plus lointaine. `marge` : coup
// tiré au sort parmi ceux à `marge` points au plus du meilleur (variété,
// et des erreurs qui laissent sa chance au joueur). Réglage :
// `marge_kevina` de duel.json. Renvoie { choix, k } : sélectionner le dé
// `choix`, puis jouer la pile `k`.
export function choixKevina(d, id, { marge = 0, rng = Math.random } = {}) {
  const valeurs = tousLesCoups(d).map((x) => ({ ...x, v: x.gain - x.perte - bilanAdverse(x.piles, x.passe) }));
  const max = Math.max(...valeurs.map((x) => x.v));
  const meilleurs = valeurs.filter((x) => x.v >= max - marge);
  const { choix, k } = meilleurs[Math.floor(rng() * meilleurs.length)];
  return { choix, k };
}

// Joueur « de bon sens » (simulation) : le meilleur bilan immédiat, puis
// laisser le moins de piles que l'adversaire peut faire exploser avec un
// dé ; ne regarde pas le dé qu'il lui laisse. Renvoie { choix, k }.
export function choixSimple(d) {
  const risque = (piles) => piles.filter((p) => p > 0 && CIBLE - p <= FACES).length;
  const cle = (x) => (x.gain - x.perte) * 100 - risque(x.piles);
  const { choix, k } = tousLesCoups(d).reduce((b, x) => (cle(x) > cle(b) ? x : b));
  return { choix, k };
}

export function choixHasard(d, rng = Math.random) {
  const coups = tousLesCoups(d);
  const { choix, k } = coups[Math.floor(rng() * coups.length)];
  return { choix, k };
}
