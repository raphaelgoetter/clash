// ============================================================
// bangDuelRules.js — Règles pures de Bang! Duel (`/bang`) : un joueur
// contre le Bot, à tour de rôle sur une pioche commune, adaptation
// d'Exploding Kittens Duel : cartes jouées d'abord, puis la pioche
// (une seule, ou les pioches dues d'un Gang) termine le tour.
// Aucune I/O : la couche Redis (bangDuel.js) lit le duel, appelle ces
// fonctions sous verrou puis le réécrit. `rng` injectable (tests,
// simulation).
//
// Joueurs : "joueur" (l'humain, commence toujours) et "bot". Un tour de
// jeu = le tour du joueur puis celui du Bot ; `tours_max` tours au plus,
// match nul si personne n'a explosé.
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Bang! Duel), source de vérité.
// ============================================================

import { CARTES, POSITIONS } from "./bangRules.js";

export const IDS = ["joueur", "bot"];
export const JOUABLES_DUEL = ["sarbacane", "moine", "fut", "gang", "voleuse", "tornade"];

export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function joueurVide(main) {
  // jouees : cartes jouées ce tour ; dette : pioches restantes du tour (1,
  // ou `gang_pioches` après un Gang) ; enAttente :
  // Gobelin explosif désamorcé à cacher
  return { main, moine: false, dette: 0, jouees: 0, enAttente: false };
}

// Paquet fixe (`config.paquet`) mélangé : `main_depart` cartes à chacun en
// plus d'un Esprit de guérison, le reste dans la pioche avec
// `esprits_pioche` Esprits et `bombes` Gobelins explosifs.
export function creerDuel(config, { rng = Math.random } = {}) {
  const paquet = shuffle(
    Object.entries(config.paquet).flatMap(([carte, n]) => Array(n).fill(carte)),
    rng,
  );
  const joueurs = {};
  for (const id of IDS) joueurs[id] = joueurVide(["esprit", ...paquet.splice(0, config.main_depart)]);
  const pioche = shuffle(
    [...paquet, ...Array(config.esprits_pioche).fill("esprit"), ...Array(config.bombes).fill("bombe")],
    rng,
  );
  joueurs.joueur.dette = 1;
  return { tour: 1, actif: "joueur", pioche, joueurs, termine: false, gagnant: null, journal: [], soupcon: { joueur: false, bot: false } };
}

// Journal du duel : { tour, id, k, … } (rédigé à l'affichage ; la carte
// piochée, la position d'un Gobelin explosif caché et le Moine restent
// secrets pour l'adversaire)
function noter(d, id, k, donnees = {}) {
  d.journal.push({ tour: d.tour, id, k, ...donnees });
  if (d.journal.length > 1000) d.journal.splice(0, d.journal.length - 1000);
}

function verifierActif(d, id) {
  if (d.termine) return "termine";
  if (d.actif !== id) return "pasTonTour";
  const j = d.joueurs[id];
  if (j.enAttente) return "enAttente";
  return null;
}

// Une pioche consommée (carte piochée ou Fût) : le tour se termine quand
// il n'en reste plus, sauf Gobelin explosif à cacher (fin après placer()).
function consommerPioche(d, id, { config }) {
  const j = d.joueurs[id];
  j.dette = Math.max(0, j.dette - 1);
  if (!j.dette && !j.enAttente && !d.termine) finirTour(d, id, { config });
  return !j.dette;
}

// Pioche la carte du sommet. La pioche termine le tour (après les
// éventuelles pioches dues d'un Gang).
// Renvoie { erreur } ou { carte, bang: null | "sauve" | "elimine", finTour }.
export function piocher(d, id, { config }) {
  const erreur = verifierActif(d, id);
  if (erreur) return { erreur };
  const j = d.joueurs[id];
  if (!d.pioche.length) {
    // Pioche vide : plus rien à piocher, le tour passe
    finirTour(d, id, { config });
    return { erreur: "pioche", finTour: true };
  }
  const carte = d.pioche.shift();
  d.soupcon[id] = false;
  if (carte !== "bombe") {
    j.main.push(carte);
    noter(d, id, "pioche", { carte });
    return { carte, bang: null, finTour: consommerPioche(d, id, { config }) };
  }
  const esprit = j.main.indexOf("esprit");
  if (esprit === -1) {
    d.termine = true;
    d.gagnant = adversaire(id);
    noter(d, id, "explose");
    return { carte, bang: "elimine" };
  }
  j.main.splice(esprit, 1);
  j.enAttente = true;
  noter(d, id, "sauve");
  consommerPioche(d, id, { config });
  return { carte, bang: "sauve", finTour: false };
}

