// ============================================================
// mascaradeRules.js — Règles pures de Mascarade (`/mascarade`), duel de
// cartes à information cachée : chacun garde UNE carte secrète en main. À
// son tour, on pioche une carte puis on joue l'une des deux (son effet
// s'applique). Une manche se termine quand un joueur est éliminé, ou quand
// la pioche est vide : la carte la plus chère en main gagne (égalité : le
// plus d'élixir dépensé dans la manche). Le premier à `MANCHES_GAGNANTES`
// manches gagne la partie.
//
// Paquet de 17 cartes Clash Royale, valeur = coût en élixir. Mise en place
// d'une manche : 1 carte mise de côté face cachée (la Réserve), 2 cartes
// écartées face visible, 1 carte chacun.
//
// Aucune I/O : la couche Redis lit le duel, appelle ces fonctions sous
// verrou puis le réécrit. `rng` injectable (mélange, Kévina, tests).
//
// Joueurs : "joueur" (contre Kévina, ou le premier joueur tiré au sort en
// 1v1) et "bot" (Kévina, ou le second joueur en 1v1).
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Mascarade), source de vérité.
// ============================================================

export const IDS = ["joueur", "bot"];
export const MANCHES_GAGNANTES = 2;

// `cle` : carte Clash Royale (jeux/data/cardNames.json), pour l'illustration
export const CARTES = {
  squelettes: { nom: "Squelettes", cle: "Skeletons", cout: 1, nb: 4, effet: "Regarde la carte du dessus de la pioche ; tu peux la glisser dessous." },
  gobelins: { nom: "Gobelins", cle: "Goblins", cout: 2, nb: 2, effet: "Regarde la carte de l'adversaire." },
  buche: { nom: "Bûche", cle: "The Log", cout: 2, nb: 1, effet: "Comparez vos cartes : la moins chère perd la manche (égalité : rien)." },
  chevalier: { nom: "Chevalier", cle: "Knight", cout: 3, nb: 2, effet: "Les effets adverses ne te touchent pas jusqu'à ton prochain tour." },
  tornade: { nom: "Tornade", cle: "Tornado", cout: 3, nb: 1, effet: "Échange ta carte avec celle de l'adversaire." },
  bdf: { nom: "Boule de feu", cle: "Fireball", cout: 4, nb: 2, effet: "Annonce un coût : si la carte adverse coûte autant, il perd la manche." },
  gel: { nom: "Gel", cle: "Freeze", cout: 4, nb: 1, effet: "À son prochain tour, l'adversaire doit jouer la carte qu'il pioche." },
  prince: { nom: "Prince", cle: "Prince", cout: 5, nb: 2, effet: "L'adversaire défausse sa carte et en pioche une autre." },
  mega: { nom: "Méga chevalier", cle: "Mega Knight", cout: 7, nb: 1, effet: "Prends la Réserve, puis remets-y face cachée l'une de tes deux cartes." },
  triple: { nom: "Trois mousquetaires", cle: "Three Musketeers", cout: 9, nb: 1, effet: "Aucun effet. Si elle quitte ta main (jouée ou défaussée), tu perds la manche." },
};
export const PAQUET = Object.entries(CARTES).flatMap(([id, c]) => Array(c.nb).fill(id));
// Coûts qu'une Boule de feu peut annoncer (3 ou plus)
export const COUTS_ANNONCE = [...new Set(Object.values(CARTES).map((c) => c.cout).filter((c) => c >= 3))].sort((a, b) => a - b);

export const cout = (carte) => CARTES[carte].cout;
export const adversaire = (id) => (id === "joueur" ? "bot" : "joueur");
const parId = (f) => ({ joueur: f("joueur"), bot: f("bot") });

function melange(a, rng) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function creerDuel({ commence = "joueur", rng = Math.random } = {}) {
  const d = {
    manches: { joueur: 0, bot: 0 },
    // Résultat de chaque manche : { gagnant (ou "nul"), fin, mains }
    historique: [],
    // Numéro de l'état affiché, +1 à chaque action : écarte un clic sur une
    // vue dépassée
    vue: 0,
    termine: false,
    gagnant: null,
  };
  nouvelleManche(d, commence, rng);
  return d;
}

