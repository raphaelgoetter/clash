// ============================================================
// friseRules.js — règles pures de Frise (`/frise`) : classer des
// événements par année sur une frise commune. Aucun accès Redis ni Discord.
//
// Partie : une frise commune (une carte de départ, date visible), une main
// visible de `taille_main` cartes par joueur (dates cachées), une pioche.
// À son tour, le joueur choisit une carte de sa main et le créneau où
// l'insérer. Juste : la carte reste sur la frise. Faux : la carte est
// rangée à sa vraie place (date dévoilée) et le joueur pioche une carte.
// Le premier à vider sa main gagne ; si c'est le premier joueur, le second
// joue encore un tour (même nombre de tours) : les deux vides = match nul.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Frise), source de vérité.
// ============================================================

export const SIEGES = ["joueur", "bot"];

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

// Mélange de Fisher-Yates (copie).
function melanger(liste, rng) {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Paquet de la partie : cartes mélangées, en ne gardant que celles à au
// moins `ecartMin` ans de toutes les cartes déjà retenues (aucun créneau
// ambigu), sans les cartes retirées (`retiree: true`). Carte : { id
// (index dans cartes.json, pour l'URL de l'image), libelle, annee }.
export function construirePaquet(cartes, { ecartMin = 3, rng = Math.random } = {}) {
  const paquet = [];
  for (const id of melanger([...cartes.keys()], rng)) {
    const c = cartes[id];
    // Carte retirée : gardée dans le fichier (son id reste valable pour les
    // images déjà postées) mais jamais tirée
    if (c.retiree) continue;
    if (paquet.every((p) => Math.abs(p.annee - c.annee) >= ecartMin)) paquet.push({ id, libelle: c.libelle, annee: c.annee });
  }
  return paquet;
}

export function creerDuel(cartes, { commence = "joueur", tailleMain = 4, ecartMin = 3, rng = Math.random } = {}) {
  const pioche = construirePaquet(cartes, { ecartMin, rng });
  if (pioche.length < 2 * tailleMain + 1) throw new Error("Pas assez de cartes pour une partie de Frise");
  const frise = [pioche.shift()];
  const mains = { joueur: pioche.splice(0, tailleMain), bot: pioche.splice(0, tailleMain) };
  return {
    // Frise triée par année (dates visibles) ; `par` : siège qui a posé la
    // carte (absent pour la carte de départ)
    frise,
    // Mains visibles, dates cachées à l'affichage
    mains,
    pioche,
    actif: commence,
    premier: commence,
    // Carte choisie dans la main de chaque joueur (index), avant de placer
    choix: { joueur: 0, bot: 0 },
    // Numéro de l'état affiché, +1 à chaque coup : écarte un clic sur une
    // vue dépassée
    vue: 0,
    // Dernier coup : { id, carte, juste, pioche (carte piochée ou null) }
    dernier: null,
    // Erreurs de la partie, dans l'ordre : { id (siège), libelle, annee }
    erreurs: [],
    // Second joueur à son dernier tour (le premier a vidé sa main)
    dernierTour: false,
    termine: false,
    gagnant: null,
  };
}

// Créneaux de la frise : 0 (avant la première carte) à frise.length
// (après la dernière).
export const nbCreneaux = (d) => d.frise.length + 1;

// Libellé d'un créneau : « Avant 1492 », « Entre 1492 et 1789 », « Après 2016 ».
export function libelleCreneau(d, i, formatAnnee = String) {
  const f = d.frise;
  if (i === 0) return `Avant ${formatAnnee(f[0].annee)}`;
  if (i === f.length) return `Après ${formatAnnee(f[f.length - 1].annee)}`;
  return `Entre ${formatAnnee(f[i - 1].annee)} et ${formatAnnee(f[i].annee)}`;
}

// Vrai si l'année tombe dans le créneau i (bornes incluses).
export function creneauJuste(d, i, annee) {
  const f = d.frise;
  return (i === 0 || f[i - 1].annee <= annee) && (i === f.length || annee <= f[i].annee);
}

// Insère une carte à sa vraie place (frise triée).
function ranger(frise, carte) {
  const i = frise.findIndex((c) => c.annee > carte.annee);
  frise.splice(i === -1 ? frise.length : i, 0, carte);
}

// Choisit la carte (index dans la main) que le joueur s'apprête à placer.
export function choisir(d, id, index) {
  if (d.termine) return { erreur: "termine" };
  if (!Number.isInteger(index) || index < 0 || index >= d.mains[id].length) return { erreur: "carte" };
  d.choix[id] = index;
  return {};
}

// Place la carte choisie (`d.choix[id]`) dans le créneau `creneau`.
export function placer(d, id, creneau) {
  if (d.termine) return { erreur: "termine" };
  if (d.actif !== id) return { erreur: "pasTonTour" };
  if (!Number.isInteger(creneau) || creneau < 0 || creneau > d.frise.length) return { erreur: "creneau" };
  const main = d.mains[id];
  const index = Math.min(d.choix[id] ?? 0, main.length - 1);
  const [carte] = main.splice(index, 1);
  const juste = creneauJuste(d, creneau, carte.annee);
  // Auteur de la pose (couleur de la carte sur l'image), même après une erreur
  carte.par = id;
  ranger(d.frise, carte);
  // Erreur : une carte de pénalité (rien si la pioche est vide)
  const pioche = juste ? null : (d.pioche.shift() ?? null);
  if (pioche) main.push(pioche);
  d.choix[id] = 0;
  d.dernier = { id, carte, juste, pioche };
  if (!juste) (d.erreurs ??= []).push({ id, libelle: carte.libelle, annee: carte.annee });
  d.vue++;
  finDeTour(d, id);
  return { juste, carte, pioche };
}

// Fin de tour : victoire, dernier tour du second joueur, ou main suivante.
function finDeTour(d, id) {
  const autre = adversaire(id);
  const vide = (s) => d.mains[s].length === 0;
  if (d.dernierTour) {
    // Le second vient de jouer son dernier tour
    Object.assign(d, { termine: true, gagnant: vide(id) ? "nul" : autre, actif: null });
    return;
  }
  if (vide(id)) {
    if (id === d.premier) {
      // Même nombre de tours : le second joue encore une fois
      d.dernierTour = true;
      d.actif = autre;
      return;
    }
    Object.assign(d, { termine: true, gagnant: id, actif: null });
    return;
  }
  // Pioche épuisée et plus aucune carte à placer pour l'autre : ne peut
  // pas arriver (une main vide termine la partie), donc on passe la main
  d.actif = autre;
}

// ── Kévina ────────────────────────────────────────────────────────────
// Elle connaît les dates mais se trompe d'autant plus que la carte tombe
// près de ses voisines : probabilité d'erreur
// `erreur * echelle / (echelle + écart)` (écart en années à la voisine la
// plus proche sur la frise). Elle joue la carte la plus sûre de sa main.
// En cas d'erreur, elle vise un créneau voisin du bon.

export function ecartVoisines(d, annee) {
  const f = d.frise;
  const i = f.findIndex((c) => c.annee > annee);
  const avant = i === -1 ? f[f.length - 1] : i > 0 ? f[i - 1] : null;
  const apres = i === -1 ? null : f[i];
  return Math.min(avant ? annee - avant.annee : Infinity, apres ? apres.annee - annee : Infinity);
}

export function probaErreurKevina(d, annee, { erreur = 0.8, echelle = 20 } = {}) {
  const ecart = ecartVoisines(d, annee);
  return Number.isFinite(ecart) ? (erreur * echelle) / (echelle + ecart) : 0;
}

const bonCreneau = (d, annee) => {
  const i = d.frise.findIndex((c) => c.annee > annee);
  return i === -1 ? d.frise.length : i;
};

// Coup de Kévina : { index (carte de sa main), creneau }.
export function choixKevina(d, id = "bot", { erreur = 0.8, echelle = 20, rng = Math.random } = {}) {
  const main = d.mains[id];
  let index = 0;
  let meilleure = Infinity;
  main.forEach((c, k) => {
    const p = probaErreurKevina(d, c.annee, { erreur, echelle });
    if (p < meilleure) [index, meilleure] = [k, p];
  });
  const juste = bonCreneau(d, main[index].annee);
  if (rng() >= meilleure) return { index, creneau: juste };
  // Erreur : un créneau voisin (celui qui existe)
  const voisins = [juste - 1, juste + 1].filter((c) => c >= 0 && c <= d.frise.length);
  return { index, creneau: voisins[Math.floor(rng() * voisins.length)] };
}
