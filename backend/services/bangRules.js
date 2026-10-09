// ============================================================
// bangRules.js — Règles pures de Bang! (jeu spécial inspiré d'Exploding
// Kittens) : pioche commune, Gobelins explosifs, cartes d'action, clôture
// quotidienne et classement. Aucune I/O : la couche Redis (bang.js) lit la
// partie, appelle ces fonctions sous verrou puis réécrit la partie.
//
// Toutes les fonctions modifient la partie reçue en place (la couche Redis
// travaille sur une copie fraîchement désérialisée) ; `rng` injectable pour
// les tests et la simulation.
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Bang!), source de vérité.
// ============================================================

// Cartes du jeu : nom affiché, carte Clash Royale illustrée (cardKey de
// data/cardNames.json) et emoji.
export const CARTES = {
  bombe: { nom: "Gobelin explosif", cardKey: "Goblin Demolisher", emoji: "💥" },
  esprit: { nom: "Esprit de guérison", cardKey: "Heal Spirit", emoji: "💚" },
  moine: { nom: "Moine", cardKey: "Monk", emoji: "🙏" },
  fut: { nom: "Fût à gobelins", cardKey: "Goblin Barrel", emoji: "🛢️" },
  malediction: { nom: "Malédiction", cardKey: "Goblin Curse", emoji: "🧿" },
  gang: { nom: "Gang de gobelins", cardKey: "Goblin Gang", emoji: "👊" },
  sarbacane: { nom: "Gobelin à sarbacane", cardKey: "Dart Goblin", emoji: "🎯" },
  voleuse: { nom: "Voleuse", cardKey: "Bandit", emoji: "🦹" },
  gobelin: { nom: "Gobelin", cardKey: "Goblins", emoji: "👺" },
  // Duel uniquement (bangDuelRules.js)
  tornade: { nom: "Tornade", cardKey: "Tornado", emoji: "🌪️" },
};

// Cartes jouables depuis la main, et celles qui visent un adversaire
// (le Fût peut aussi viser la pioche).
export const JOUABLES = ["sarbacane", "moine", "fut", "gang", "malediction", "voleuse"];
export const CIBLEES = ["fut", "gang", "malediction", "voleuse"];

// Emplacements proposés pour cacher le Gobelin explosif désamorcé.
export const POSITIONS = {
  1: "Tout en haut",
  2: "En 2e position",
  3: "En 3e position",
  milieu: "Au milieu",
  fond: "Tout au fond",
  hasard: "Au hasard",
};

const JOURNAL_MAX = 1000;

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function insererAuHasard(pioche, carte, rng) {
  pioche.splice(Math.floor(rng() * (pioche.length + 1)), 0, carte);
}

// Journal de la partie : { j: jour, k: type, s: auteur, v: cible, c:
// crucial, ids: joueurs concernés, … } pour les événements publics, rédigés
// à l'affichage par texteJournal() ; { j, t: texte, p: joueur } pour les
// notes privées (pioches, Sarbacane, Moine…). Les entrées cruciales
// (explosions, fin de partie) sont les seules affichées sur le message
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

const nom = (j) => `**${j.username}**`;

