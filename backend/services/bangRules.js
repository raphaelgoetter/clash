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

const JOURNAL_MAX = 40;

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

function noter(partie, texte) {
  partie.journal.push(texte);
  if (partie.journal.length > JOURNAL_MAX) partie.journal.splice(0, partie.journal.length - JOURNAL_MAX);
}

const nom = (j) => `**${j.username}**`;

export function creerPartie() {
  return { pioche: [], joueurs: {}, journal: [], elimines: 0, termine: false };
}

export function vivants(partie) {
  return Object.entries(partie.joueurs).filter(([, j]) => j.vivant);
}

export function nbBombes(partie) {
  return partie.pioche.filter((c) => c === "bombe").length;
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
    elixir: config.elixir.depart,
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
  noter(partie, `🚀 **BANG !** Le Roi de ${nom(j)} a explosé ! ${j.username} quitte l'Arène.`);
  const restants = vivants(partie);
  if (restants.length <= 1) {
    partie.termine = true;
    if (restants.length) noter(partie, `👑 ${nom(restants[0][1])} est le dernier Roi debout !`);
  }
}

// Pioche la carte du sommet. Coûte 1 Élixir ; une pioche due (Gang de
// gobelins) ou automatique (clôture) reste possible sans Élixir.
// Renvoie { erreur } ou { carte, transformee, bang: null | "sauve" | "elimine" }.
export function piocher(partie, id, { auto = false } = {}) {
  const j = partie.joueurs[id];
  if (partie.termine) return { erreur: "termine" };
  if (!j?.vivant) return { erreur: "elimine" };
  if (j.enAttente) return { erreur: "enAttente" };
  if (!partie.pioche.length) return { erreur: "pioche" };
  if (j.elixir < 1 && j.dette < 1 && !auto) return { erreur: "elixir" };
  j.elixir = Math.max(0, j.elixir - 1);
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
    noter(partie, `💥 ${nom(j)} a pioché un Gobelin explosif… sauvé par son Esprit de guérison !`);
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
  return { carte, transformee, bang: null };
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
  return { index };
}

// Effet d'une attaque de `source` sur `victime` (après un éventuel renvoi).
// Renvoie { vole } pour la Voleuse (carte dérobée).
function appliquer(partie, carte, sourceId, victimeId, { config, rng }) {
  const s = partie.joueurs[sourceId];
  const v = partie.joueurs[victimeId];
  if (carte === "gang") {
    v.dette += config.gang_pioches;
    noter(partie, `👊 ${nom(s)} envoie son Gang de gobelins tendre une embuscade à ${nom(v)} ! (${config.gang_pioches} pioches d'affilée)`);
  } else if (carte === "malediction") {
    v.maudit += 1;
    noter(partie, `🧿 ${nom(s)} jette une Malédiction sur ${nom(v)} : sa prochaine carte piochée sera un simple Gobelin !`);
  } else if (carte === "voleuse") {
    if (!v.main.length) {
      noter(partie, `🦹 La Voleuse de ${nom(s)} fouille ${nom(v)}… qui n'a plus rien !`);
      return;
    }
    const [vole] = v.main.splice(Math.floor(rng() * v.main.length), 1);
    s.main.push(vole);
    noter(partie, `🦹 La Voleuse de ${nom(s)} dérobe une carte à ${nom(v)} !`);
    return { vole };
  } else if (carte === "fut") {
    if (v.elixir > 0) {
      v.elixir -= 1;
      s.elixir = Math.min(config.elixir.max, s.elixir + 1);
      noter(partie, `🛢️ ${nom(s)} surgit d'un Fût à gobelins et chipe 1 Élixir à ${nom(v)} !`);
    } else {
      noter(partie, `🛢️ ${nom(s)} surgit d'un Fût à gobelins chez ${nom(v)}… qui n'a plus d'Élixir !`);
    }
  }
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
  const versPioche = carte === "fut" && cible === "pioche";
  if (CIBLEES.includes(carte) && !versPioche && (cible === id || !partie.joueurs[cible]?.vivant)) return { erreur: "cible" };

  j.main.splice(index, 1);

  if (carte === "sarbacane") {
    noter(partie, `🎯 ${nom(j)} scrute la pioche avec son Gobelin à sarbacane…`);
    return { carte, revelation: partie.pioche.slice(0, 3) };
  }
  if (carte === "moine") {
    // Secret : personne ne sait qui est protégé
    j.moine = true;
    return { carte };
  }
  if (carte === "fut") {
    // Esquive : annule une pioche due, sinon remplit la pioche du jour
    if (j.dette > 0) j.dette -= 1;
    else j.tourFait = true;
    if (versPioche) {
      j.elixir = Math.min(config.elixir.max, j.elixir + 1);
      noter(partie, `🛢️ ${nom(j)} se cache dans un Fût à gobelins et récupère 1 Élixir.`);
      return { carte };
    }
  }

  // Attaque : le Moine de la cible la renvoie à l'envoyeur (une fois)
  const victime = partie.joueurs[cible];
  if (victime.moine) {
    victime.moine = false;
    noter(partie, `🙏 Le Moine de ${nom(victime)} renvoie l'attaque (${CARTES[carte].nom}) de ${nom(j)} à l'envoyeur !`);
    const effet = appliquer(partie, carte, cible, id, { config, rng });
    return { carte, renvoi: true, vole: effet?.vole ?? null };
  }
  const effet = appliquer(partie, carte, id, cible, { config, rng });
  return { carte, renvoi: false, vole: effet?.vole ?? null };
}

