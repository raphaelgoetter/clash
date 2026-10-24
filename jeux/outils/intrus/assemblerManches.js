#!/usr/bin/env node
// assemblerManches.js
// Reconstruit intrus.json à partir de zéro depuis le catalogue d'objets
// (objets.json + icônes), avec les critères visuels de analyseObjets.js :
//
// - 3 objets d'un même jeu + 1 intrus d'un autre jeu, tous du même style
//   (`style` manuel, sinon style détecté) et de netteté comparable (rapport
//   max/min < 3,5) ;
// - jamais d'intrus repérable à l'œil (intrusVisible : trio de variantes
//   quasi identiques, forme à part) ; parmi les intrus valides, le plus
//   proche visuellement du trio est retenu ;
// - noms : jamais affichés dans le post (image seule), seulement à la
//   réponse ; seul garde-fou, aucun homonyme de l'intrus dans le jeu du trio ;
// - objets exclus (`exclu`) jamais utilisés, chaque objet au plus une fois ;
// - variété : au plus N manches par jeu (trio) et par jeu intrus, au plus 2
//   par couple (jeu, jeu intrus) au-delà de 2, jamais deux manches consécutives sur le
//   même jeu.
// Difficulté déduite de la proximité visuelle de l'intrus (plus il se fond
// dans le trio, plus c'est difficile), par quartiles.
//
// ⚠️ L'unicité « réelle » de l'intrus (l'objet n'existe pas aussi dans le jeu
// du trio) n'est vérifiée que par homonymie dans le catalogue : relire les
// manches dans la démo (npm run intrus:demo) avant publication.
//
// Usage :
//   node jeux/outils/intrus/assemblerManches.js              — écrit intrus.json (ancien fichier et décisions archivés)
//   node jeux/outils/intrus/assemblerManches.js --dry-run    — statistiques seulement
//   node jeux/outils/intrus/assemblerManches.js --cible 60   — nombre de manches visé (60 par défaut)
//   node jeux/outils/intrus/assemblerManches.js --max-jeu 3  — manches max par jeu et par rôle (sinon relâché jusqu'à la cible)
//   node jeux/outils/intrus/assemblerManches.js --max-apparitions 4
//                                                   — planches max où figure un même jeu (trio + intrus, 5 par défaut)
//   node jeux/outils/intrus/assemblerManches.js --conserver-validees
//                                                   — garde en tête les manches validées dans la démo (décisions conservées),
//                                                     ne régénère que les autres

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { analyserIcone, intrusVisible, distMixte, distSilhouette, SEUILS_INTRUS_VISIBLE, STYLES } from "./analyseObjets.js";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";
import { categorieDe, categorieDuTrio } from "./categories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(ROOT, "jeux", "data", "jeux-visuels", "intrus");
const OBJETS_PATH = path.join(DATA_DIR, "objets.json");
const MANCHES_PATH = path.join(DATA_DIR, "intrus.json");
const PLANCHES_DIR = path.join(ROOT, "temp", "intrus-planches");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const argNum = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i === -1 ? defaut : Number.parseInt(args[i + 1], 10);
};
const CIBLE = argNum("--cible", 60);
const MAX_JEU = argNum("--max-jeu", null);
const MAX_APPARITIONS = argNum("--max-apparitions", 5);
const CONSERVER = args.includes("--conserver-validees");
const DECISIONS_PATH = path.join(PLANCHES_DIR, "validation.json");

const NETTETE_RATIO_MAX = 3.5;
const VOISINS = 6; // trios candidats : chaque objet + 2 de ses plus proches voisins
const INTRUS_TESTES = 12; // intrus candidats évalués par trio, du plus proche au plus loin
const INTRUS_PAR_TRIO = 4; // intrus valides gardés par trio (alternatives pour la sélection)
const MAX_PAR_COUPLE = 2; // manches max par couple (jeu, jeu intrus)
const DIFFICULTES = ["expert", "difficile", "intermediaire", "facile"];

function combinaisons3(liste) {
  const res = [];
  for (let i = 0; i < liste.length; i++)
    for (let j = i + 1; j < liste.length; j++) for (let k = j + 1; k < liste.length; k++) res.push([liste[i], liste[j], liste[k]]);
  return res;
}

function ordonner(manches, precedente = null) {
  // Alterne les difficultés, jamais deux manches de suite sur le même jeu.
  const patron = ["intermediaire", "facile", "difficile", "expert", "intermediaire", "difficile", "expert", "difficile"];
  const reste = [...manches];
  const ordre = [];
  for (let i = 0; reste.length; i++) {
    const prev = ordre.at(-1) ?? precedente;
    const ok = (m) => !prev || (m.jeu !== prev.jeu && m.jeu !== prev.jeuIntrus && m.jeuIntrus !== prev.jeu);
    const k = [reste.findIndex((m) => m.difficulte === patron[i % patron.length] && ok(m)), reste.findIndex(ok), 0].find((x) => x >= 0);
    ordre.push(reste.splice(k, 1)[0]);
  }
  return ordre;
}

