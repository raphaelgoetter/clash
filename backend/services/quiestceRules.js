// ============================================================
// quiestceRules.js — Règles pures de Qui est-ce ? (jeu spécial de 7 jours) :
// chaque joueur reçoit une carte secrète d'une grille commune, chasse une
// cible qu'il choisit (le meneur est proposé) en posant une question par
// jour (parmi les 3 questions du jour, 4 avec la Loupe), puis l'accuse ; score = cartes
// découvertes moins fois démasqué. Chaque jour, un objet gratuit tiré au
// hasard (offensif contre sa cible ou défensif contre son chasseur),
// utilisable ou à garder. Aucune I/O : la couche Redis (quiestce.js) lit
// la partie, appelle ces fonctions sous verrou puis réécrit la partie.
//
// Toutes les fonctions modifient la partie reçue en place (la couche Redis
// travaille sur une copie fraîchement désérialisée) ; `rng` injectable pour
// les tests.
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Qui est-ce ?), source de vérité.
// ============================================================

// ── Questions ───────────────────────────────────────────────────────
// Réponses en tranches (décision du 11/10 : avec les valeurs exactes,
// « Élixir ? » était toujours la meilleure première question). Portée et
// PV ne concernent que les troupes : « sans objet » pour un sort ou un
// bâtiment (données incomplètes pour ces cartes dans cardNames.json).

const RARETES = { common: "commune", rare: "rare", epic: "épique", legendary: "légendaire ou champion", champion: "légendaire ou champion" };
const TYPES = { troop: "troupe terrestre", flying: "troupe aérienne", spell: "sort", building: "bâtiment" };
const FAMILLES = { human: "humain", goblin: "gobelin", skeleton: "squelette", minion: "gargouille" };
const SANS_OBJET = "sans objet (sort ou bâtiment)";

const estTroupe = (c) => c.type === "troop" || c.type === "flying";

export const QUESTIONS = {
  rarete: { nom: "Rareté", emoji: "💎", valeur: (c) => RARETES[c.rarity] },
  elixir: { nom: "Élixir", emoji: "💧", valeur: (c) => (c.elixir <= 2 ? "1 ou 2" : c.elixir === 3 ? "3" : c.elixir === 4 ? "4" : "5 ou plus") },
  type: { nom: "Type", emoji: "🧩", valeur: (c) => TYPES[c.type] },
  portee: { nom: "Portée", emoji: "🏹", valeur: (c) => (!estTroupe(c) ? SANS_OBJET : c.range.kind === "ranged" ? "distance" : "mêlée") },
  famille: { nom: "Famille", emoji: "👪", valeur: (c) => FAMILLES[c.family] || "aucune" },
  pv: { nom: "Points de vie", emoji: "❤️", valeur: (c) => (!estTroupe(c) ? SANS_OBJET : c.hp < 500 ? "moins de 500" : c.hp <= 1500 ? "500 à 1500" : "plus de 1500") },
};
export const QIDS = Object.keys(QUESTIONS);

// Carte jouable : coût connu, et PV/portée renseignés pour les troupes
// (les troupes sans ces données, même après completerCartes(), sont
// écartées, voir CONTRIBUTING.md).
export function carteEligible(c) {
  if (c.elixir == null || !TYPES[c.type] || !RARETES[c.rarity]) return false;
  return !estTroupe(c) || (c.hp != null && !!c.range?.kind);
}

// Complète les troupes sans PV ni portée dans cardNames.json avec la table
// `complements` de quiestce.json (wiki Clash Royale, niveau Tournament
// Standard) : utilisée par Qui est-ce ? seulement, cardNames.json n'est pas
// modifié (ces valeurs doubles ou variables en avaient été exclues pour La
// Juste Carte, voir scripts/generateCardStats.js).
export function completerCartes(cartesData, complements = {}) {
  return cartesData.map((c) => {
    const comp = complements[c.cardKey];
    if (!comp || (c.hp != null && c.range?.kind)) return c;
    return { ...c, hp: c.hp ?? comp.hp, range: c.range?.kind ? c.range : { kind: comp.portee } };
  });
}