// Manche : pioche, Réserve (cachée), 2 cartes écartées (visibles), une
// carte chacun ; le premier joueur pioche aussitôt.
function nouvelleManche(d, commence, rng) {
  const p = melange(PAQUET, rng);
  Object.assign(d, {
    numero: d.historique.length + 1,
    commence,
    reserve: p[0],
    ecartees: [p[1], p[2]],
    main: { joueur: [p[3]], bot: [p[4]] },
    pioche: p.slice(5),
    defausse: { joueur: [], bot: [] },
    elixir: { joueur: 0, bot: 0 },
    protege: { joueur: false, bot: false },
    gele: { joueur: false, bot: false },
    // Carte adverse connue de chacun (Gobelins, Bûche, Tornade, Squelettes)
    connu: { joueur: null, bot: null },
    // Carte remise dans la Réserve, connue de celui qui l'y a mise
    reserveConnue: { joueur: null, bot: null },
    // Carte vue au sommet par des Squelettes (laissée) : connue une fois piochée
    vuDessus: { joueur: null, bot: null },
    actif: commence,
    // Carte piochée ce tour (le Gel oblige à la jouer)
    piochee: null,
    // Choix en attente après un effet : { type: "squelettes", id, carte }
    // ou { type: "mega", id, cartes: [a, b] }
    attente: null,
    // Dernière action : { id, carte, cible, manche, effet: {…} }, gardée
    // d'une manche à l'autre (récit du coup qui a terminé la manche)
    dernier: d.dernier ?? null,
    finManche: null,
  });
  debutTour(d);
}

function debutTour(d) {
  const id = d.actif;
  // La protection du Chevalier dure jusqu'au tour suivant de son joueur
  d.protege[id] = false;
  const c = d.pioche.shift();
  d.main[id].push(c);
  d.piochee = c;
  const guet = d.vuDessus[adversaire(id)];
  d.vuDessus[adversaire(id)] = null;
  if (guet === c) d.guet = { id: adversaire(id), carte: c };
  else d.guet = null;
}

// Cartes jouables par `id` (doublons fusionnés) : sous le Gel, seulement la
// carte piochée ; les Trois mousquetaires jamais, sauf imposés par le Gel.
export function cartesJouables(d, id) {
  if (d.termine || d.attente || d.actif !== id) return [];
  const m = d.main[id];
  const choix = d.gele[id] && d.piochee ? [d.piochee] : [...new Set(m)];
  const sans = choix.filter((c) => c !== "triple");
  return sans.length ? sans : choix;
}

// Pioche une carte de remplacement (la Réserve si la pioche est vide).
function piocherRemplacement(d) {
  if (d.pioche.length) return d.pioche.shift();
  const r = d.reserve;
  d.reserve = null;
  d.reserveConnue = { joueur: null, bot: null };
  return r;
}

function eliminer(d, perdant, fin) {
  if (!d.finManche) d.finManche = { gagnant: adversaire(perdant), fin };
}