// Clic sur Piocher : une carte, ou toutes les pioches dues d'un coup
// (Gang de gobelins), en s'arrêtant sur un Gobelin explosif.
// Renvoie { erreur } ou { tirages: [résultats de piocher()], vide? }.
export function piocherClic(d, id, { config }) {
  const tirages = [];
  for (;;) {
    const r = piocher(d, id, { config });
    // Pioche vide : le tour est passé sans carte
    if (r.erreur) return r.finTour ? { tirages, vide: true } : tirages.length ? { tirages } : r;
    tirages.push(r);
    if (r.bang || r.finTour) return { tirages };
  }
}

// Cache le Gobelin explosif désamorcé (positions de Bang!). L'adversaire
// sait qu'il est dans la pioche, pas où (`soupcon`, utilisé par le Bot).
// `eviterSommet` (Bot avec une pioche due restante) : « au hasard » exclut
// le sommet, qu'il repiocherait aussitôt.
export function placer(d, id, position, { config, rng = Math.random, eviterSommet = false } = {}) {
  const j = d.joueurs[id];
  if (!j?.enAttente) return { erreur: "pasEnAttente" };
  if (!(position in POSITIONS)) return { erreur: "position" };
  const len = d.pioche.length;
  const min = eviterSommet && len ? 1 : 0; // premier emplacement autorisé
  const index =
    position === "milieu" ? Math.floor(len / 2)
      : position === "fond" ? len
        : position === "hasard" ? min + Math.floor(rng() * (len + 1 - min))
          : Math.min(Number(position) - 1, len);
  d.pioche.splice(index, 0, "bombe");
  j.enAttente = false;
  d.soupcon[adversaire(id)] = true;
  noter(d, id, "cache", { position });
  // Dernière pioche du tour : la main passe
  const finTour = !j.dette;
  if (finTour) finirTour(d, id, { config });
  return { index, finTour };
}

// Fin du tour (pioche faite, Fût ou Gang) : passe la main ; tour suivant
// après le Bot, match nul après le dernier tour.
export function finirTour(d, id, { config }) {
  if (d.termine || d.actif !== id) return { erreur: d.termine ? "termine" : "pasTonTour" };
  Object.assign(d.joueurs[id], { dette: 0, jouees: 0 });
  // Une pioche au moins pour le suivant (davantage s'il subit un Gang)
  const adv = d.joueurs[adversaire(id)];
  adv.dette = Math.max(adv.dette, 1);
  d.actif = adversaire(id);
  if (id === "bot") {
    d.tour += 1;
    if (d.tour > config.tours_max) {
      d.termine = true;
      d.gagnant = null;
      d.tour = config.tours_max;
    }
  }
  return {};
}