export function profil(c) {
  return Object.fromEntries(QIDS.map((q) => [q, QUESTIONS[q].valeur(c)]));
}

const signature = (p) => QIDS.map((q) => p[q]).join("|");

// ── Utilitaires ─────────────────────────────────────────────────────

const JOURNAL_MAX = 1000;

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Journal : { j, k, s, v, c, ids, … } pour un événement public (rédigé à
// l'affichage par texteJournal()), { j, t, p } pour une note privée.
// Les entrées cruciales (démasquages, Déguisement) figurent sur le message
// officiel ; le bouton Journal montre à chacun ce qui le concerne.
function noter(partie, k, { s = null, v = null, ids = null, crucial = false, ...donnees } = {}) {
  journaliser(partie, { j: partie.numeroJour ?? 1, k, s, v, ...donnees, c: crucial, ids: ids ?? [s, v].filter(Boolean) });
}

function prive(partie, id, texte) {
  journaliser(partie, { j: partie.numeroJour ?? 1, t: texte, p: id });
}

function journaliser(partie, entree) {
  partie.journal.push(entree);
  if (partie.journal.length > JOURNAL_MAX) partie.journal.splice(0, partie.journal.length - JOURNAL_MAX);
}

function bilanVide() {
  return { demasquages: [], deguisements: 0, brouillards: 0, desamorcages: 0, erreurs: 0, questions: 0 };
}

function bilan(partie) {
  partie.jour ??= bilanVide();
  return partie.jour;
}

export function nomCarte(partie, cardKey) {
  return partie.cartes?.[cardKey]?.nom ?? cardKey;
}

// ── Partie et joueurs ───────────────────────────────────────────────

export function creerPartie() {
  return { demarree: false, grille: [], cartes: {}, joueurs: {}, journal: [], numeroJour: 1, seq: 0, termine: false, jour: bilanVide(), veille: null };
}

function nouvelleEnquete() {
  return { infos: {}, ordre: [], sources: {}, posees: 0, eliminees: [] };
}

function nouveauJoueur(username, arrivee) {
  return {
    username: username || "?",
    arrivee,
    carte: null,
    cible: null,
    enquete: nouvelleEnquete(),
    // Joueurs démasqués et carte qu'ils avaient alors (un Déguisement
    // ultérieur ne change pas ce que le chasseur sait)
    demasques: [],
    cartesConnues: [],
    nbDemasque: 0,
    erreurs: 0,
    seqScore: 0,
    objets: [],
    // Caractéristiques connues de la carte d'autres joueurs (Miroir), ajoutées
    // à l'enquête si l'un d'eux devient la cible
    renseignements: {},
    questionsJour: 0,
    loupe: false,
    accusationsJour: 0,
    // Accusations du jour sur la cible actuelle, et cible visée par une
    // Double accusation (valable pour cette cible seulement)
    accusationsCible: 0,
    doubleCible: null,
    objetJour: false,
    objetRecuJour: false,
    brouillard: false,
    miroir: false,
  };
}

export function nbInscrits(partie) {
  return Object.keys(partie.joueurs).length;
}

// Inscription pendant la fenêtre d'inscription (bouton S'inscrire), dans la
// limite de `effectif_max` : sans carte, la carte et la première cible sont
// attribuées par demarrer(). Plus aucune arrivée une fois la partie lancée.
export function inscrire(partie, id, username, { config }) {
  if (partie.joueurs[id]) return { joueur: partie.joueurs[id] };
  if (partie.demarree) return { erreur: "inscriptions" };
  if (nbInscrits(partie) >= config.effectif_max) return { erreur: "complet" };
  partie.joueurs[id] = nouveauJoueur(username, nbInscrits(partie));
  return { joueur: partie.joueurs[id], nouveau: true };
}

// Désinscription, possible jusqu'au lancement ; les ordres d'arrivée
// suivants sont recalés.
export function desinscrire(partie, id) {
  const j = partie.joueurs[id];
  if (!j) return { erreur: "pasInscrit" };
  if (partie.demarree) return { erreur: "inscriptions" };
  delete partie.joueurs[id];
  for (const autre of Object.values(partie.joueurs)) if (autre.arrivee > j.arrivee) autre.arrivee -= 1;
  return { ok: true };
}

// Tirage de la grille : `taille` cartes éligibles, une seule par profil de
// réponses (sinon deux « jumelles » seraient indiscernables), avec au moins
// 4 sorts, 2 bâtiments, 3 troupes aériennes et 1 ou 2 champions.
export function tirerGrille(cartesData, taille, rng = Math.random) {
  const eligibles = cartesData.filter(carteEligible);
  let meilleure = null;
  for (let essai = 0; essai < 400; essai++) {
    const vues = new Set();
    const grille = [];
    for (const c of shuffle(eligibles, rng)) {
      const sig = signature(profil(c));
      if (vues.has(sig)) continue;
      vues.add(sig);
      grille.push(c);
      if (grille.length >= taille) break;
    }
    const n = (t) => grille.filter((c) => c.type === t).length;
    const champions = grille.filter((c) => c.rarity === "champion").length;
    if (n("spell") >= 4 && n("building") >= 2 && n("flying") >= 3 && champions >= 1 && champions <= 2) return grille;
    meilleure ??= grille;
  }
  return meilleure;
}

// Jour 1 : grille tirée (`taille_grille` cartes, au moins une par joueur),
// une carte secrète par joueur, et première cible attribuée en cercle
// (chacun chasse le suivant : un seul chasseur par cible, sans paire qui
// se chasse mutuellement).
export function demarrer(partie, { config, cartesData, rng = Math.random }) {
  const ids = shuffle(Object.keys(partie.joueurs), rng);
  const taille = Math.max(config.taille_grille, ids.length);
  const grille = tirerGrille(cartesData, taille, rng);
  partie.grille = grille.map((c) => c.cardKey);
  partie.cartes = Object.fromEntries(grille.map((c) => [c.cardKey, { nom: c.fr, profil: profil(c) }]));
  const pioche = shuffle(partie.grille, rng);
  ids.forEach((id, i) => {
    partie.joueurs[id].carte = pioche[i] ?? null;
  });
  partie.demarree = true;
  if (ids.length > 1) ids.forEach((id, i) => assignerCible(partie, id, ids[(i + 1) % ids.length], { config, rng }));
  return partie;
}

// Cartes de la grille que personne n'a, hors cartes déjà découvertes par
// un chasseur (sinon un Déguisement pourrait tomber sur une carte qu'un
// chasseur barre à juste titre de sa fiche).
export function cartesLibres(partie) {
  const prises = new Set(Object.values(partie.joueurs).flatMap((j) => [j.carte, ...j.cartesConnues]));
  return partie.grille.filter((k) => !prises.has(k));
}

// ── Cibles ──────────────────────────────────────────────────────────

export function chasseurs(partie, cibleId) {
  return Object.entries(partie.joueurs).filter(([, j]) => j.cible === cibleId).map(([id]) => id);
}

// Cibles possibles : au plus `chasseurs_max` chasseurs par cible, jamais un
// joueur déjà démasqué par ce chasseur (il connaît sa carte). Triées du
// meneur au dernier (points, puis cartes découvertes, puis arrivée) : la
// première est proposée par défaut (décision du 12/10 : démasquer le
// meneur lui retire un point, rattrapage naturel).
export function ciblesDisponibles(partie, id, { config, sauf = null }) {
  const moi = partie.joueurs[id];
  return Object.entries(partie.joueurs)
    .filter(([cid, j]) => cid !== id && cid !== sauf && j.carte && !moi.demasques.includes(cid) && chasseurs(partie, cid).length < config.chasseurs_max)
    .sort(([, a], [, b]) => points(b) - points(a) || b.demasques.length - a.demasques.length || a.arrivee - b.arrivee)
    .map(([cid]) => cid);
}

// Cible choisie par le joueur (décision du 12/10, après un essai de tirage
// au sort) : seulement sans cible (après un démasquage), parmi les cibles
// disponibles.
export function choisirCible(partie, id, cibleId, { config, rng = Math.random }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.carte) return { erreur: "inconnu" };
  if (moi.cible) return { erreur: "dejaCible" };
  if (!ciblesDisponibles(partie, id, { config }).includes(cibleId)) return { erreur: "cible" };
  const depart = assignerCible(partie, id, cibleId, { config, rng });
  noter(partie, "cible", { s: id, v: cibleId });
  return { cible: cibleId, depart };
}

