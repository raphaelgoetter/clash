#!/usr/bin/env node
// ============================================================
// Simulation Monte Carlo du Blackjack : anciennes règles (Croupier au
// score tiré entre 16 et 21, jamais de dépassement, alternance visible /
// joue en second) comparées à des règles plus proches de l'officiel
// (Croupier qui tire jusqu'à 17 avec une carte visible, Blackjack naturel,
// Doubler), pour plusieurs profils de joueur.
//
// Sabot infini comme dans le jeu (rang uniforme parmi 13, drawUniqueCard
// pour la main du joueur). Aucun accès Redis.
//
// Usage : node jeux/outils/blackjack-simulation/simulation.mjs [mains] [graine]
// ============================================================

import { computeHandValue, drawCard, drawUniqueCard } from "../../services/blackjack.js";

// Ancienne règle (avant le Croupier officiel) : score tiré uniformément
// entre min et max, jamais de dépassement. Gardée ici pour la comparaison.
const rollDealerScore = (r, min, max) => min + Math.floor(r() * (max - min + 1));

const MAINS = Number(process.argv[2]) || 400_000;
let graine = Number(process.argv[3]) || 42;

// mulberry32 : générateur reproductible
function rng() {
  graine |= 0;
  graine = (graine + 0x6d2b79f5) | 0;
  let t = Math.imul(graine ^ (graine >>> 15), 1 | graine);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const JOURS = 7;
const BAREME = { win: 2, push: 1, lose: 0, naturel: 3 };

// Total « souple » : un As compte encore pour 11
function estSouple(cartes) {
  const brut = cartes.reduce((s, c) => s + c.value, 0);
  const as = cartes.filter((c) => c.rank === "A").length;
  let total = brut;
  let asA11 = as;
  while (total > 21 && asA11 > 0) {
    total -= 10;
    asA11 -= 1;
  }
  return asA11 > 0;
}

const estNaturel = (cartes) => cartes.length === 2 && computeHandValue(cartes) === 21;
const valeurVisible = (carte) => (carte.rank === "A" ? 11 : carte.value);

// ── Anciennes règles ────────────────────────────────────────────────

// Croupier visible (jours impairs) : le joueur connaît la cible T et pioche
// tant qu'il est en dessous ; à égalité, il pioche si `risqueEgalite`.
function mainActuelleVisible(risqueEgalite) {
  const cible = rollDealerScore(rng, 16, 21);
  const cartes = [drawCard(rng)];
  cartes.push(drawUniqueCard(cartes, rng));
  let score = computeHandValue(cartes);
  while (score < 21 && (score < cible || (risqueEgalite && score === cible))) {
    cartes.push(drawUniqueCard(cartes, rng));
    score = computeHandValue(cartes);
  }
  if (score > 21) return { issue: "lose", points: 0 };
  const issue = score > cible ? "win" : score === cible ? "push" : "lose";
  return { issue, points: BAREME[issue] };
}

// Croupier caché (jours pairs) : le joueur s'arrête à partir de `seuil`
function mainActuelleCachee(seuil) {
  const cible = rollDealerScore(rng, 16, 21);
  const cartes = [drawCard(rng)];
  cartes.push(drawUniqueCard(cartes, rng));
  let score = computeHandValue(cartes);
  while (score < seuil) {
    cartes.push(drawUniqueCard(cartes, rng));
    score = computeHandValue(cartes);
  }
  if (score > 21) return { issue: "lose", points: 0 };
  const issue = score > cible ? "win" : score === cible ? "push" : "lose";
  return { issue, points: BAREME[issue] };
}

// ── Règles officielles (variantes) ──────────────────────────────────

// Stratégie de base (sabot infini, Croupier reste sur 17 souple, sans
// séparation). Renvoie "H" (piocher), "S" (rester) ou "D" (doubler si
// possible, sinon piocher ; "Ds" : doubler sinon rester).
function strategieDeBase(cartes, visible) {
  const total = computeHandValue(cartes);
  const v = valeurVisible(visible);
  if (estSouple(cartes) && total <= 21) {
    if (total >= 19) return "S";
    if (total === 18) return v >= 3 && v <= 6 ? "Ds" : v <= 8 ? "S" : "H";
    if (total === 17) return v >= 3 && v <= 6 ? "D" : "H";
    if (total >= 15) return v >= 4 && v <= 6 ? "D" : "H";
    return v >= 5 && v <= 6 ? "D" : "H";
  }
  if (total >= 17) return "S";
  if (total >= 13) return v <= 6 ? "S" : "H";
  if (total === 12) return v >= 4 && v <= 6 ? "S" : "H";
  if (total === 11) return v <= 10 ? "D" : "H";
  if (total === 10) return v <= 9 ? "D" : "H";
  if (total === 9) return v >= 3 && v <= 6 ? "D" : "H";
  return "H";
}

// Joueur prudent : reste à partir de 17, ne regarde pas la carte visible
const strategiePrudente = (cartes) => (computeHandValue(cartes) >= 17 ? "S" : "H");

// Joueur qui imite le Croupier en restant dès 15 (peur de sauter)
const strategieFrileuse = (cartes) => (computeHandValue(cartes) >= 15 ? "S" : "H");

/**
 * @param {object} o
 * @param {Function} o.strategie
 * @param {boolean} o.doubler bouton Doubler (2 premières cartes)
 * @param {boolean} o.naturel 21 en 2 cartes = 3 points, bat un 21 en 3+
 * @param {boolean} o.tire17Souple Croupier pioche sur 17 souple (H17)
 */
function mainOfficielle({ strategie, doubler, naturel, tire17Souple = false }) {
  const croupier = [drawCard(rng), drawCard(rng)];
  const visible = croupier[0];
  const joueur = [drawCard(rng)];
  joueur.push(drawUniqueCard(joueur, rng));

  // Le Croupier vérifie son Blackjack d'emblée (As ou 10 visible) :
  // la main s'arrête aussitôt
  const croupierNaturel = estNaturel(croupier);
  const joueurNaturel = estNaturel(joueur);
  if (croupierNaturel || joueurNaturel) {
    if (croupierNaturel && joueurNaturel) return { issue: "push", points: BAREME.push, double: false };
    if (croupierNaturel) return { issue: "lose", points: 0, double: false };
    // Sans la règle du naturel, un 21 en 2 cartes reste un 21 ordinaire :
    // le Croupier joue quand même sa main
    if (naturel) return { issue: "naturel", points: BAREME.naturel, double: false };
  }

  let double = false;
  for (;;) {
    const score = computeHandValue(joueur);
    if (score >= 21) break;
    let action = strategie(joueur, visible);
    const peutDoubler = doubler && joueur.length === 2;
    if (action === "D") action = peutDoubler ? "D" : "H";
    if (action === "Ds") action = peutDoubler ? "D" : "S";
    if (action === "S") break;
    joueur.push(drawUniqueCard(joueur, rng));
    if (action === "D") {
      double = true;
      break;
    }
  }
  const scoreJoueur = computeHandValue(joueur);
  const mult = double ? 2 : 1;
  if (scoreJoueur > 21) return { issue: "lose", points: 0, double };

  let scoreCroupier = computeHandValue(croupier);
  while (scoreCroupier < 17 || (tire17Souple && scoreCroupier === 17 && estSouple(croupier))) {
    croupier.push(drawCard(rng));
    scoreCroupier = computeHandValue(croupier);
  }
  const issue = scoreCroupier > 21 || scoreJoueur > scoreCroupier ? "win" : scoreJoueur === scoreCroupier ? "push" : "lose";
  return { issue, points: BAREME[issue] * mult, double, croupierSaute: scoreCroupier > 21 };
}

// ── Mesures ─────────────────────────────────────────────────────────

function mesurer(nom, jouer) {
  const issues = { win: 0, push: 0, lose: 0, naturel: 0 };
  let somme = 0;
  let sommeCarres = 0;
  let doubles = 0;
  for (let i = 0; i < MAINS; i++) {
    const r = jouer(i);
    issues[r.issue] += 1;
    somme += r.points;
    sommeCarres += r.points * r.points;
    if (r.double) doubles += 1;
  }
  const moyenne = somme / MAINS;
  const ecart = Math.sqrt(sommeCarres / MAINS - moyenne * moyenne);
  return { nom, issues, moyenne, ecart, doubles: doubles / MAINS };
}

// Manche de 7 jours : moyenne et dispersion du total d'un joueur, et
// probabilité que deux joueurs de même profil finissent ex aequo
function manche(jouer) {
  const N = Math.floor(MAINS / JOURS);
  const totaux = new Map();
  for (let i = 0; i < N; i++) {
    let t = 0;
    for (let j = 1; j <= JOURS; j++) t += jouer(j).points;
    totaux.set(t, (totaux.get(t) ?? 0) + 1);
  }
  let moy = 0;
  let egal = 0;
  for (const [t, n] of totaux) {
    moy += (t * n) / N;
    egal += (n / N) ** 2;
  }
  let v = 0;
  for (const [t, n] of totaux) v += ((t - moy) ** 2 * n) / N;
  return { moyenne: moy, ecart: Math.sqrt(v), egalite: egal };
}

const pct = (x) => `${(100 * x).toFixed(1)} %`;

function afficher(r) {
  const { win, push, lose, naturel } = r.issues;
  const parts = [`victoire ${pct(win / MAINS)}`, `égalité ${pct(push / MAINS)}`, `défaite ${pct(lose / MAINS)}`];
  if (naturel) parts.push(`naturel ${pct(naturel / MAINS)}`);
  if (r.doubles) parts.push(`doublées ${pct(r.doubles)}`);
  console.log(`- ${r.nom}`);
  console.log(`    ${parts.join(" · ")}`);
  console.log(`    ${r.moyenne.toFixed(3)} pt/main (écart-type ${r.ecart.toFixed(2)})`);
}

function afficherManche(nom, jouer) {
  const m = manche(jouer);
  console.log(`- ${nom} : ${m.moyenne.toFixed(1)} pts sur ${JOURS} jours (écart-type ${m.ecart.toFixed(1)}), ex aequo entre 2 joueurs ${pct(m.egalite)}`);
}

// ── Scénarios ───────────────────────────────────────────────────────

console.log(`Simulation Blackjack : ${MAINS.toLocaleString("fr-FR")} mains par scénario\n`);

console.log("## Anciennes règles (Croupier 16-21, jamais de dépassement)");
const visibleOpt = mesurer("Croupier visible, pioche jusqu'à dépasser la cible", () => mainActuelleVisible(false));
afficher(visibleOpt);
afficher(mesurer("Croupier visible, pioche aussi sur égalité", () => mainActuelleVisible(true)));
let meilleurSeuil = null;
for (let seuil = 15; seuil <= 20; seuil++) {
  const r = mesurer(`Croupier caché, reste dès ${seuil}`, () => mainActuelleCachee(seuil));
  if (!meilleurSeuil || r.moyenne > meilleurSeuil.moyenne) meilleurSeuil = { ...r, seuil };
}
afficher(meilleurSeuil);
const actuel = (j) => (j % 2 === 1 ? mainActuelleVisible(false) : mainActuelleCachee(meilleurSeuil.seuil));
const actuelPrudent = (j) => (j % 2 === 1 ? mainActuelleVisible(false) : mainActuelleCachee(17));

const scenarios = [
  ["Croupier officiel (reste sur 17), stratégie de base", { strategie: strategieDeBase, doubler: false, naturel: false }],
  ["+ Blackjack naturel (3 pts)", { strategie: strategieDeBase, doubler: false, naturel: true }],
  ["+ naturel + Doubler", { strategie: strategieDeBase, doubler: true, naturel: true }],
  ["+ naturel + Doubler, Croupier tire sur 17 souple", { strategie: strategieDeBase, doubler: true, naturel: true, tire17Souple: true }],
  ["naturel + Doubler, joueur prudent (reste dès 17, ne double pas)", { strategie: strategiePrudente, doubler: true, naturel: true }],
  ["naturel + Doubler, joueur frileux (reste dès 15, ne double pas)", { strategie: strategieFrileuse, doubler: true, naturel: true }],
];

console.log("\n## Règles officielles");
const resultats = scenarios.map(([nom, o]) => {
  const r = mesurer(nom, () => mainOfficielle(o));
  afficher(r);
  return r;
});

// Taux de dépassement du Croupier (règle « reste sur 17 »), mesuré sur
// sa main seule : dans le jeu, il ne joue pas quand le joueur a sauté
let sauts = 0;
for (let i = 0; i < MAINS; i++) {
  const croupier = [drawCard(rng), drawCard(rng)];
  if (estNaturel(croupier)) continue;
  while (computeHandValue(croupier) < 17) croupier.push(drawCard(rng));
  if (computeHandValue(croupier) > 21) sauts += 1;
}
console.log(`\nLe Croupier officiel dépasse 21 dans ${pct(sauts / MAINS)} des mains qu'il joue jusqu'au bout`);

console.log(`\n## Manche de ${JOURS} jours (un joueur)`);
afficherManche(`Ancien, joueur optimal (caché : reste dès ${meilleurSeuil.seuil})`, actuel);
afficherManche("Ancien, joueur qui reste dès 17 les jours cachés", actuelPrudent);
afficherManche("Officiel + naturel + Doubler, stratégie de base", () => mainOfficielle(scenarios[2][1]));
afficherManche("Officiel + naturel + Doubler, joueur prudent", () => mainOfficielle(scenarios[4][1]));

console.log(`\nÉcart entre stratégie de base et joueur prudent (officiel complet) : ${(resultats[2].moyenne - resultats[4].moyenne).toFixed(3)} pt/main`);
