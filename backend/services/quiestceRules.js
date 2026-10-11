// ============================================================
// quiestceRules.js — Règles pures de Qui est-ce ? (jeu spécial de 7 jours) :
// chaque joueur reçoit une carte secrète d'une grille commune, chasse une
// cible en posant une question par jour (parmi les 3 questions du jour),
// puis l'accuse ; chaque démasquage rapporte des points et la prime de la
// cible. Aucune I/O : la couche Redis (quiestce.js) lit la partie, appelle
// ces fonctions sous verrou puis réécrit la partie.
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
// Les entrées cruciales (démasquages, Projecteur) figurent sur le message
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
  return { demasquages: [], projecteurs: 0, vols: 0, erreurs: 0, questions: 0 };
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
  return { demarree: false, grille: [], cartes: {}, reveles: {}, joueurs: {}, journal: [], numeroJour: 1, seq: 0, termine: false, jour: bilanVide(), veille: null };
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
    score: 0,
    prime: 0,
    or: 0,
    demasques: [],
    nbDemasque: 0,
    erreurs: 0,
    seqScore: 0,
    objets: 0,
    doubleUtilise: false,
    questionsJour: 0,
    bonusQuestions: 0,
    accuseJour: false,
    objetJour: false,
    actifJour: false,
    demasqueJour: false,
  };
}

// Inscription avant le Jour 1 (bouton Participer) : sans carte, la carte
// et la première cible sont attribuées par demarrer().
export function inscrire(partie, id, username) {
  if (partie.joueurs[id]) return partie.joueurs[id];
  partie.joueurs[id] = nouveauJoueur(username, Object.keys(partie.joueurs).length);
  return partie.joueurs[id];
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

// Jour 1 : grille tirée (au moins `taille_grille` cartes, et `reserve_min`
// cartes libres pour les retardataires), une carte secrète par joueur, et
// première cible attribuée en cercle (chacun chasse le suivant : un seul
// chasseur par cible, sans paire qui se chasse mutuellement).
export function demarrer(partie, { config, cartesData, rng = Math.random }) {
  const ids = shuffle(Object.keys(partie.joueurs), rng);
  const taille = Math.max(config.taille_grille, ids.length + config.reserve_min);
  const grille = tirerGrille(cartesData, taille, rng);
  partie.grille = grille.map((c) => c.cardKey);
  partie.cartes = Object.fromEntries(grille.map((c) => [c.cardKey, { nom: c.fr, profil: profil(c) }]));
  const pioche = shuffle(partie.grille, rng);
  ids.forEach((id, i) => {
    partie.joueurs[id].carte = pioche[i] ?? null;
    if (ids.length > 1) partie.joueurs[id].cible = ids[(i + 1) % ids.length];
  });
  partie.demarree = true;
  return partie;
}

export function cartesLibres(partie) {
  const prises = new Set(Object.values(partie.joueurs).map((j) => j.carte));
  return partie.grille.filter((k) => !prises.has(k));
}

// Arrivée en cours de partie (jusqu'au jour `inscription_jours`) : une
// carte libre de la grille, cible à choisir.
export function rejoindre(partie, id, username, { rng = Math.random } = {}) {
  if (partie.joueurs[id]) return { joueur: partie.joueurs[id] };
  const libres = cartesLibres(partie);
  if (!libres.length) return { erreur: "complet" };
  const joueur = nouveauJoueur(username, Object.keys(partie.joueurs).length);
  joueur.carte = libres[Math.floor(rng() * libres.length)];
  partie.joueurs[id] = joueur;
  return { joueur };
}

// ── Cibles ──────────────────────────────────────────────────────────

export function chasseurs(partie, cibleId) {
  return Object.entries(partie.joueurs).filter(([, j]) => j.cible === cibleId).map(([id]) => id);
}

// Cibles qu'un joueur peut choisir : au plus `chasseurs_max` chasseurs par
// cible, jamais un joueur qu'il a déjà démasqué (il connaît sa carte),
// triées par prime décroissante (la première est proposée par défaut).
export function ciblesDisponibles(partie, id, { config }) {
  const moi = partie.joueurs[id];
  return Object.entries(partie.joueurs)
    .filter(([cid, j]) => cid !== id && j.carte && !moi.demasques.includes(cid) && chasseurs(partie, cid).length < config.chasseurs_max)
    .sort(([, a], [, b]) => b.prime - a.prime || b.score - a.score || a.arrivee - b.arrivee)
    .map(([cid]) => cid);
}

export function choisirCible(partie, id, cibleId, { config }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.carte) return { erreur: "inconnu" };
  if (moi.cible) return { erreur: "dejaCible" };
  if (!ciblesDisponibles(partie, id, { config }).includes(cibleId)) return { erreur: "cible" };
  moi.cible = cibleId;
  moi.enquete = nouvelleEnquete();
  // Révélations publiques (Projecteur) déjà connues de tous
  for (const [q, valeur] of Object.entries(partie.reveles[cibleId] ?? {})) ajouterInfo(moi.enquete, q, valeur, "projecteur");
  noter(partie, "cible", { s: id, v: cibleId });
  return { cible: cibleId };
}