// Nouvelle cible : enquête neuve, renseignements du Miroir sur ce joueur,
// puis l'indice de départ (décision du 11/10) : une
// caractéristique de la carte tirée au hasard parmi celles encore
// inconnues, de préférence hors des questions du jour (sinon il retirerait
// une des 3 questions proposées). Renvoie l'indice { q, valeur }.
function assignerCible(partie, id, cibleId, { config, rng }) {
  const moi = partie.joueurs[id];
  moi.cible = cibleId;
  moi.accusationsCible = 0;
  moi.enquete = nouvelleEnquete();
  for (const [q, valeur] of Object.entries(moi.renseignements?.[cibleId] ?? {})) ajouterInfo(moi.enquete, q, valeur, "miroir");
  return donnerIndice(partie, id, { config, rng });
}

function donnerIndice(partie, id, { config, rng }) {
  const moi = partie.joueurs[id];
  const inconnues = QIDS.filter((q) => !(q in moi.enquete.infos));
  if (!inconnues.length) return null;
  const base = config.pool[String(partie.numeroJour)] ?? [];
  const avecLoupe = [...base, config.pool_loupe?.[String(partie.numeroJour)]].filter(Boolean);
  const horsTout = inconnues.filter((q) => !avecLoupe.includes(q));
  const horsBase = inconnues.filter((q) => !base.includes(q));
  const tirage = horsTout.length ? horsTout : horsBase.length ? horsBase : inconnues;
  const q = tirage[Math.floor(rng() * tirage.length)];
  const cible = partie.joueurs[moi.cible];
  const valeur = partie.cartes[cible.carte].profil[q];
  ajouterInfo(moi.enquete, q, valeur, "depart");
  prive(partie, id, `🗂️ Indice de départ sur **${cible.username}** : ${QUESTIONS[q].nom.toLowerCase()} **${valeur}**.`);
  return { q, valeur };
}