// Joue `carte` pour `id` (`cible` : coût annoncé par une Boule de feu).
// Renvoie { erreur } ou {}. Un effet à choix (Squelettes, Méga chevalier)
// laisse `d.attente` : la suite vient de `choisir()`.
export function jouer(d, id, carte, { cible = null } = {}) {
  if (d.termine) return { erreur: "termine" };
  if (d.attente) return { erreur: "attente" };
  if (d.actif !== id) return { erreur: "pasTonTour" };
  if (!d.main[id].includes(carte)) return { erreur: "pasEnMain" };
  if (!cartesJouables(d, id).includes(carte)) return { erreur: carte === "triple" ? "triple" : "gel" };
  if (carte === "bdf" && !COUTS_ANNONCE.includes(cible)) return { erreur: "cible" };

  const q = adversaire(id);
  const m = d.main[id];
  m.splice(m.lastIndexOf(carte), 1);
  d.defausse[id].push(carte);
  d.elixir[id] += cout(carte);
  d.gele[id] = false;
  // Carte connue par l'adversaire : il sait qu'elle est partie (sauf doublon gardé)
  if (d.connu[q] === carte && !m.includes(carte)) d.connu[q] = null;
  // Squelettes laissées au sommet par l'adversaire : il sait ce que `id` a pioché
  if (d.guet?.id === q && m.includes(d.guet.carte)) d.connu[q] = d.guet.carte;
  d.guet = null;
  d.vue += 1;

  const prot = d.protege[q];
  const effet = {};
  d.dernier = { id, carte, cible: carte === "bdf" ? cible : null, manche: d.numero, effet };
  const cibleTouchee = !["squelettes", "chevalier", "mega", "triple"].includes(carte);
  if (cibleTouchee && prot) effet.protege = true;
  else
    switch (carte) {
      case "triple":
        eliminer(d, id, "triple");
        break;
      case "squelettes":
        if (d.pioche.length) {
          d.attente = { type: "squelettes", id, carte: d.pioche[0] };
          return {};
        }
        break;
      case "gobelins":
        d.connu[id] = d.main[q][0];
        effet.vu = d.main[q][0];
        break;
      case "prince": {
        const jetee = d.main[q].pop();
        d.defausse[q].push(jetee);
        d.connu[id] = null;
        effet.defaussee = jetee;
        if (jetee === "triple") eliminer(d, q, "defausse");
        else {
          const n = piocherRemplacement(d);
          if (n) d.main[q].push(n);
          else {
            effet.sansCarte = true;
            eliminer(d, q, "sansCarte");
          }
        }
        break;
      }
      case "chevalier":
        d.protege[id] = true;
        break;
      case "tornade": {
        const [a, b] = [d.main[id][0], d.main[q][0]];
        d.main[id][0] = b;
        d.main[q][0] = a;
        d.connu[id] = a;
        d.connu[q] = b;
        // Carte reçue par chacun
        effet.recue = { [id]: b, [q]: a };
        break;
      }
      case "bdf":
        effet.touche = cout(d.main[q][0]) === cible;
        if (effet.touche) {
          effet.carte = d.main[q][0];
          eliminer(d, q, "bdf");
        }
        break;
      case "gel":
        d.gele[q] = true;
        break;
      case "buche": {
        const [a, b] = [d.main[id][0], d.main[q][0]];
        d.connu[id] = b;
        d.connu[q] = a;
        effet.cartes = { [id]: a, [q]: b };
        if (cout(a) !== cout(b)) eliminer(d, cout(a) < cout(b) ? id : q, "comparaison");
        break;
      }
      case "mega":
        if (d.reserve) {
          d.attente = { type: "mega", id, cartes: [d.main[id][0], d.reserve] };
          d.main[id] = [];
          d.reserve = null;
          return {};
        }
        effet.sansReserve = true;
        break;
    }
  finTour(d, rngDuel(d));
  return {};
}

// Choix en attente : Squelettes ("laisser" | "dessous"), Méga chevalier
// (index 0 ou 1 de la carte GARDÉE, l'autre retourne dans la Réserve).
export function choisir(d, id, choix) {
  const a = d.attente;
  if (d.termine) return { erreur: "termine" };
  if (!a || a.id !== id) return { erreur: "pasTonTour" };
  if (a.type === "squelettes") {
    if (!["laisser", "dessous"].includes(choix)) return { erreur: "choix" };
    if (choix === "dessous") d.pioche.push(d.pioche.shift());
    else d.vuDessus[id] = a.carte;
    d.dernier.effet.dessous = choix === "dessous";
  } else {
    if (![0, 1].includes(choix)) return { erreur: "choix" };
    const garde = a.cartes[choix];
    const remise = a.cartes[1 - choix];
    d.main[id] = [garde];
    d.reserve = remise;
    d.reserveConnue = { [id]: remise, [adversaire(id)]: null };
    d.connu[adversaire(id)] = null;
    d.dernier.effet.echange = choix === 1;
  }
  d.attente = null;
  d.vue += 1;
  finTour(d, rngDuel(d));
  return {};
}