// Joue une carte de la main (`cartes_par_tour` au plus).
// Renvoie { erreur } ou { carte, revelation?, renvoi?, vole?, finTour? }.
export function jouer(d, id, carte, { config, rng = Math.random }) {
  const erreur = verifierActif(d, id);
  if (erreur) return { erreur };
  const j = d.joueurs[id];
  if (!JOUABLES_DUEL.includes(carte)) return { erreur: "injouable" };
  const index = j.main.indexOf(carte);
  if (index === -1) return { erreur: "pasEnMain" };
  if (carte === "moine" && j.moine) return { erreur: "moineActif" };
  if (j.jouees >= config.cartes_par_tour) return { erreur: "plafond" };
  j.main.splice(index, 1);
  j.jouees += 1;
  const adv = d.joueurs[adversaire(id)];

  if (carte === "sarbacane") {
    noter(d, id, "sarbacane");
    return { carte, revelation: d.pioche.slice(0, 3) };
  }
  if (carte === "moine") {
    // Secret : absent du journal, actif jusqu'à la prochaine attaque reçue
    j.moine = true;
    return { carte };
  }
  if (carte === "tornade") {
    d.pioche = shuffle(d.pioche, rng);
    d.soupcon[id] = false;
    d.soupcon[adversaire(id)] = false;
    noter(d, id, "tornade");
    return { carte };
  }
  if (carte === "fut") {
    // Esquive une pioche : la seule du tour, ou une des pioches dues
    noter(d, id, "fut");
    return { carte, finTour: consommerPioche(d, id, { config }) };
  }
  // Attaques : le Moine de l'adversaire les renvoie (une fois)
  if (adv.moine) {
    adv.moine = false;
    if (carte === "gang") {
      noter(d, adversaire(id), "renvoi", { carte });
      // Le Gang revient : c'est l'attaquant qui doit piocher, son tour continue
      j.dette = config.gang_pioches;
      return { carte, renvoi: true };
    }
    // Voleuse renvoyée : une carte au hasard de l'attaquant
    const vole = j.main.length ? j.main.splice(Math.floor(rng() * j.main.length), 1)[0] : null;
    if (vole) adv.main.push(vole);
    noter(d, adversaire(id), "renvoi", { carte, vole });
    return { carte, renvoi: true, vole };
  }
  if (carte === "gang") {
    // Termine le tour sans piocher ; l'adversaire devra piocher 2 fois
    // (sans cumul)
    adv.dette = config.gang_pioches;
    noter(d, id, "gang", { n: config.gang_pioches });
    finirTour(d, id, { config });
    return { carte, finTour: true };
  }
  // Voleuse : une carte AU HASARD de la main adverse (décision du 10/10 :
  // choisir revenait à prendre l'Esprit de guérison, trop fort)
  if (!adv.main.length) {
    noter(d, id, "voleuseVide");
    return { carte, vole: null };
  }
  const vole = adv.main.splice(Math.floor(rng() * adv.main.length), 1)[0];
  j.main.push(vole);
  noter(d, id, "voleuse", { carte: vole });
  return { carte, vole };
}

// ── Bot (stratège) ───────────────────────────────────────────────────
// Joue le tour complet de `id` : Moine d'avance, Voleuse (carte au hasard), Sarbacane avant de piocher, esquive (Gang, Tornade, Fût) si un
// Gobelin explosif est connu ou soupçonné en haut, Gobelin explosif
// désamorcé caché en haut une fois sur deux (sinon au hasard, pour
// bluffer). Les actions sont notées au journal.

export function jouerBot(d, id, { config, rng = Math.random }) {
  const j = d.joueurs[id];
  const adv = d.joueurs[adversaire(id)];
  const a = (carte) => j.main.includes(carte) && j.jouees < config.cartes_par_tour;
  let connu = null; // sommet de la pioche vu à la Sarbacane

  if (a("moine") && !j.moine) jouer(d, id, "moine", { config, rng });
  if (a("voleuse") && adv.main.length) jouer(d, id, "voleuse", { config, rng });

  // Pioche (ou pioches dues d'un Gang) jusqu'à la fin du tour, sauf
  // esquive si un Gobelin explosif est vu ou soupçonné au sommet
  for (let garde = 0; garde < 20 && !d.termine && d.actif === id; garde++) {
    if (!connu && a("sarbacane")) connu = jouer(d, id, "sarbacane", { config, rng }).revelation;
    const danger = connu ? connu[0] === "bombe" : d.soupcon[id];
    if (danger) {
      if (a("gang")) {
        jouer(d, id, "gang", { config, rng });
        connu = null;
        continue;
      }
      if (a("tornade")) {
        jouer(d, id, "tornade", { config, rng });
        connu = null;
        continue;
      }
      if (a("fut")) {
        jouer(d, id, "fut", { config, rng });
        continue;
      }
    }
    const r = piocher(d, id, { config });
    if (r.erreur) break;
    connu = connu ? connu.slice(1) : null;
    if (r.bang === "elimine") return;
    if (r.bang === "sauve") {
      // Pioche due restante (Gang) : jamais au sommet, il la piocherait aussitôt
      placer(d, id, !j.dette && rng() < 0.5 ? "1" : "hasard", { config, rng, eviterSommet: j.dette > 0 });
      connu = null;
    }
  }
  if (!d.termine && d.actif === id) finirTour(d, id, { config });
}

export { CARTES, POSITIONS };
