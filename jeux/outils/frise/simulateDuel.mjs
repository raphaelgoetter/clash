// Simulation de Frise : un joueur fictif contre Kévina, sur les vraies
// cartes. Le joueur place juste avec une probabilité qui baisse quand la
// carte tombe près de ses voisines (même modèle que Kévina, avec son propre
// réglage), en jouant une carte au hasard ou la plus sûre.
// Usage : node jeux/outils/frise/simulateDuel.mjs [parties] [erreurKevina] [echelleKevina]
// Affiche, pour plusieurs profils de joueurs, le taux de victoire du joueur
// et le taux d'erreur de chacun.
import fs from "fs";
import { choisir, choixKevina, creerDuel, placer, probaErreurKevina } from "../../services/friseRules.js";

const cartes = JSON.parse(fs.readFileSync(new URL("../../data/frise/cartes.json", import.meta.url)));
const config = JSON.parse(fs.readFileSync(new URL("../../data/frise/duel.json", import.meta.url)));
const parties = Number(process.argv[2] ?? 2000);
const kevina = {
  erreur: Number(process.argv[3] ?? config.erreur_kevina),
  echelle: Number(process.argv[4] ?? config.echelle_kevina),
};

// Profils de joueurs : même formule d'erreur, carte la plus sûre ou au hasard
// (une échelle plus grande = plus d'erreurs, même à grand écart)
const PROFILS = {
  "débutant (au hasard)": { erreur: 1, echelle: 40, malin: false },
  "moyen": { erreur: 0.9, echelle: 30, malin: true },
  "bon": { erreur: 0.7, echelle: 20, malin: true },
  "très bon": { erreur: 0.5, echelle: 12, malin: true },
};

function coupJoueur(d, p) {
  if (p.malin) return choixKevina(d, "joueur", p);
  const index = Math.floor(Math.random() * d.mains.joueur.length);
  const annee = d.mains.joueur[index].annee;
  const bon = d.frise.findIndex((c) => c.annee > annee);
  const juste = bon === -1 ? d.frise.length : bon;
  if (Math.random() >= probaErreurKevina(d, annee, p)) return { index, creneau: juste };
  const voisins = [juste - 1, juste + 1].filter((c) => c >= 0 && c <= d.frise.length);
  return { index, creneau: voisins[Math.floor(Math.random() * voisins.length)] };
}

console.log(`Kévina : erreur ${kevina.erreur}, échelle ${kevina.echelle} (${parties} parties par profil)`);
for (const [nom, p] of Object.entries(PROFILS)) {
  const res = { joueur: 0, bot: 0, nul: 0 };
  const coups = { joueur: [0, 0], bot: [0, 0] };
  for (let g = 0; g < parties; g++) {
    const d = creerDuel(cartes, { tailleMain: config.taille_main, ecartMin: config.ecart_min_annees });
    while (!d.termine) {
      const id = d.actif;
      const k = id === "bot" ? choixKevina(d, "bot", kevina) : coupJoueur(d, p);
      choisir(d, id, k.index);
      const r = placer(d, id, k.creneau);
      coups[id][0]++;
      if (!r.juste) coups[id][1]++;
    }
    res[d.gagnant]++;
  }
  const pct = (n, t) => `${Math.round((100 * n) / t)} %`;
  console.log(
    `${nom.padEnd(22)} victoires joueur ${pct(res.joueur, parties).padStart(5)} · nuls ${pct(res.nul, parties).padStart(4)} · erreurs joueur ${pct(coups.joueur[1], coups.joueur[0])}, Kévina ${pct(coups.bot[1], coups.bot[0])}`,
  );
}