// Clôture du jour, dans un ordre aléatoire : les Gobelins explosifs encore
// en main sont cachés au hasard, puis chaque survivant qui n'a pas pioché
// (ni esquivé) pioche automatiquement, ainsi que ses pioches dues. Les
// Moines non utilisés s'en vont. Chacun reçoit ensuite son Élixir du jour (sauf au dernier jour : les survivants
// sont classés sur l'Élixir qu'il leur reste).
export function cloturer(partie, { config, rng = Math.random, dernier = false }) {
  const automatiques = [];
  for (const [id] of shuffle(vivants(partie), rng)) {
    const j = partie.joueurs[id];
    if (j.enAttente) placer(partie, id, "hasard", { rng });
    const nb = Math.max(j.dette, j.tourFait ? 0 : 1);
    if (nb > 0 && !partie.termine) automatiques.push(j.username);
    for (let k = 0; k < nb && j.vivant && !partie.termine; k++) {
      const r = piocher(partie, id, { auto: true });
      if (r.erreur) break;
      if (r.bang === "sauve") placer(partie, id, "hasard", { rng });
    }
  }
  if (automatiques.length) {
    noter(partie, `⏰ Pioche automatique à la clôture : ${automatiques.map((n) => `**${n}**`).join(", ")}.`);
  }
  for (const [, j] of vivants(partie)) {
    j.tourFait = false;
    j.dette = 0;
    j.moine = false;
    if (!dernier) j.elixir = Math.min(config.elixir.max, j.elixir + config.elixir.par_jour);
  }
  return { automatiques };
}

// Classement : survivants d'abord (Élixir restant, puis Esprits de
// guérison en main, nombre de cartes, ordre d'arrivée), puis éliminés du
// dernier au premier. Score = nombre de joueurs classés derrière.
export function classement(partie) {
  const entries = Object.entries(partie.joueurs);
  const esprits = (j) => j.main.filter((c) => c === "esprit").length;
  const survivants = entries
    .filter(([, j]) => j.vivant)
    .sort(([, a], [, b]) => b.elixir - a.elixir || esprits(b) - esprits(a) || b.main.length - a.main.length || a.arrivee - b.arrivee);
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