// Texte d'une entrée du journal pour le joueur `moi` (deuxième personne
// quand l'action le concerne), ou pour tous (`moi` = null, message officiel).
// Les notes privées ({ t }) sont déjà rédigées.
export function texteJournal(partie, e, moi = null) {
  if (e.t) return e.t;
  const n = (id) => `**${partie.joueurs[id]?.username ?? "?"}**`;
  const S = n(e.s);
  const V = n(e.v);
  const parMoi = moi != null && e.s === moi;
  const surMoi = moi != null && e.v === moi;
  switch (e.k) {
    case "explose":
      return parMoi ? "🚀 **BANG !** Tu as explosé et quittes l'Arène !" : `🚀 **BANG !** ${S} a explosé et quitte l'Arène !`;
    case "dernier":
      return parMoi ? "👑 Tu es le dernier joueur en vie !" : `👑 ${S} est le dernier joueur en vie !`;
    case "sauve":
      return parMoi
        ? "💥 Tu as pioché un Gobelin explosif… sauvé par ton Esprit de guérison !"
        : `💥 ${S} a pioché un Gobelin explosif… sauvé par son Esprit de guérison !`;
    case "gang":
      if (parMoi) return `👊 Ton Gang de gobelins tend une embuscade à ${V} ! (${e.n} cartes à piocher d'un coup)`;
      if (surMoi) return `👊 Le Gang de gobelins de ${S} te tend une embuscade ! (${e.n} cartes à piocher d'un coup)`;
      return `👊 ${S} envoie son Gang de gobelins tendre une embuscade à ${V} ! (${e.n} cartes à piocher d'un coup)`;
    case "malediction":
      if (parMoi) return `🧿 Tu jettes une Malédiction sur ${V} : sa prochaine carte piochée sera un simple Gobelin !`;
      if (surMoi) return `🧿 ${S} te jette une Malédiction : ta prochaine carte piochée sera un simple Gobelin !`;
      return `🧿 ${S} jette une Malédiction sur ${V} : sa prochaine carte piochée sera un simple Gobelin !`;
    case "voleuseVide":
      if (parMoi) return `🦹 Ta Voleuse fouille ${V}… qui n'a plus rien !`;
      if (surMoi) return `🦹 La Voleuse de ${S} te fouille… mais tu n'as plus rien !`;
      return `🦹 La Voleuse de ${S} fouille ${V}… qui n'a plus rien !`;
    case "voleuse":
      if (parMoi) return `🦹 Ta Voleuse dérobe une carte à ${V} !`;
      if (surMoi) return `🦹 La Voleuse de ${S} te dérobe une carte !`;
      return `🦹 La Voleuse de ${S} dérobe une carte à ${V} !`;
    case "futVol":
      if (parMoi) return `🛢️ Tu surgis d'un Fût à gobelins et chipes 1 Bravoure à ${V} !`;
      if (surMoi) return `🛢️ ${S} surgit d'un Fût à gobelins et te chipe 1 Bravoure !`;
      return `🛢️ ${S} surgit d'un Fût à gobelins et chipe 1 Bravoure à ${V} !`;
    case "futVide":
      if (parMoi) return `🛢️ Tu surgis d'un Fût à gobelins chez ${V}… qui n'a aucune Bravoure !`;
      if (surMoi) return `🛢️ ${S} surgit d'un Fût à gobelins chez toi… mais tu n'as aucune Bravoure !`;
      return `🛢️ ${S} surgit d'un Fût à gobelins chez ${V}… qui n'a aucune Bravoure !`;
    case "futBanque":
      return parMoi ? "🛢️ Tu te caches dans un Fût à gobelins et esquives la pioche." : `🛢️ ${S} se cache dans un Fût à gobelins et esquive la pioche.`;
    case "sarbacane":
      return parMoi ? "🎯 Tu scrutes la pioche avec ton Gobelin à sarbacane…" : `🎯 ${S} scrute la pioche avec son Gobelin à sarbacane…`;
    case "renvoi": {
      const carte = CARTES[e.carte]?.nom ?? "?";
      if (parMoi) return `🙏 Ton Moine renvoie l'attaque (${carte}) de ${V} à l'envoyeur !`;
      if (surMoi) return `🙏 Le Moine de ${S} renvoie ton attaque (${carte}) contre toi !`;
      return `🙏 Le Moine de ${S} renvoie l'attaque (${carte}) de ${V} à l'envoyeur !`;
    }
    case "auto":
      if (moi != null && e.ids.includes(moi)) return "⏰ Tu n'avais pas pioché : pioche automatique à la clôture.";
      return `⏰ Pioche automatique à la clôture : ${e.ids.map(n).join(", ")}.`;
    default:
      return "";
  }
}

// Bilan du jour en cours (`jour`), archivé dans `veille` à la clôture pour
// le message du lendemain.
function bilanVide() {
  return { explosions: [], sauves: [], attaques: 0, renvois: 0, automatiques: [] };
}

function bilan(partie) {
  partie.jour ??= bilanVide();
  return partie.jour;
}

export function creerPartie() {
  return { pioche: [], joueurs: {}, journal: [], numeroJour: 1, elimines: 0, termine: false, jour: bilanVide(), veille: null };
}

export function vivants(partie) {
  return Object.entries(partie.joueurs).filter(([, j]) => j.vivant);
}

export function nbBombes(partie) {
  return partie.pioche.filter((c) => c === "bombe").length;
}

export function nbEsprits(partie) {
  return partie.pioche.filter((c) => c === "esprit").length;
}