// Mélange des manches suivantes : `d.rng` (tests) sinon Math.random.
const rngDuel = (d) => d._rng ?? Math.random;

// Fin du tour : manche terminée (élimination ou pioche vide) ou tour adverse.
function finTour(d, rng) {
  if (!d.finManche && !d.pioche.length) {
    const [a, b] = [cout(d.main.joueur[0]), cout(d.main.bot[0])];
    if (a !== b) d.finManche = { gagnant: a > b ? "joueur" : "bot", fin: "pioche" };
    else if (d.elixir.joueur !== d.elixir.bot) d.finManche = { gagnant: d.elixir.joueur > d.elixir.bot ? "joueur" : "bot", fin: "elixir" };
    else d.finManche = { gagnant: "nul", fin: "egalite" };
  }
  if (d.finManche) return cloreManche(d, rng);
  d.actif = adversaire(d.actif);
  debutTour(d);
}

// Manche terminée : point au gagnant, partie gagnée à MANCHES_GAGNANTES,
// sinon nouvelle manche, que le perdant commence (égalité : on alterne).
function cloreManche(d, rng) {
  const { gagnant, fin } = d.finManche;
  // Table de la manche conservée pour l'afficher une fois terminée
  d.historique.push({
    gagnant,
    fin,
    mains: parId((id) => d.main[id][0] ?? null),
    reserve: d.reserve,
    ecartees: [...d.ecartees],
    defausse: parId((id) => [...d.defausse[id]]),
    pioche: d.pioche.length,
  });
  if (gagnant !== "nul") d.manches[gagnant] += 1;
  if (gagnant !== "nul" && d.manches[gagnant] >= MANCHES_GAGNANTES) {
    Object.assign(d, { termine: true, gagnant, attente: null });
    return;
  }
  nouvelleManche(d, gagnant === "nul" ? adversaire(d.commence) : adversaire(gagnant), rng);
}

// ── Kévina (recherche par mondes possibles) ──────────────────────────────
// Kévina tient le compte des cartes : elle tire au sort des « mondes »
// compatibles avec ce qu'elle sait (cartes vues, carte adverse connue,
// Réserve qu'elle a remplie), joue chaque coup possible dans chacun puis
// finit la manche avec un jeu simple ; elle garde le coup qui gagne le plus
// souvent. Avec la probabilité `erreur`, elle joue un coup au hasard.

// Pioche, Réserve et carte adverse tirées au sort parmi les cartes que `id`
// n'a pas vues.
function monde(d, id, rng) {
  const q = adversaire(id);
  const t = structuredClone(d);
  const a = d.attente?.id === id ? d.attente : null;
  const enMain = a?.type === "mega" ? a.cartes : d.main[id];
  const vus = [...enMain, ...d.ecartees, ...d.defausse.joueur, ...d.defausse.bot];
  if (d.reserveConnue[id] && d.reserve) vus.push(d.reserve);
  if (a?.type === "squelettes") vus.push(a.carte);
  const inconnus = [...PAQUET];
  for (const v of vus) {
    const k = inconnus.indexOf(v);
    if (k >= 0) inconnus.splice(k, 1);
  }
  const m = melange(inconnus, rng);
  const nbAdv = d.main[q].length;
  const advMain = [];
  if (d.connu[id] && m.includes(d.connu[id]) && nbAdv) {
    advMain.push(d.connu[id]);
    m.splice(m.indexOf(d.connu[id]), 1);
  }
  while (advMain.length < nbAdv) advMain.push(m.shift());
  t.main[q] = advMain;
  const n = d.pioche.length - (a?.type === "squelettes" ? 1 : 0);
  t.pioche = [...(a?.type === "squelettes" ? [a.carte] : []), ...m.slice(0, n)];
  if (d.reserve) t.reserve = d.reserveConnue[id] ? d.reserve : m[n];
  return t;
}

