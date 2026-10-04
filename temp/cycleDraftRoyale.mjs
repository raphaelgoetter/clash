// Cycle complet de 7 jours en mémoire (sans Redis) : vérifie le nombre de
// cartes en main chaque soir et le classement final du Draft Royale.
import { loadDraftRoyaleConfig, loadCatalog, tirerCarte, computeCloture, cartesSouhaitables, depotDuJour, cartesDeDepart } from "../backend/services/draftroyale.js";
const config = await loadDraftRoyaleConfig();
const catalog = await loadCatalog();
const joueurs = {};
for (const id of ["a", "b", "c", "d"]) {
  const main = [];
  for (let i = 0; i < cartesDeDepart(1, config); i++) main.push(tirerCarte(main, catalog));
  joueurs[id] = { username: id.toUpperCase(), main, depots: [], popularite: 0, arrivee: Object.keys(joueurs).length, contrat: null };
}
let marcheVeille = [];
let etat = joueurs;
for (let jour = 1; jour <= config.duree_jours; jour++) {
  const actionsRaw = {};
  for (const [id, j] of Object.entries(etat)) {
    j.main.push(tirerCarte([...j.main, ...j.depots.map((d) => d.key)], catalog));
    if (depotDuJour(j, jour - 1)) actionsRaw[id] = { voeux: cartesSouhaitables(marcheVeille, j, jour).slice(0, 3) };
    // "d" ne dépose jamais
    if (id !== "d" && jour <= config.jour_dernier_depot) {
      const key = j.main.shift();
      j.depots.push({ key, jour, at: new Date(Date.now() + jour).toISOString() });
    }
  }
  const r = computeCloture({ jour, joueursAvant: etat, actionsRaw, marcheVeille, config, catalog });
  etat = r.joueursApres;
  marcheVeille = r.marcheJour;
  console.log(`J${jour} soir :`, Object.entries(etat).map(([id, j]) => `${id}=${j.main.length}`).join(" "), `marché=${r.marcheJour.length}`);
  if (r.final) for (const x of r.final) console.log(`  ${x.username} ${x.score} pts, deck ${x.deck.length}, pop ${x.popularite} :`, x.details.map((d) => `${d.label} +${d.points}`).join(", "));
}