// Nombre d'exemplaires qu'apporte le n-ième joueur (1-based) pour un taux
// par joueur éventuellement fractionnaire (0,5 = un exemplaire tous les
// deux joueurs).
function apport(n, taux) {
  return Math.floor(n * taux) - Math.floor((n - 1) * taux);
}

// Arrivée d'un joueur : il reçoit un Esprit de guérison et `main_depart`
// cartes de son paquet ; le reste du paquet est mélangé dans la pioche,
// avec un Gobelin explosif par joueur à partir du deuxième.
export function ajouterJoueur(partie, id, username, { config, rng = Math.random }) {
  if (partie.joueurs[id]) return partie.joueurs[id];
  const n = Object.keys(partie.joueurs).length + 1;
  const paquet = [];
  for (const [carte, taux] of Object.entries(config.paquet_par_joueur)) {
    for (let k = 0; k < apport(n, taux); k++) paquet.push(carte);
  }
  const melange = shuffle(paquet.filter((c) => c !== "esprit"), rng);
  const main = ["esprit", ...melange.splice(0, config.main_depart)];
  const reste = [...melange, ...paquet.filter((c) => c === "esprit")];
  if (n >= 2) for (let k = 0; k < apport(n - 1, config.bombes_par_joueur); k++) reste.push("bombe");
  for (const carte of reste) insererAuHasard(partie.pioche, carte, rng);
  const joueur = {
    username: username || "?",
    main,
    bravoure: 0,
    pioches: 0,
    vivant: true,
    moine: false,
    maudit: 0,
    dette: 0,
    tourFait: false,
    enAttente: false,
    arrivee: n - 1,
    rangElimination: null,
  };
  partie.joueurs[id] = joueur;
  return joueur;
}

function eliminer(partie, id) {
  const j = partie.joueurs[id];
  j.vivant = false;
  j.main = [];
  j.moine = false;
  j.enAttente = false;
  partie.elimines += 1;
  j.rangElimination = partie.elimines;
  noter(partie, "explose", { s: id, crucial: true });
  bilan(partie).explosions.push(j.username);
  const restants = vivants(partie);
  if (restants.length <= 1) {
    partie.termine = true;
    if (restants.length) noter(partie, "dernier", { s: restants[0][0], crucial: true });
  }
}

// Pioche la carte du sommet. Gratuite ; une pioche volontaire (ni due
// par un Gang de gobelins, ni automatique) rapporte de la Bravoure, dans la
// limite de `pioches_par_jour` par jour.
// Renvoie { erreur } ou { carte, transformee, bang: null | "sauve" | "elimine" }.
export function piocher(partie, id, { config, auto = false }) {
  const j = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!j?.vivant) return { erreur: "elimine" };
  if (j.enAttente) return { erreur: "enAttente" };
  if (!partie.pioche.length) return { erreur: "pioche" };
  const volontaire = !auto && j.dette < 1;
  if (volontaire && (j.pioches ?? 0) >= config.pioches_par_jour) return { erreur: "plafondPioche" };
  if (volontaire) {
    j.pioches = (j.pioches ?? 0) + 1;
    j.bravoure = (j.bravoure ?? 0) + config.bravoure.pioche;
  }
  if (j.dette > 0) j.dette -= 1;
  j.tourFait = true;
  let carte = partie.pioche.shift();
  if (carte === "bombe") {
    const esprit = j.main.indexOf("esprit");
    if (esprit === -1) {
      eliminer(partie, id);
      return { carte, transformee: false, bang: "elimine" };
    }
    j.main.splice(esprit, 1);
    j.enAttente = true;
    noter(partie, "sauve", { s: id });
    bilan(partie).sauves.push(j.username);
    return { carte, transformee: false, bang: "sauve" };
  }
  // Malédiction : la carte piochée devient un simple Gobelin
  let transformee = false;
  if (j.maudit > 0 && carte !== "gobelin") {
    j.maudit -= 1;
    transformee = carte;
    carte = "gobelin";
  }
  j.main.push(carte);
  prive(
    partie,
    id,
    `${auto ? "⏰ Pioche automatique" : "🃏 Tu as pioché"} : ${transformee ? `${CARTES[transformee].nom}, changée en Gobelin par une Malédiction` : CARTES[carte].nom}.`,
  );
  return { carte, transformee, bang: null };
}