function ajouterInfo(enquete, q, valeur, source) {
  if (q in enquete.infos) return false;
  enquete.infos[q] = valeur;
  enquete.ordre.push(q);
  enquete.sources[q] = source;
  return true;
}

// ── Enquête ─────────────────────────────────────────────────────────

// Cartes encore possibles pour la cible : compatibles avec les réponses
// connues, hors sa propre carte, les cartes des joueurs déjà démasqués
// (chaque carte n'appartient qu'à un joueur) et les accusations ratées.
export function candidats(partie, id) {
  const moi = partie.joueurs[id];
  if (!moi?.cible) return [];
  const connues = new Set([moi.carte, ...moi.demasques.map((d) => partie.joueurs[d]?.carte)]);
  const { infos, eliminees } = moi.enquete;
  return partie.grille.filter(
    (k) => !connues.has(k) && !eliminees.includes(k) && Object.entries(infos).every(([q, v]) => partie.cartes[k].profil[q] === v),
  );
}

// Questions du jour encore utiles sur la cible ; si les 3 sont déjà
// connues, n'importe quelle autre question (décision du 11/10).
export function questionsPossibles(partie, id, { config }) {
  const moi = partie.joueurs[id];
  if (!moi?.cible) return [];
  const inconnues = (liste) => liste.filter((q) => !(q in moi.enquete.infos));
  const duJour = inconnues(config.pool[String(partie.numeroJour)] ?? QIDS);
  return duJour.length ? duJour : inconnues(QIDS);
}

export function questionsRestantes(j, config) {
  return config.questions_par_jour + (j.bonusQuestions ?? 0) - (j.questionsJour ?? 0);
}

// Premier geste du jour (question ou accusation) : `or_par_jour` Or.
function marquerActif(j, config) {
  if (j.actifJour) return;
  j.actifJour = true;
  j.or += config.or_par_jour;
}

export function poser(partie, id, q, { config }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.cible) return { erreur: "sansCible" };
  if (questionsRestantes(moi, config) < 1) return { erreur: "plafondQuestion" };
  if (!questionsPossibles(partie, id, { config }).includes(q)) return { erreur: "question" };
  const cible = partie.joueurs[moi.cible];
  const valeur = partie.cartes[cible.carte].profil[q];
  ajouterInfo(moi.enquete, q, valeur, "question");
  moi.enquete.posees += 1;
  moi.questionsJour += 1;
  marquerActif(moi, config);
  bilan(partie).questions += 1;
  prive(partie, id, `🔎 ${QUESTIONS[q].nom} de la carte de **${cible.username}** : **${valeur}**.`);
  return { q, valeur };
}