function ajouterInfo(enquete, q, valeur, source) {
  if (q in enquete.infos) return false;
  enquete.infos[q] = valeur;
  enquete.ordre.push(q);
  enquete.sources[q] = source;
  return true;
}

// ── Début de journée d'un joueur ────────────────────────────────────

// À la première action du jour : un objet gratuit tiré au hasard (si la
// réserve n'est pas pleine). Renvoie { objetRecu }.
export function debutAction(partie, id, { config, rng = Math.random }) {
  const moi = partie.joueurs[id];
  const r = { objetRecu: null };
  if (!partie.demarree || partie.termine || !moi?.carte) return r;
  if (!moi.objetRecuJour) {
    moi.objetRecuJour = true;
    if (moi.objets.length < config.inventaire_max) {
      r.objetRecu = tirerObjet(config, rng);
      // Pas de note au journal : seuls les objets utilisés y figurent
      moi.objets.push(r.objetRecu);
    }
  }
  return r;
}

function tirerObjet(config, rng) {
  const entrees = Object.entries(config.tirage_objets);
  const total = entrees.reduce((a, [, p]) => a + p, 0);
  let x = rng() * total;
  for (const [o, p] of entrees) {
    if ((x -= p) < 0) return o;
  }
  return entrees.at(-1)[0];
}

