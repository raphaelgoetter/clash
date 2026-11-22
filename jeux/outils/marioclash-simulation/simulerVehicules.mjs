// ============================================================
// Simulation : équilibrage des véhicules de Mario Clash (projet).
// Règles : jeux/CONTRIBUTING.md, section « Mario Clash ». La clôture réelle
// (computeCloture) est réutilisée ; les effets de véhicule sont ajoutés
// autour (dé, sorts, cases spéciales, boutique, bouclier).
//
// Chaque course : N joueurs, véhicule tiré au hasard parmi les candidats,
// profils de joueurs variés (assiduité, usage des sorts, boutique, choix du
// dé). Mesure : taux de victoire de chaque véhicule rapporté à la part
// équitable (1 / N), et position finale moyenne.
//
// Usage : node --import @clash/commun/testing/registerFakeRedis.js \
//   jeux/outils/marioclash-simulation/simulerVehicules.mjs [courses=20000] [joueurs=12]
// ============================================================

import fs from "node:fs";
import {
  computeCloture,
  rollDieOfType,
  applyCaseSpeciale,
  clampPosition,
  sortsDisponibles,
  ciblesObjet,
  estArrive,
} from "../../services/marioclash.js";

const COURSES = Number(process.argv[2]) || 20000;
const NB_JOUEURS = Number(process.argv[3]) || 12;
const config = JSON.parse(
  fs.readFileSync(new URL("../../data/marioclash/marioclash.json", import.meta.url), "utf-8"),
);

