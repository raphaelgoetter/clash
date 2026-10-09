// ============================================================
// bangDuelRules.js — Règles pures de Bang! Duel (`/bang`) : un joueur
// contre le Bot, à tour de rôle sur une pioche commune, adaptation
// d'Exploding Kittens Duel avec le principe de Bang! (plusieurs pioches
// par tour, cartes jouables avant ou après la pioche, « Finir mon tour »).
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
  // pioches / jouees : compteurs du tour ; esquive : Fût joué (compte comme
  // la pioche du tour) ; dette : pioches dues (Gang) ; enAttente : Gobelin
  // explosif désamorcé à cacher ; vol : Voleuse jouée, carte à choisir
  return { main, moine: false, dette: 0, pioches: 0, jouees: 0, esquive: false, enAttente: false, vol: false };
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
  if (j.vol) return "vol";
  return null;
}

// Pioche la carte du sommet : pioche due (Gang) d'abord, sinon pioche
// volontaire, `pioches_par_tour` au plus.
// Renvoie { erreur } ou { carte, bang: null | "sauve" | "elimine" }.
export function piocher(d, id, { config }) {
  const erreur = verifierActif(d, id);
  if (erreur) return { erreur };
  const j = d.joueurs[id];
  if (!d.pioche.length) return { erreur: "pioche" };
  if (j.dette < 1 && j.pioches >= config.pioches_par_tour) return { erreur: "plafondPioche" };
  if (j.dette > 0) j.dette -= 1;
  j.pioches += 1;
  const carte = d.pioche.shift();
  d.soupcon[id] = false;
  if (carte !== "bombe") {
    j.main.push(carte);
    noter(d, id, "pioche", { carte });
    return { carte, bang: null };
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
  return { carte, bang: "sauve" };
}

// Cache le Gobelin explosif désamorcé (positions de Bang!). L'adversaire
// sait qu'il est dans la pioche, pas où (`soupcon`, utilisé par le Bot).
export function placer(d, id, position, { rng = Math.random } = {}) {
  const j = d.joueurs[id];
  if (!j?.enAttente) return { erreur: "pasEnAttente" };
  if (!(position in POSITIONS)) return { erreur: "position" };
  const len = d.pioche.length;
  const index =
    position === "milieu" ? Math.floor(len / 2)
      : position === "fond" ? len
        : position === "hasard" ? Math.floor(rng() * (len + 1))
          : Math.min(Number(position) - 1, len);
  d.pioche.splice(index, 0, "bombe");
  j.enAttente = false;
  d.soupcon[adversaire(id)] = true;
  noter(d, id, "cache", { position });
  return { index };
}

// Fin du tour : au moins une pioche (ou un Fût), pioches dues faites (sauf
// pioche vide). Passe la main ; tour suivant après le Bot, match nul après
// le dernier tour.
export function finirTour(d, id, { config, force = false }) {
  const erreur = verifierActif(d, id);
  if (erreur) return { erreur };
  const j = d.joueurs[id];
  if (!force && d.pioche.length) {
    if (j.dette > 0) return { erreur: "dette" };
    if (!j.pioches && !j.esquive) return { erreur: "doitPiocher" };
  }
  Object.assign(j, { dette: 0, pioches: 0, jouees: 0, esquive: false });
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
    if (j.dette > 0) j.dette -= 1;
    else j.esquive = true;
    noter(d, id, "fut");
    return { carte };
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
    finirTour(d, id, { config, force: true });
    return { carte, finTour: true };
  }
  // Voleuse : le voleur voit la main adverse et choisit (voler())
  if (!adv.main.length) {
    noter(d, id, "voleuseVide");
    return { carte, vole: null };
  }
  j.vol = true;
  return { carte, choix: [...adv.main] };
}

// Voleuse : prend la carte choisie dans la main adverse.
export function voler(d, id, carte) {
  const j = d.joueurs[id];
  if (!j?.vol) return { erreur: "pasDeVol" };
  const adv = d.joueurs[adversaire(id)];
  const index = adv.main.indexOf(carte);
  if (index === -1) return { erreur: "pasEnMain" };
  adv.main.splice(index, 1);
  j.main.push(carte);
  j.vol = false;
  noter(d, id, "voleuse", { carte });
  return { carte };
}

// ── Bot (stratège) ───────────────────────────────────────────────────
// Joue le tour complet de `id` : Moine d'avance, Voleuse sur la meilleure
// carte, Sarbacane avant de piocher, esquive (Gang, Tornade, Fût) si un
// Gobelin explosif est connu ou soupçonné en haut, Gobelin explosif
// désamorcé caché en haut une fois sur deux (sinon au hasard, pour
// bluffer). Les actions sont notées au journal.

const PRIORITE_VOL = ["esprit", "gang", "fut", "tornade", "moine", "sarbacane", "voleuse", "gobelin"];

export function jouerBot(d, id, { config, rng = Math.random }) {
  const j = d.joueurs[id];
  const adv = d.joueurs[adversaire(id)];
  const a = (carte) => j.main.includes(carte) && j.jouees < config.cartes_par_tour;
  let connu = null; // sommet de la pioche vu à la Sarbacane

  if (a("moine") && !j.moine) jouer(d, id, "moine", { config, rng });
  if (a("voleuse") && adv.main.length) {
    const r = jouer(d, id, "voleuse", { config, rng });
    if (r.choix) voler(d, id, PRIORITE_VOL.find((c) => r.choix.includes(c)) ?? r.choix[0]);
  }

  for (let garde = 0; garde < 20 && !d.termine && d.actif === id; garde++) {
    const doit = j.dette > 0 || (!j.pioches && !j.esquive);
    if (!doit || !d.pioche.length) break;
    if (!connu && a("sarbacane")) connu = jouer(d, id, "sarbacane", { config, rng }).revelation;
    const danger = connu ? connu[0] === "bombe" : d.soupcon[id];
    if (danger) {
      if (a("gang")) {
        jouer(d, id, "gang", { config, rng });
        if (d.actif !== id) return;
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
      placer(d, id, rng() < 0.5 ? "1" : "hasard", { rng });
      connu = null;
    }
  }
  // Pioche supplémentaire si le sommet est connu et sûr
  while (!d.termine && connu?.length && connu[0] !== "bombe" && j.pioches < config.pioches_par_tour) {
    piocher(d, id, { config });
    connu = connu.slice(1);
  }
  if (!d.termine && d.actif === id) finirTour(d, id, { config, force: true });
}

export { CARTES, POSITIONS };