// ── Enquête ─────────────────────────────────────────────────────────

// Cartes encore possibles pour la cible : compatibles avec les réponses
// connues, hors sa propre carte, les cartes déjà découvertes (chaque carte
// n'appartient qu'à un joueur) et les accusations ratées.
export function candidats(partie, id) {
  const moi = partie.joueurs[id];
  if (!moi?.cible) return [];
  const connues = new Set([moi.carte, ...moi.cartesConnues]);
  const { infos, eliminees } = moi.enquete;
  return partie.grille.filter(
    (k) => !connues.has(k) && !eliminees.includes(k) && Object.entries(infos).every(([q, v]) => partie.cartes[k].profil[q] === v),
  );
}

// Questions du jour encore utiles sur la cible : les 3 de base, plus la
// question Loupe du jour (`pool_loupe`) si la Loupe est active ; si elles
// sont toutes connues, n'importe quelle autre question (décision du 11/10).
export function questionsDuJour(partie, { config, loupe = false }) {
  const jour = String(partie.numeroJour);
  const base = config.pool[jour] ?? QIDS;
  return loupe && config.pool_loupe?.[jour] ? [...base, config.pool_loupe[jour]] : base;
}

export function questionsPossibles(partie, id, { config }) {
  const moi = partie.joueurs[id];
  if (!moi?.cible) return [];
  const inconnues = (liste) => liste.filter((q) => !(q in moi.enquete.infos));
  const duJour = inconnues(questionsDuJour(partie, { config, loupe: moi.loupe }));
  return duJour.length ? duJour : inconnues(QIDS);
}

export function questionsRestantes(j, config) {
  return config.questions_par_jour - (j.questionsJour ?? 0);
}

// Question sur la cible ; sous Brouillard, la question est perdue sans
// réponse.
export function poser(partie, id, q, { config }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.cible) return { erreur: "sansCible" };
  if (questionsRestantes(moi, config) < 1) return { erreur: "plafondQuestion" };
  if (!questionsPossibles(partie, id, { config }).includes(q)) return { erreur: "question" };
  const cible = partie.joueurs[moi.cible];
  moi.questionsJour += 1;
  bilan(partie).questions += 1;
  // Miroir (secret) : la cible apprend la même caractéristique de la carte
  // de son chasseur
  if (cible.miroir) {
    cible.miroir = false;
    const reflet = partie.cartes[moi.carte].profil[q];
    cible.renseignements[id] = { ...(cible.renseignements[id] ?? {}), [q]: reflet };
    if (cible.cible === id) ajouterInfo(cible.enquete, q, reflet, "miroir");
    prive(partie, moi.cible, `🪞 Miroir : **${moi.username}** t'a interrogé (${QUESTIONS[q].nom.toLowerCase()}). Sa carte : ${QUESTIONS[q].nom.toLowerCase()} **${reflet}**.`);
  }
  if (cible.brouillard) {
    prive(partie, id, `🌫️ ${QUESTIONS[q].nom} de la carte de **${cible.username}** : réponse brouillée.`);
    return { q, brouille: true };
  }
  const valeur = partie.cartes[cible.carte].profil[q];
  ajouterInfo(moi.enquete, q, valeur, "question");
  moi.enquete.posees += 1;
  prive(partie, id, `🔎 ${QUESTIONS[q].nom} de la carte de **${cible.username}** : **${valeur}**.`);
  return { q, valeur };
}

// Une accusation par jour (deux avec la Double accusation). Juste : une
// carte découverte (+1), la cible est démasquée (-1 pour elle), le
// chasseur choisit sa prochaine cible. Fausse : la carte est barrée
// (accusation ratée comptée dans le départage). Sous Brouillard (option
// `brouillard_bloque_accusation`), aucune accusation possible.
// Une accusation par jour, toutes cibles confondues ; avec une Double
// accusation sur la cible actuelle, deux accusations sur elle, même si une
// accusation a déjà été faite plus tôt dans la journée sur une autre cible
// (décision du 12/10).
export function accusationsRestantes(j) {
  if (j.cible && j.doubleCible === j.cible) return 2 - (j.accusationsCible ?? 0);
  return 1 - (j.accusationsJour ?? 0);
}