// Générateur reproductible (mulberry32)
function rngDe(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Véhicules ───────────────────────────────────────────────────────
// Ceux de la config (config.vehicules), plus des candidats à tester
// (CANDIDATS, même format que la config, plus `cases` : filtre des cases
// spéciales appliquées, `bouclier` : nombre de Bombes/Carapaces reçues
// annulées, `objets_interdits`). Tous courent ensemble : l'indice de
// chacun reste comparable (rapporté à la part équitable).
const CANDIDATS = {
  // quatre: {
  //   label: "4×4 (ignore Feu/Glace/Turbo inversé, Turbos inactifs)",
  //   cases: (c) => !(c.avance < 0 || c.or < 0) && !(c.avance > 0),
  // },
  // diligence: { label: "Diligence", bouclier: 1, objets_interdits: ["etoile"] },
};
const VEHICULES = { ...config.vehicules, ...CANDIDATS };
const IDS = Object.keys(VEHICULES);

function deDuVehicule(v, deId) {
  const base = config.des[deId];
  return v.des?.[deId] ? { ...base, ...v.des[deId] } : base;
}

function caseApplicable(v, position) {
  const c = config.cases_speciales?.[position];
  if (!c) return true;
  return v.cases ? v.cases(c) : true;
}

// ── Profils de joueurs ──────────────────────────────────────────────
// assiduite : probabilité de jouer un jour donné ; sort : "toujours" ou
// "concentre" (attend la Concentration max) ; boutique : 0 à 1 (envie
// d'acheter) ; de : "malin" (espérance avec cases) ou "classique".
const PROFILS = [
  { assiduite: 0.95, sort: "concentre", boutique: 0.9, de: "malin" },
  { assiduite: 0.9, sort: "toujours", boutique: 0.7, de: "malin" },
  { assiduite: 0.75, sort: "toujours", boutique: 0.5, de: "classique" },
  { assiduite: 0.6, sort: "toujours", boutique: 0.3, de: "classique" },
];

// Espérance d'un dé (avance nette + valeur de l'Or) pour le joueur.
const VALEUR_OR = 1;
const orBonus = (v, jour) => (jour % 2 === 0 ? v.or_jours_pairs || 0 : 0);
function esperanceDe(v, joueur, deId, jour) {
  const de = deDuVehicule(v, deId);
  const faces = Array.isArray(de.faces) ? de.faces : Array.from({ length: de.max - de.min + 1 }, (_, k) => de.min + k);
  let total = 0;
  for (const f of faces) {
    const avance = joueur.gel ? 1 : f + (joueur.rage || 0);
    const pos = clampPosition(joueur.position + avance, config.case_arrivee);
    let net = pos - joueur.position;
    let or = de.or + orBonus(v, jour);
    const c = config.cases_speciales?.[pos];
    if (c && avance > 0 && caseApplicable(v, pos)) {
      net += c.avance || 0;
      or += c.or || 0;
    }
    total += net + VALEUR_OR * or;
  }
  return total / faces.length;
}

function lancerDe(v, joueur, profil, rng, jour) {
  let deId;
  if (joueur.deImpose && config.des[joueur.deImpose]) deId = joueur.deImpose;
  else if (profil.de === "classique") deId = "classique";
  else {
    const choix = Object.keys(config.des).filter((id) => !config.des[id].reserve_sort);
    deId = choix.reduce((a, b) => (esperanceDe(v, joueur, b, jour) > esperanceDe(v, joueur, a, jour) ? b : a));
  }
  const de = deDuVehicule(v, deId);
  const valeur = rollDieOfType(de, rng);
  const avance = joueur.gel ? 1 : valeur + (joueur.rage || 0);
  const positionDe = clampPosition(joueur.position + avance, config.case_arrivee);
  const or = joueur.points + de.or + orBonus(v, jour);
  const r =
    avance > 0 && caseApplicable(v, positionDe)
      ? applyCaseSpeciale(positionDe, or, config)
      : { position: positionDe, points: or };
  Object.assign(joueur, { position: r.position, points: r.points, gel: false, rage: 0, deImpose: null });
  if (r.position >= config.case_arrivee) joueur.arriveJour = jour;
  return { dice: true, diceValue: valeur, diceAvance: avance, deId };
}

function lancerSort(v, joueur, rng) {
  const conc = Math.max(v.concentration_min || 0, joueur.concentration || 0);
  const dispo = sortsDisponibles(config.sorts, conc).filter((s) => !(v.sorts_retires || []).includes(s.id));
  const sort = dispo[Math.floor(rng() * dispo.length)];
  joueur.concentration = 0;
  return { target: null, sortId: sort.id };
}

// Achat (un par jour) : renvoie { target } ou null ; débite l'Or.
function acheter(v, id, joueurs, profil, rng) {
  const joueur = joueurs[id];
  if (rng() > profil.boutique) return null;
  const permis = (o) => !(v.objets_interdits || []).includes(o) && joueur.points >= config.objets[o].cout;
  const actifs = Object.entries(joueurs).filter(([, j]) => !estArrive(j, config));
  const tri = actifs.sort((a, b) => b[1].position - a[1].position);
  const rang = tri.findIndex(([jid]) => jid === id);
  const leader = tri[0];
  const ecartLeader = leader ? leader[1].position - joueur.position : 0;
  let choix = null;
  let target = null;
  if (rang > 0 && ecartLeader >= 5 && permis("carapace") && rng() < 0.5) choix = "carapace";
  else if (permis("banane")) {
    const cibles = ciblesObjet(joueurs, id, config.objets.banane, config);
    const meilleure = cibles
      .map((c) => [c.discordId, joueurs[c.discordId].position - joueur.position])
      .sort((a, b) => b[1] - a[1])[0];
    if (meilleure && meilleure[1] >= 5) [choix, target] = ["banane", meilleure[0]];
  }
  if (!choix && rang <= 1 && permis("etoile") && rng() < 0.35) choix = "etoile";
  if (!choix && permis("accelerateur") && (rng() < 0.65 || !permis("bombe"))) choix = "accelerateur";
  if (!choix && permis("bombe")) {
    const devant = tri.filter(([jid, j]) => jid !== id && j.position > joueur.position);
    const cible = devant.length ? devant[devant.length - 1] : tri.find(([jid]) => jid !== id);
    if (cible) [choix, target] = ["bombe", cible[0]];
  }
  if (!choix) return null;
  joueur.points -= config.objets[choix].cout;
  joueur.objet = choix;
  return { target };
}

function course(rng) {
  const joueurs = {};
  const meta = {};
  for (let i = 0; i < NB_JOUEURS; i++) {
    const id = `j${i}`;
    joueurs[id] = { username: id, position: 0, points: 0, objet: null, concentration: 0, colorIndex: i };
    meta[id] = {
      vehicule: IDS[Math.floor(rng() * IDS.length)],
      profil: PROFILS[Math.floor(rng() * PROFILS.length)],
      bouclier: 0,
    };
    meta[id].bouclier = VEHICULES[meta[id].vehicule].bouclier || 0;
  }
  for (let jour = 1; jour <= config.duree_jours; jour++) {
    const actions = {};
    const ordre = Object.keys(joueurs).sort(() => rng() - 0.5);
    for (const id of ordre) {
      const j = joueurs[id];
      const { profil, vehicule } = meta[id];
      const v = VEHICULES[vehicule];
      if (estArrive(j, config) || rng() > profil.assiduite) continue;
      const a = lancerDe(v, j, profil, rng, jour);
      if (!estArrive(j, config)) {
        const max = config.concentration_max ?? 0;
        const conc = Math.max(v.concentration_min || 0, j.concentration || 0);
        if (profil.sort === "toujours" || conc >= max) a.spell = lancerSort(v, j, rng);
        const item = acheter(v, id, joueurs, profil, rng);
        if (item) a.item = item;
      }
      actions[id] = a;
    }
    const { joueursApres, lignes } = computeCloture({ actionsRaw: actions, joueursAvant: joueurs, config, jour, rng });
    // Bouclier (Diligence) : 1re Bombe/Carapace reçue annulée.
    for (const l of lignes) {
      if (l.type !== "objet" || l.effet !== "recul" || !meta[l.cibleId]?.bouclier) continue;
      meta[l.cibleId].bouclier--;
      const c = joueursApres[l.cibleId];
      c.position = clampPosition(c.position + l.valeur, config.case_arrivee);
    }
    Object.assign(joueurs, joueursApres);
  }
  // Classement : arrivés par jour d'arrivée, puis position.
  const cle = (j) => (j.arriveJour != null ? 1000 - j.arriveJour : j.position);
  const meilleur = Math.max(...Object.values(joueurs).map(cle));
  const gagnants = Object.keys(joueurs).filter((id) => cle(joueurs[id]) === meilleur);
  return { joueurs, meta, gagnants };
}

// ── Agrégation ──────────────────────────────────────────────────────
const stats = Object.fromEntries(IDS.map((id) => [id, { n: 0, victoires: 0, position: 0, arrives: 0 }]));
const rng = rngDe(20261122);
for (let c = 0; c < COURSES; c++) {
  const { joueurs, meta, gagnants } = course(rng);
  for (const [id, j] of Object.entries(joueurs)) {
    const s = stats[meta[id].vehicule];
    s.n++;
    s.position += j.position;
    if (estArrive(j, config)) s.arrives++;
    if (gagnants.includes(id)) s.victoires += 1 / gagnants.length;
  }
}

console.log(`${COURSES} courses, ${NB_JOUEURS} joueurs, véhicule tiré au hasard\n`);
console.log("Indice de victoire = taux de victoire / part équitable (1 = équilibré)\n");
for (const id of IDS) {
  const s = stats[id];
  const indice = s.victoires / s.n / (1 / NB_JOUEURS);
  console.log(
    `${VEHICULES[id].label.padEnd(70)} indice ${indice.toFixed(2)}  position moy. ${(s.position / s.n).toFixed(1)}  arrivés ${((100 * s.arrives) / s.n).toFixed(1)} %`,
  );
}