// Clic sur Piocher : une carte, ou toutes les pioches dues d'un coup
// (Gang de gobelins), en s'arrêtant sur un Gobelin explosif.
// Renvoie { erreur } ou { tirages: [résultats de piocher()] }.
export function piocherClic(partie, id, { config }) {
  const j = partie.joueurs[id];
  const nb = Math.max(1, j?.dette ?? 0);
  const tirages = [];
  for (let k = 0; k < nb; k++) {
    const r = piocher(partie, id, { config });
    if (r.erreur) {
      if (!tirages.length) return { erreur: r.erreur };
      break;
    }
    tirages.push(r);
    if (r.bang) break;
  }
  return { tirages };
}

// Cache le Gobelin explosif désamorcé dans la pioche.
export function placer(partie, id, position, { rng = Math.random } = {}) {
  const j = partie.joueurs[id];
  if (!j?.enAttente) return { erreur: "pasEnAttente" };
  if (!(position in POSITIONS)) return { erreur: "position" };
  const len = partie.pioche.length;
  const index =
    position === "milieu" ? Math.floor(len / 2)
      : position === "fond" ? len
        : position === "hasard" ? Math.floor(rng() * (len + 1))
          : Math.min(Number(position) - 1, len);
  partie.pioche.splice(index, 0, "bombe");
  j.enAttente = false;
  prive(partie, id, `🤫 Tu as caché le Gobelin explosif : ${POSITIONS[position].toLowerCase()}${position === "hasard" ? "" : ` (position ${index + 1})`}.`);
  return { index };
}

// Effet d'une attaque de `source` sur `victime` (après un éventuel renvoi).
// Renvoie { vole } pour la Voleuse (carte dérobée).
function appliquer(partie, carte, sourceId, victimeId, { config, rng }) {
  const s = partie.joueurs[sourceId];
  const v = partie.joueurs[victimeId];
  if (carte === "gang") {
    v.dette += config.gang_pioches;
    noter(partie, "gang", { s: sourceId, v: victimeId, n: config.gang_pioches });
  } else if (carte === "malediction") {
    v.maudit += 1;
    noter(partie, "malediction", { s: sourceId, v: victimeId });
  } else if (carte === "voleuse") {
    if (!v.main.length) {
      noter(partie, "voleuseVide", { s: sourceId, v: victimeId });
      return;
    }
    const [vole] = v.main.splice(Math.floor(rng() * v.main.length), 1);
    s.main.push(vole);
    noter(partie, "voleuse", { s: sourceId, v: victimeId });
    prive(partie, sourceId, `🦹 Carte dérobée à ${nom(v)} : ${CARTES[vole].nom}.`);
    prive(partie, victimeId, `🦹 ${nom(s)} t'a volé : ${CARTES[vole].nom}.`);
    s.bravoure = (s.bravoure ?? 0) + config.bravoure.attaque;
    return { vole };
  } else if (carte === "fut") {
    // Le Fût vole 1 Bravoure au lieu d'en rapporter
    if ((v.bravoure ?? 0) > 0) {
      v.bravoure -= 1;
      s.bravoure = (s.bravoure ?? 0) + 1;
      noter(partie, "futVol", { s: sourceId, v: victimeId });
    } else {
      noter(partie, "futVide", { s: sourceId, v: victimeId });
    }
    return;
  }
  // Attaque aboutie : Bravoure pour qui l'inflige (le joueur protégé par
  // son Moine, en cas de renvoi)
  s.bravoure = (s.bravoure ?? 0) + config.bravoure.attaque;
}