export function accuser(partie, id, cardKey, { config, rng = Math.random }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.cible) return { erreur: "sansCible" };
  if (accusationsRestantes(moi) < 1) return { erreur: "plafondAccusation" };
  if (!candidats(partie, id).includes(cardKey)) return { erreur: "carte" };
  const cibleId = moi.cible;
  const cible = partie.joueurs[cibleId];
  // Option `brouillard_bloque_accusation` : le Brouillard protège aussi des accusations
  if (cible.brouillard && config.brouillard_bloque_accusation) return { erreur: "brouillard" };
  moi.accusationsJour += 1;
  moi.accusationsCible = (moi.accusationsCible ?? 0) + 1;
  if (cible.carte !== cardKey) {
    moi.erreurs += 1;
    moi.enquete.eliminees.push(cardKey);
    bilan(partie).erreurs += 1;
    prive(partie, id, `❌ Raté : **${cible.username}** n'a pas la carte ${nomCarte(partie, cardKey)}.`);
    return { correct: false };
  }
  partie.seq = (partie.seq ?? 0) + 1;
  moi.seqScore = partie.seq;
  moi.demasques.push(cibleId);
  moi.cartesConnues.push(cardKey);
  moi.cible = null;
  moi.enquete = nouvelleEnquete();
  cible.nbDemasque += 1;
  bilan(partie).demasquages.push({ s: id, v: cibleId });
  noter(partie, "demasque", { s: id, v: cibleId, crucial: true });
  prive(partie, id, `🎯 Tu as démasqué **${cible.username}** : ${nomCarte(partie, cardKey)}.`);
  return { correct: true, cible: cibleId };
}

// ── Objets ──────────────────────────────────────────────────────────
// Un objet gratuit par jour (debutAction), gardé en réserve jusqu'à
// `inventaire_max` ; un seul objet utilisé par jour. Offensifs contre sa
// cible, défensifs contre son chasseur (décision du 12/10).

export const OBJETS = {
  loupe: { nom: "Loupe", emoji: "🔍", famille: "offensif", effet: "Débloque une 4e question au choix aujourd'hui." },
  double: { nom: "Double accusation", emoji: "🎯", famille: "offensif", effet: "Deux accusations aujourd'hui sur ta cible actuelle." },
  desamorcage: { nom: "Désamorçage", emoji: "🧨", famille: "offensif", effet: "Coupe le Brouillard ou le Miroir de ta cible, sinon détruit un objet défensif de sa réserve." },
  brouillard: { nom: "Brouillard", emoji: "🌫️", famille: "defensif", effet: "Jusqu'à la clôture, questions sans réponse et accusations impossibles contre toi." },
  deguisement: { nom: "Déguisement", emoji: "🎭", famille: "defensif", effet: "Change ta carte contre une carte libre : tes chasseurs perdent leurs indices." },
  miroir: { nom: "Miroir", emoji: "🪞", famille: "defensif", effet: "Secret : la prochaine question sur toi te révèle la même caractéristique de ton chasseur." },
};

export const DEFENSIFS = Object.keys(OBJETS).filter((o) => OBJETS[o].famille === "defensif");

