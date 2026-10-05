// Simulation d'équilibrage du Draft (carré de 4 cartes identiques) : nombre de
// carrés par partie, part des cartes disputées perdues, scores.
// Usage : node temp/simulateDraft.mjs
import { distribuer, computeTour, choixGlouton, choisirFamilles, nbFamilles, plusGrandGroupe, classement } from "../backend/services/draftRules.js";
const config = { exemplaires: 5, taille_main: 4, points_carre: 10 };
const catalog = new Map(Array.from({ length: 120 }, (_, i) => [`c${i}`, {}]));
function partie(P, F, tours, participation) {
  const familles = choisirFamilles(F, catalog);
  const ids = Array.from({ length: P }, (_, i) => `p${i}`);
  const d = distribuer({ familles, joueurIds: ids, config });
  let joueurs = Object.fromEntries(ids.map((id, i) => [id, { main: d.mains[id], popularite: 0, points: 0, carres: 0, arrivee: i }]));
  let marche = d.marche;
  let manches = 0, disputes = 0, perdues = 0, echanges = 0, maxDebut = 0;
  for (const id of ids) maxDebut += plusGrandGroupe(joueurs[id].main);
  for (let t = 1; t <= tours; t++) {
    const actions = {};
    for (const id of ids) if (Math.random() < participation) actions[id] = choixGlouton(joueurs[id].main, marche);
    const r = computeTour({ joueursAvant: joueurs, actions, marche, familles, config, dernier: t === tours });
    joueurs = r.joueurs; marche = r.marche;
    echanges += r.lignes.length; disputes += r.lignes.filter(l => l.disputee).length; perdues += r.lignes.filter(l => l.type === "perdue").length;
    if (r.carres.length && t < tours) manches++;
  }
  const c = classement(joueurs);
  return { manches, perdues: perdues / Math.max(1, echanges), top: c[0].score, med: c[Math.floor(P / 2)].score, carres: c.reduce((s, x) => s + x.carres, 0), maxDebut: maxDebut / P, marche: marche.length };
}
function bilan(label, P, F, tours, participation, N = 2000) {
  const acc = { manches: 0, perdues: 0, top: 0, med: 0, carres: 0, maxDebut: 0 };
  const dist = {};
  for (let i = 0; i < N; i++) { const r = partie(P, F, tours, participation); for (const k in acc) acc[k] += r[k]; dist[r.manches] = (dist[r.manches] || 0) + 1; }
  for (const k in acc) acc[k] = +(acc[k] / N).toFixed(2);
  console.log(label.padEnd(34), `marché ${5 * F - 4 * P}`.padEnd(11), JSON.stringify(acc), "carrés avant fin:", JSON.stringify(Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, Math.round(v / N * 100) + "%"]))));
}
console.log("— Duel (7 manches, tous jouent)");
for (const P of [2, 3]) for (const F of [P, P + 1, P + 2, 6]) bilan(`P=${P} F=${F}`, P, F, 7, 1);
console.log("— Royale (7 jours)");
for (const P of [8, 15, 20]) for (const part of [1, 0.7, 0.5]) bilan(`P=${P} F=${nbFamilles(P, { min: 6, en_plus: 0 })} participation ${part}`, P, nbFamilles(P, { min: 6, en_plus: 0 }), 7, part, 500);