// Une accusation par jour. Juste : gain_base - jour + prime de la cible ;
// la prime de la cible retombe à 0 et celle du chasseur augmente ; le
// chasseur doit choisir une nouvelle cible. Fausse : penalite_erreur.
export function accuser(partie, id, cardKey, { config }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.cible) return { erreur: "sansCible" };
  if (moi.accuseJour) return { erreur: "plafondAccusation" };
  if (!candidats(partie, id).includes(cardKey)) return { erreur: "carte" };
  const cibleId = moi.cible;
  const cible = partie.joueurs[cibleId];
  moi.accuseJour = true;
  marquerActif(moi, config);
  partie.seq = (partie.seq ?? 0) + 1;
  moi.seqScore = partie.seq;
  if (cible.carte !== cardKey) {
    moi.score -= config.penalite_erreur;
    moi.erreurs += 1;
    moi.enquete.eliminees.push(cardKey);
    bilan(partie).erreurs += 1;
    prive(partie, id, `❌ Raté : **${cible.username}** n'a pas la carte ${nomCarte(partie, cardKey)} (-${config.penalite_erreur} pt).`);
    return { correct: false };
  }
  const gain = config.gain_base - partie.numeroJour + cible.prime;
  const prime = cible.prime;
  moi.score += gain;
  moi.prime += config.prime_par_demasquage;
  moi.or += config.or_par_demasquage;
  moi.demasques.push(cibleId);
  moi.cible = null;
  moi.enquete = nouvelleEnquete();
  cible.prime = 0;
  cible.nbDemasque += 1;
  cible.demasqueJour = true;
  bilan(partie).demasquages.push({ s: id, v: cibleId });
  noter(partie, "demasque", { s: id, v: cibleId, gain, prime, crucial: true });
  prive(partie, id, `🎯 Tu as démasqué **${cible.username}** : ${nomCarte(partie, cardKey)} (+${gain} pts).`);
  return { correct: true, gain, prime, cible: cibleId };
}

// ── Objets ──────────────────────────────────────────────────────────

export const OBJETS = {
  projecteur: { nom: "Projecteur", emoji: "🔦", effet: "Révèle à tous une caractéristique de la carte du leader en prime." },
  vol: { nom: "Vol de piste", emoji: "🕵️", effet: "Copie la dernière réponse obtenue par un rival qui chasse ta cible." },
  double: { nom: "Double enquête", emoji: "🔁", effet: "Une 2e question aujourd'hui (une fois par partie)." },
};

// Leader en prime : la plus grosse prime (puis le meilleur score, puis
// l'ordre d'arrivée), parmi les joueurs qui ont une carte.
export function leaderPrime(partie) {
  const [premier] = Object.entries(partie.joueurs)
    .filter(([, j]) => j.carte)
    .sort(([, a], [, b]) => b.prime - a.prime || b.score - a.score || a.arrivee - b.arrivee);
  return premier ? premier[0] : null;
}

// Questions que le Projecteur peut révéler : celles du jour, pas encore
// révélées publiquement sur le leader.
export function questionsProjecteur(partie, { config }) {
  const leader = leaderPrime(partie);
  if (!leader) return [];
  const deja = partie.reveles[leader] ?? {};
  return (config.pool[String(partie.numeroJour)] ?? QIDS).filter((q) => !(q in deja));
}

// Rival dont la piste peut être volée : autre chasseur de ma cible ayant
// obtenu une réponse que je n'ai pas (sa plus récente).
export function pisteAVoler(partie, id) {
  const moi = partie.joueurs[id];
  if (!moi?.cible) return null;
  for (const rid of chasseurs(partie, moi.cible)) {
    if (rid === id) continue;
    const q = [...partie.joueurs[rid].enquete.ordre].reverse().find((x) => !(x in moi.enquete.infos));
    if (q) return { rival: rid, q };
  }
  return null;
}

// Objets disponibles pour le joueur (Or suffisant, plafonds respectés),
// avec la raison du refus sinon.
export function etatObjet(partie, id, objet, { config }) {
  const moi = partie.joueurs[id];
  const cout = config.objets[objet].cout;
  if (moi.objetJour) return { ok: false, raison: "objetJour" };
  if (moi.objets >= config.objets_max) return { ok: false, raison: "objetsMax" };
  if (moi.or < cout) return { ok: false, raison: "or" };
  if (objet === "double" && moi.doubleUtilise) return { ok: false, raison: "doubleUtilise" };
  if (objet === "projecteur") {
    if (leaderPrime(partie) === id) return { ok: false, raison: "leader" };
    if (!questionsProjecteur(partie, { config }).length) return { ok: false, raison: "rienAReveler" };
  }
  if (objet === "vol" && !pisteAVoler(partie, id)) return { ok: false, raison: "pasDePiste" };
  return { ok: true };
}