// Utilisable ? { ok } ou { ok: false, raison }.
export function etatObjet(partie, id, objet, { config }) {
  const moi = partie.joueurs[id];
  if (!moi.objets.includes(objet)) return { ok: false, raison: "pasEnReserve" };
  if (moi.objetJour) return { ok: false, raison: "objetJour" };
  if (OBJETS[objet].famille === "offensif" && !moi.cible) return { ok: false, raison: "sansCible" };
  if (objet === "loupe" && moi.loupe) return { ok: false, raison: "dejaActif" };
  if (objet === "double" && moi.doubleCible === moi.cible) return { ok: false, raison: "dejaActif" };
  if (objet === "double" && (moi.accusationsCible ?? 0) >= 2) return { ok: false, raison: "accusationsFaites" };
  if (objet === "loupe" && questionsRestantes(moi, config) < 1) return { ok: false, raison: "questionPosee" };
  if (objet === "brouillard" && moi.brouillard) return { ok: false, raison: "dejaActif" };
  if (objet === "miroir" && moi.miroir) return { ok: false, raison: "dejaActif" };
  if (objet === "deguisement" && !cartesLibres(partie).length) return { ok: false, raison: "aucuneCarteLibre" };
  return { ok: true };
}

export function utiliserObjet(partie, id, objet, { config, rng = Math.random }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.carte || !OBJETS[objet]) return { erreur: "objet" };
  const etat = etatObjet(partie, id, objet, { config });
  if (!etat.ok) return { erreur: etat.raison };
  moi.objets.splice(moi.objets.indexOf(objet), 1);
  moi.objetJour = true;

  if (objet === "loupe") {
    moi.loupe = true;
    const q = config.pool_loupe?.[String(partie.numeroJour)];
    prive(partie, id, `🔍 Loupe : 4e question débloquée aujourd'hui (${QUESTIONS[q]?.nom ?? "?"}).`);
    return { objet, q };
  }
  if (objet === "double") {
    moi.doubleCible = moi.cible;
    prive(partie, id, `🎯 Double accusation : deux accusations aujourd'hui sur **${partie.joueurs[moi.cible].username}**.`);
    return { objet, cible: moi.cible };
  }
  if (objet === "desamorcage") {
    const cible = partie.joueurs[moi.cible];
    let detruit = null;
    if (cible.brouillard) {
      cible.brouillard = false;
      detruit = "brouillard";
    } else if (cible.miroir) {
      cible.miroir = false;
      detruit = "miroir";
    } else {
      const defensifs = cible.objets.filter((o) => DEFENSIFS.includes(o));
      if (defensifs.length) {
        detruit = defensifs[Math.floor(rng() * defensifs.length)];
        cible.objets.splice(cible.objets.indexOf(detruit), 1);
      }
    }
    bilan(partie).desamorcages += 1;
    noter(partie, "desamorcage", { s: id, v: moi.cible, objet: detruit });
    prive(partie, id, detruit ? `🧨 Désamorçage : tu détruis le ${OBJETS[detruit].nom} de **${cible.username}**.` : `🧨 Désamorçage : **${cible.username}** n'avait rien à désamorcer.`);
    if (detruit) prive(partie, moi.cible, `🧨 **${moi.username}** a détruit ton ${OBJETS[detruit].nom} !`);
    return { objet, cible: moi.cible, detruit };
  }
  if (objet === "brouillard") {
    moi.brouillard = true;
    bilan(partie).brouillards += 1;
    noter(partie, "brouillard", { s: id });
    return { objet };
  }
  if (objet === "miroir") {
    moi.miroir = true;
    prive(partie, id, "🪞 Miroir posé (secret) jusqu'à la clôture.");
    return { objet };
  }
  // Déguisement : nouvelle carte libre ; indices des chasseurs et
  // renseignements du Miroir sur l'ancienne carte devenus faux
  const libres = cartesLibres(partie);
  const ancienne = moi.carte;
  moi.carte = libres[Math.floor(rng() * libres.length)];
  for (const j of Object.values(partie.joueurs)) delete j.renseignements?.[id];
  const victimes = chasseurs(partie, id);
  for (const hid of victimes) partie.joueurs[hid].enquete = nouvelleEnquete();
  bilan(partie).deguisements += 1;
  noter(partie, "deguisement", { s: id, ids: [id, ...victimes], crucial: true });
  prive(partie, id, `🎭 Déguisement : ta carte ${nomCarte(partie, ancienne)} devient **${nomCarte(partie, moi.carte)}**.`);
  return { objet, carte: moi.carte, chasseurs: victimes.length };
}