// Joue une carte de la main. `cible` : discordId d'un adversaire vivant,
// ou "pioche" pour le Fût à gobelins.
// Renvoie { erreur } ou { carte, revelation?, renvoi?, vole? }.
export function jouer(partie, id, carte, cible, { config, rng = Math.random }) {
  const j = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!j?.vivant) return { erreur: "elimine" };
  if (j.enAttente) return { erreur: "enAttente" };
  if (!JOUABLES.includes(carte)) return { erreur: "injouable" };
  const index = j.main.indexOf(carte);
  if (index === -1) return { erreur: "pasEnMain" };
  if (carte === "moine" && j.moine) return { erreur: "moineActif" };
  if ((j.jouees ?? 0) >= config.cartes_par_jour) return { erreur: "plafond" };
  const versPioche = carte === "fut" && cible === "pioche";
  if (CIBLEES.includes(carte) && !versPioche && (cible === id || !partie.joueurs[cible]?.vivant)) return { erreur: "cible" };

  j.main.splice(index, 1);
  j.jouees = (j.jouees ?? 0) + 1;

  if (carte === "sarbacane") {
    noter(partie, "sarbacane", { s: id });
    const revelation = partie.pioche.slice(0, 3);
    prive(partie, id, `🎯 Sommet de la pioche : ${revelation.map((c, i) => `${i + 1}. ${CARTES[c].nom}`).join(", ") || "pioche vide"}.`);
    return { carte, revelation };
  }
  if (carte === "moine") {
    // Secret : personne ne sait qui est protégé
    j.moine = true;
    prive(partie, id, "🙏 Tu as joué ton Moine (protection jusqu'à la clôture).");
    return { carte };
  }
  if (carte === "fut") {
    // Esquive : annule une pioche due, sinon remplit la pioche du jour
    if (j.dette > 0) j.dette -= 1;
    else j.tourFait = true;
    if (versPioche) {
      noter(partie, "futBanque", { s: id });
      return { carte };
    }
  }

  // Attaque : le Moine de la cible la renvoie à l'envoyeur (une fois)
  const victime = partie.joueurs[cible];
  bilan(partie).attaques += 1;
  if (victime.moine) {
    victime.moine = false;
    bilan(partie).renvois += 1;
    noter(partie, "renvoi", { s: cible, v: id, carte });
    const effet = appliquer(partie, carte, cible, id, { config, rng });
    return { carte, renvoi: true, vole: effet?.vole ?? null };
  }
  const effet = appliquer(partie, carte, id, cible, { config, rng });
  return { carte, renvoi: false, vole: effet?.vole ?? null };
}

// Clôture du jour, dans un ordre aléatoire : les Gobelins explosifs encore
// en main sont cachés au hasard, puis chaque survivant qui n'a pas pioché
// (ni esquivé) pioche automatiquement `pioches_auto` cartes (pénalité de
// passivité, sans Bravoure), ou ses pioches dues si elles sont plus
// nombreuses. Les Moines non utilisés s'en vont.
export function cloturer(partie, { config, rng = Math.random }) {
  const automatiques = [];
  const idsAuto = [];
  for (const [id] of shuffle(vivants(partie), rng)) {
    const j = partie.joueurs[id];
    if (j.enAttente) placer(partie, id, "hasard", { rng });
    const nb = Math.max(j.dette, j.tourFait ? 0 : config.pioches_auto);
    if (nb > 0 && !partie.termine) {
      automatiques.push(j.username);
      idsAuto.push(id);
    }
    for (let k = 0; k < nb && j.vivant && !partie.termine; k++) {
      const r = piocher(partie, id, { config, auto: true });
      if (r.erreur) break;
      if (r.bang === "sauve") placer(partie, id, "hasard", { rng });
    }
  }
  if (automatiques.length) {
    noter(partie, "auto", { ids: idsAuto });
  }
  partie.veille = { ...bilan(partie), automatiques };
  partie.jour = bilanVide();
  partie.numeroJour = (partie.numeroJour ?? 1) + 1;
  for (const [, j] of vivants(partie)) {
    j.tourFait = false;
    j.dette = 0;
    j.moine = false;
    j.jouees = 0;
    j.pioches = 0;
  }
  return { automatiques };
}

// Classement : survivants d'abord (Bravoure, puis Esprits de
// guérison en main, nombre de cartes, ordre d'arrivée), puis éliminés du
// dernier au premier. Score = nombre de joueurs classés derrière.
export function classement(partie) {
  const entries = Object.entries(partie.joueurs);
  const esprits = (j) => j.main.filter((c) => c === "esprit").length;
  const survivants = entries
    .filter(([, j]) => j.vivant)
    .sort(([, a], [, b]) => (b.bravoure ?? 0) - (a.bravoure ?? 0) || esprits(b) - esprits(a) || b.main.length - a.main.length || a.arrivee - b.arrivee);
  const elimines = entries.filter(([, j]) => !j.vivant).sort(([, a], [, b]) => b.rangElimination - a.rangElimination);
  const ordre = [...survivants, ...elimines];
  return ordre.map(([discordId, j], i) => ({
    discordId,
    username: j.username,
    rang: i + 1,
    score: ordre.length - 1 - i,
    vivant: j.vivant,
  }));
}