export function utiliserObjet(partie, id, objet, { config, q = null }) {
  const moi = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!moi?.carte || !config.objets[objet]) return { erreur: "objet" };
  const etat = etatObjet(partie, id, objet, { config });
  if (!etat.ok) return { erreur: etat.raison };
  if (objet === "projecteur" && !questionsProjecteur(partie, { config }).includes(q)) return { erreur: "question" };
  moi.or -= config.objets[objet].cout;
  moi.objets += 1;
  moi.objetJour = true;
  if (objet === "double") {
    moi.doubleUtilise = true;
    moi.bonusQuestions += 1;
    prive(partie, id, "🔁 Double enquête : une 2e question aujourd'hui.");
    return { objet };
  }
  if (objet === "vol") {
    const { rival, q: qv } = pisteAVoler(partie, id);
    const valeur = partie.joueurs[rival].enquete.infos[qv];
    ajouterInfo(moi.enquete, qv, valeur, "vol");
    bilan(partie).vols += 1;
    noter(partie, "vol", { s: id, v: rival, cible: moi.cible });
    prive(partie, id, `🕵️ Piste volée à **${partie.joueurs[rival].username}** : ${QUESTIONS[qv].nom} **${valeur}**.`);
    return { objet, rival, q: qv, valeur };
  }
  // Projecteur : réponse publique, ajoutée à l'enquête de tous les chasseurs du leader
  const leader = leaderPrime(partie);
  const valeur = partie.cartes[partie.joueurs[leader].carte].profil[q];
  partie.reveles[leader] = { ...(partie.reveles[leader] ?? {}), [q]: valeur };
  for (const hid of chasseurs(partie, leader)) ajouterInfo(partie.joueurs[hid].enquete, q, valeur, "projecteur");
  bilan(partie).projecteurs += 1;
  noter(partie, "projecteur", { s: id, v: leader, q, valeur, crucial: true });
  return { objet, leader, q, valeur };
}

// ── Clôture et classement ───────────────────────────────────────────

// Clôture du jour : +prime_par_jour pour chaque joueur non démasqué ce
// jour-là, compteurs quotidiens remis à zéro, jour suivant.
export function cloturer(partie, { config }) {
  for (const j of Object.values(partie.joueurs)) {
    if (j.carte && !j.demasqueJour) j.prime += config.prime_par_jour;
    j.questionsJour = 0;
    j.bonusQuestions = 0;
    j.accuseJour = false;
    j.objetJour = false;
    j.actifJour = false;
    j.demasqueJour = false;
  }
  partie.veille = bilan(partie);
  partie.jour = bilanVide();
  partie.numeroJour = (partie.numeroJour ?? 1) + 1;
}

// Classement : points, puis le moins d'accusations fausses, puis le premier
// à avoir atteint son score final (décision du 11/10), puis l'arrivée.
export function classement(partie) {
  const ordre = Object.entries(partie.joueurs)
    .filter(([, j]) => j.carte)
    .sort(([, a], [, b]) => b.score - a.score || a.erreurs - b.erreurs || (a.seqScore || Infinity) - (b.seqScore || Infinity) || a.arrivee - b.arrivee);
  return ordre.map(([discordId, j], i) => ({
    discordId,
    username: j.username,
    rang: i + 1,
    score: j.score,
    demasques: j.demasques.length,
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
  const prime = e.prime ? ` (prime de ${e.prime})` : "";
  switch (e.k) {
    case "demasque":
      if (parMoi) return `🎯 Tu as démasqué ${V}${prime} !`;
      if (surMoi) return `🎯 ${S} t'a démasqué${prime} !`;
      return `🎯 ${S} a démasqué ${V}${prime} !`;
    case "projecteur": {
      const q = QUESTIONS[e.q]?.nom ?? "?";
      if (surMoi) return `🔦 ${S} braque un Projecteur sur toi : ${q.toLowerCase()} **${e.valeur}**.`;
      return `🔦 ${parMoi ? "Ton" : `${S} braque un`} Projecteur sur ${V} : ${q.toLowerCase()} **${e.valeur}**.`;
    }
    case "vol":
      if (parMoi) return `🕵️ Tu voles la piste de ${V}.`;
      if (surMoi) return `🕵️ ${S} te vole ta piste !`;
      return `🕵️ ${S} vole la piste de ${V}.`;
    case "cible":
      if (parMoi) return `🎯 Ta nouvelle cible : ${V}.`;
      if (surMoi) return `👀 ${S} te prend pour cible !`;
      return `👀 ${S} prend ${V} pour cible.`;
    default:
      return "";
  }
}