async function main() {
  const objets = JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
  const analyses = new Map();
  for (const o of objets) analyses.set(o.id, analyserIcone(await fs.readFile(path.join(DATA_DIR, "images", o.image))));
  // Familles de style : pixel art et icônes carrées sont nets à détecter ;
  // aplat et peint se recouvrent trop (détection indicative), la distance
  // visuelle départage.
  const FAMILLES = { pixel: "pixel", carree: "carree", aplat: "illustre", peint: "illustre" };
  const styleDe = (o) => FAMILLES[o.style ?? analyses.get(o.id).styleAuto];
  const net = (o) => Math.max(analyses.get(o.id).nettete, 0.01);
  const sig = (o) => analyses.get(o.id).signature;

  const eligibles = objets.filter((o) => !o.exclu);
  const ecartes = objets.length - eligibles.length;
  const nomsParJeu = new Map();
  for (const o of objets) {
    if (!nomsParJeu.has(o.jeu)) nomsParJeu.set(o.jeu, new Set());
    nomsParJeu.get(o.jeu).add(normalizeAnswer(o.nom));
  }

  // Groupes (jeu, style) et voisins visuels.
  const groupes = new Map();
  for (const o of eligibles) {
    const cle = `${o.jeu}\u0000${styleDe(o)}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(o);
  }
  const parStyle = new Map();
  for (const o of eligibles) {
    if (!parStyle.has(styleDe(o))) parStyle.set(styleDe(o), []);
    parStyle.get(styleDe(o)).push(o);
  }

  const candidats = [];
  for (const groupe of groupes.values()) {
    if (groupe.length < 3) continue;
    const trios = new Map();
    if (groupe.length <= 12) {
      for (const t of combinaisons3(groupe)) trios.set(t.map((o) => o.id).sort().join("|"), t);
    } else {
      for (const o of groupe) {
        const voisins = groupe
          .filter((v) => v !== o)
          .map((v) => ({ v, d: distMixte(sig(o), sig(v)) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, VOISINS)
          .map((x) => x.v);
        for (const [a, b] of combinaisons3([o, ...voisins]).filter((t) => t[0] === o).map((t) => [t[1], t[2]])) {
          const t = [o, a, b];
          trios.set(t.map((x) => x.id).sort().join("|"), t);
        }
      }
    }

    for (const trio of trios.values()) {
      const nets = trio.map(net);
      if (Math.max(...nets) / Math.min(...nets) >= NETTETE_RATIO_MAX) continue;
      const s = trio.map(sig);
      const silTrio = (distSilhouette(s[0], s[1]) + distSilhouette(s[0], s[2]) + distSilhouette(s[1], s[2])) / 3;
      const carrees = s.every((x) => x.silhouette.every((v) => v >= 0.9));
      if (!carrees && silTrio < SEUILS_INTRUS_VISIBLE.trioClone) continue;
      const jeu = trio[0].jeu;
      const categorieTrio = categorieDuTrio(trio) ?? "\u0000";

      const intrusPossibles = parStyle
        .get(styleDe(trio[0]))
        .filter((i) => i.jeu !== jeu)
        .filter((i) => !nomsParJeu.get(jeu).has(normalizeAnswer(i.nom)))
        .filter((i) => {
          const tous = [...nets, net(i)];
          return Math.max(...tous) / Math.min(...tous) < NETTETE_RATIO_MAX;
        })
        .map((i) => ({ i, d: s.reduce((acc, x) => acc + distMixte(sig(i), x), 0) / 3, cat: categorieDe(i) === categorieTrio }))
        // Même catégorie que le trio d'abord (une baie parmi des baies),
        // puis le plus proche visuellement.
        .sort((a, b) => b.cat - a.cat || a.d - b.d)
        .slice(0, INTRUS_TESTES);

      let retenus = 0;
      for (const { i } of intrusPossibles) {
        const verdict = intrusVisible([sig(i), ...s]);
        if (verdict.raisons.length) continue;
        candidats.push({ trio, intrus: i, style: styleDe(i), rapport: verdict.rapportStructure });
        if (++retenus >= INTRUS_PAR_TRIO) break;
      }
    }
  }

  // Sélection gloutonne, caps par jeu relâchés progressivement jusqu'à
  // atteindre la cible. Les jeux qui ont peu d'objets éligibles passent
  // d'abord (peu de trios possibles), puis l'intrus le mieux fondu.
  const tailleJeu = new Map();
  for (const o of eligibles) tailleJeu.set(o.jeu, (tailleJeu.get(o.jeu) ?? 0) + 1);
  candidats.sort((a, b) => tailleJeu.get(a.trio[0].jeu) - tailleJeu.get(b.trio[0].jeu) || a.rapport - b.rapport);
  // Manches validées dans la démo, gardées telles quelles : leurs objets et
  // leurs jeux comptent dans les plafonds.
  const decisions = (await fs.readFile(DECISIONS_PATH, "utf-8").then(JSON.parse, () => ({}))).decisions ?? {};
  const gardees = CONSERVER
    ? JSON.parse(await fs.readFile(MANCHES_PATH, "utf-8")).filter(
        (m) => decisions[`i${String(m.numero).padStart(3, "0")}`]?.statut === "valide",
      )
    : [];
  const incr = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

  let choisies = [];
  for (let cap = MAX_JEU ?? 2; cap <= (MAX_JEU ?? 8); cap++) {
    choisies = [];
    const utilises = new Set(gardees.flatMap((m) => [m.intrus, ...m.objets]));
    const parJeu = new Map();
    const parIntrus = new Map();
    const apparitions = new Map();
    const couples = new Map();
    for (const m of gardees) {
      incr(parJeu, m.jeu);
      incr(parIntrus, m.jeuIntrus);
      incr(apparitions, m.jeu);
      incr(apparitions, m.jeuIntrus);
      incr(couples, `${m.jeu}\u0000${m.jeuIntrus}`);
    }
    for (const c of candidats) {
      if (gardees.length + choisies.length >= CIBLE) break;
      const ids = [c.intrus.id, ...c.trio.map((o) => o.id)];
      const jeu = c.trio[0].jeu;
      const couple = `${jeu}\u0000${c.intrus.jeu}`;
      if (ids.some((id) => utilises.has(id)) || (couples.get(couple) ?? 0) >= MAX_PAR_COUPLE) continue;
      if ((parJeu.get(jeu) ?? 0) >= cap || (parIntrus.get(c.intrus.jeu) ?? 0) >= cap) continue;
      if ((apparitions.get(jeu) ?? 0) >= MAX_APPARITIONS || (apparitions.get(c.intrus.jeu) ?? 0) >= MAX_APPARITIONS) continue;
      ids.forEach((id) => utilises.add(id));
      incr(couples, couple);
      incr(parJeu, jeu);
      incr(parIntrus, c.intrus.jeu);
      incr(apparitions, jeu);
      incr(apparitions, c.intrus.jeu);
      choisies.push(c);
    }
    console.log(`Max ${cap} manche(s) par jeu et par rôle : ${gardees.length + choisies.length} manches possibles.`);
    if (gardees.length + choisies.length >= CIBLE) break;
  }

  // Difficulté par quartile de rapport (le plus fondu = expert).
  const tries = [...choisies].sort((a, b) => a.rapport - b.rapport);
  const nouvelles = ordonner(
    tries.map((c, rang) => ({
      difficulte: DIFFICULTES[Math.min(3, Math.floor((rang / tries.length) * 4))],
      jeu: c.trio[0].jeu,
      jeuIntrus: c.intrus.jeu,
      theme: c.style === "illustre" ? "Illustré" : STYLES[c.style],
      objets: c.trio.map((o) => o.id),
      intrus: c.intrus.id,
      explication: `${c.intrus.nom} vient de ${c.intrus.jeu} ; les trois autres objets viennent de ${c.trio[0].jeu}.`,
    })),
  );
  // Tout est réordonné ensemble : retirer des manches entre deux validées
  // peut en rendre deux consécutives sur le même jeu. Les décisions des
  // manches gardées suivent leur nouveau numéro.
  const ordre = ordonner([...gardees, ...nouvelles]);
  const manches = ordre.map(({ numero, ...m }, i) => ({ numero: i + 1, ...m }));
  const decisionsGardees = Object.fromEntries(
    ordre.flatMap((m, i) =>
      gardees.includes(m) ? [[`i${String(i + 1).padStart(3, "0")}`, decisions[`i${String(m.numero).padStart(3, "0")}`]]] : [],
    ),
  );

  const jeux = new Set(manches.flatMap((m) => [m.jeu, m.jeuIntrus]));
  const parDiff = DIFFICULTES.map((d) => `${d} ${manches.filter((m) => m.difficulte === d).length}`).join(", ");
  console.log(`${objets.length} objets (${ecartes} exclus), ${candidats.length} manches candidates.`);
  console.log(`${manches.length} manches retenues dont ${gardees.length} validées conservées (${parDiff}), ${jeux.size} jeux représentés.`);
  if (manches.length < CIBLE) console.warn(`⚠️ Cible de ${CIBLE} manches non atteinte.`);
  if (DRY_RUN) return;

  const archive = path.join(PLANCHES_DIR, `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.mkdir(archive, { recursive: true });
  await fs.copyFile(MANCHES_PATH, path.join(archive, "intrus.json")).catch(() => {});
  await fs.rename(DECISIONS_PATH, path.join(archive, "validation.json")).catch(() => {});
  await fs.writeFile(MANCHES_PATH, JSON.stringify(manches, null, 2) + "\n", "utf-8");
  if (gardees.length) {
    const data = { updatedAt: new Date().toISOString(), decisions: decisionsGardees };
    await fs.writeFile(DECISIONS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
  console.log(`intrus.json réécrit ; ancien fichier et décisions archivés dans ${path.relative(ROOT, archive)}/.`);
}

main().catch((err) => {
  console.error("Échec de l'assemblage :", err.message);
  process.exit(1);
});