// Jeu simple des fins de manche simulées : carte adverse connue, Boule de
// feu dessus (ou Bûche si on tient plus cher) ; sinon garde sa carte la plus
// chère (70 %) ou joue au hasard ; choix en attente faits au plus simple.
function coupSimple(d, id, rng) {
  const cs = cartesJouables(d, id);
  // Carte adverse connue : Boule de feu dessus, ou Bûche si on tient plus cher
  const k = d.connu[id];
  const autre = (c) => d.main[id].find((x, i) => x !== c || d.main[id].indexOf(c) !== i);
  if (k && !d.protege[adversaire(id)]) {
    if (cs.includes("bdf") && COUTS_ANNONCE.includes(cout(k))) return { carte: "bdf", cible: cout(k) };
    if (cs.includes("buche") && cout(autre("buche")) > cout(k)) return { carte: "buche", cible: null };
  }
  let carte;
  if (rng() < 0.7) {
    const min = Math.min(...cs.map(cout));
    const l = cs.filter((c) => cout(c) === min);
    carte = l[Math.floor(rng() * l.length)];
  } else carte = cs[Math.floor(rng() * cs.length)];
  return { carte, cible: carte === "bdf" ? COUTS_ANNONCE[Math.floor(rng() * COUTS_ANNONCE.length)] : null };
}

function choixSimple(d) {
  const a = d.attente;
  if (a.type === "squelettes") return "laisser";
  return cout(a.cartes[1]) > cout(a.cartes[0]) ? 1 : 0;
}

// Joue jusqu'à la fin de la manche `numero` (celle où le coup évalué a été
// joué : il a pu la terminer) ; renvoie son gagnant.
function finirManche(t, rng, numero) {
  t._rng = rng;
  for (let k = 0; k < 60 && !t.termine && t.numero === numero; k++) {
    if (t.attente) choisir(t, t.attente.id, choixSimple(t));
    else {
      const c = coupSimple(t, t.actif, rng);
      jouer(t, t.actif, c.carte, { cible: c.cible });
    }
  }
  return t.historique[numero - 1]?.gagnant ?? null;
}

const valeur = (g, id) => (g === id ? 1 : g === "nul" ? 0.5 : 0);

function meilleur(options, evaluer, mondes, d, id, rng) {
  if (options.length === 1) return options[0];
  const sc = options.map(() => 0);
  for (let k = 0; k < mondes; k++) {
    const w = monde(d, id, rng);
    options.forEach((o, i) => {
      const t = structuredClone(w);
      t._rng = rng;
      evaluer(t, o);
      sc[i] += valeur(finirManche(t, rng, w.numero), id);
    });
  }
  const mx = Math.max(...sc);
  const b = options.filter((_, i) => sc[i] === mx);
  return b[Math.floor(rng() * b.length)];
}

// Coup de Kévina (siège `id`) : { carte, cible }.
export function choixKevina(d, id, { mondes = 40, erreur = 0, rng = Math.random } = {}) {
  const cs = cartesJouables(d, id);
  const options = cs.flatMap((carte) => (carte === "bdf" ? COUTS_ANNONCE.map((cible) => ({ carte, cible })) : [{ carte, cible: null }]));
  if (rng() < erreur) {
    const sures = options.filter((o) => o.carte !== "triple");
    const l = sures.length ? sures : options;
    return l[Math.floor(rng() * l.length)];
  }
  return meilleur(options, (t, o) => jouer(t, id, o.carte, { cible: o.cible }), mondes, d, id, rng);
}

// Choix en attente de Kévina (Squelettes : "laisser" | "dessous" ; Méga
// chevalier : index de la carte gardée).
export function choixAttenteKevina(d, id, { mondes = 40, rng = Math.random } = {}) {
  const options = d.attente.type === "squelettes" ? ["laisser", "dessous"] : [0, 1];
  return meilleur(options, (t, o) => choisir(t, id, o), mondes, d, id, rng);
}

// Coup au hasard (simulation), Trois mousquetaires évités.
export function choixHasard(d, id, rng = Math.random) {
  const cs = cartesJouables(d, id);
  const carte = cs[Math.floor(rng() * cs.length)];
  return { carte, cible: carte === "bdf" ? COUTS_ANNONCE[Math.floor(rng() * COUTS_ANNONCE.length)] : null };
}