// ── Clôture et classement ───────────────────────────────────────────

// Clôture du jour : compteurs quotidiens, Brouillard et Miroir remis à zéro.
export function cloturer(partie) {
  for (const j of Object.values(partie.joueurs)) {
    j.questionsJour = 0;
    j.loupe = false;
    j.accusationsJour = 0;
    j.accusationsCible = 0;
    j.doubleCible = null;
    j.objetJour = false;
    j.objetRecuJour = false;
    j.brouillard = false;
    j.miroir = false;
  }
  partie.veille = bilan(partie);
  partie.jour = bilanVide();
  partie.numeroJour = (partie.numeroJour ?? 1) + 1;
}

// Classement (décision du 12/10) : points = cartes découvertes moins fois
// démasqué ; puis le plus de cartes découvertes, le moins d'accusations
// ratées, le premier à avoir atteint son total, l'arrivée.
export function points(j) {
  return j.demasques.length - j.nbDemasque;
}

export function classement(partie) {
  const ordre = Object.entries(partie.joueurs)
    .filter(([, j]) => j.carte)
    .sort(
      ([, a], [, b]) =>
        points(b) - points(a) ||
        b.demasques.length - a.demasques.length ||
        a.erreurs - b.erreurs ||
        (a.seqScore || Infinity) - (b.seqScore || Infinity) ||
        a.arrivee - b.arrivee,
    );
  return ordre.map(([discordId, j], i) => ({
    discordId,
    username: j.username,
    rang: i + 1,
    score: points(j),
    decouvertes: j.demasques.length,
    nbDemasque: j.nbDemasque,
    erreurs: j.erreurs,
    carte: j.carte,
  }));
}

// ── Journal ─────────────────────────────────────────────────────────

// Texte d'une entrée pour le joueur `moi` (deuxième personne quand l'action
// le concerne), ou pour tous (`moi` = null, message officiel).
export function texteJournal(partie, e, moi = null) {
  if (e.t) return e.t;
  const n = (id) => `**${partie.joueurs[id]?.username ?? "?"}**`;
  const S = n(e.s);
  const V = n(e.v);
  const parMoi = moi != null && e.s === moi;
  const surMoi = moi != null && e.v === moi;
  switch (e.k) {
    case "demasque":
      if (parMoi) return `🎯 Tu as démasqué ${V} !`;
      if (surMoi) return `🎯 ${S} t'a démasqué !`;
      return `🎯 ${S} a démasqué ${V} !`;
    case "desamorcage": {
      const quoi = e.objet ? `détruit le ${OBJETS[e.objet].nom}` : "ne trouve rien à désamorcer";
      if (parMoi) return `🧨 Ton Désamorçage ${quoi} de ${V}.`;
      if (surMoi) return `🧨 Le Désamorçage de ${S} ${quoi} chez toi !`;
      return `🧨 Le Désamorçage de ${S} ${quoi} chez ${V}.`;
    }
    case "deguisement":
      if (parMoi) return "🎭 Tu te déguises : tes chasseurs perdent leurs indices !";
      if (moi != null && e.ids?.includes(moi)) return `🎭 ${S} s'est déguisé : tes indices sur sa carte sont effacés !`;
      return `🎭 ${S} s'est déguisé : ses chasseurs perdent leurs indices !`;
    case "brouillard":
      if (parMoi) return "🌫️ Tu t'enveloppes de brouillard jusqu'à la clôture.";
      return `🌫️ ${S} s'enveloppe de brouillard jusqu'à la clôture.`;
    case "cible":
      if (parMoi) return `🎯 Ta nouvelle cible : ${V}.`;
      if (surMoi) return `👀 ${S} te prend pour cible !`;
      return `👀 ${S} prend ${V} pour cible.`;
    default:
      return "";
  }
}
