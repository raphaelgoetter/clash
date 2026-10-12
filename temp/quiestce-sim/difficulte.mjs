// Difficulté de chaque carte : nombre moyen d'indices (indice de départ
// compris) pour l'identifier à coup sûr, sur des grilles tirées au hasard,
// avec le vrai calendrier de questions et un choix de question optimal.
// Usage : node temp/quiestce-sim/difficulte.mjs [grilles]
import fs from "fs";
import * as R from "../../backend/services/quiestceRules.js";
const CONFIG = JSON.parse(fs.readFileSync("data/quiestce/quiestce.json", "utf8"));
const CARTES = R.completerCartes(JSON.parse(fs.readFileSync("data/cardNames.json", "utf8")), CONFIG.complements);
const GRILLES = Number(process.argv[2] || 3000);
const score = (cs, q) => { const m = {}; cs.forEach((c) => { m[c.p[q]] = (m[c.p[q]] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };
const stats = {};
for (let g = 0; g < GRILLES; g++) {
  const grille = R.tirerGrille(CARTES, CONFIG.taille_grille).map((c) => ({ k: c.cardKey, fr: c.fr, p: R.profil(c) }));
  for (const cible of grille) {
    const jour0 = 1 + Math.floor(Math.random() * 6);
    const connues = new Set();
    // Indice de départ : au hasard hors questions du jour (Loupe comprise)
    const exclues = [...CONFIG.pool[jour0], CONFIG.pool_loupe[jour0]];
    const horsJour = R.QIDS.filter((q) => !exclues.includes(q));
    const q0 = horsJour[Math.floor(Math.random() * horsJour.length)];
    connues.add(q0);
    let cs = grille.filter((c) => c.p[q0] === cible.p[q0]);
    let d = 0;
    while (cs.length > 1 && connues.size < 6) {
      const jour = ((jour0 - 1 + d) % 7) + 1; d++;
      let pool = CONFIG.pool[jour].filter((q) => !connues.has(q));
      if (!pool.length) pool = R.QIDS.filter((q) => !connues.has(q));
      const q = pool.sort((a, b) => score(cs, a) - score(cs, b))[0];
      connues.add(q);
      cs = cs.filter((c) => c.p[q] === cible.p[q]);
    }
    const s = (stats[cible.k] ||= { fr: cible.fr, n: 0, indices: 0, un: 0, deux: 0 });
    s.n++; s.indices += connues.size;
    if (connues.size === 1) s.un++;
    if (connues.size <= 2) s.deux++;
  }
}
const liste = Object.values(stats).filter((s) => s.n >= 50).map((s) => ({ ...s, moy: s.indices / s.n }));
liste.sort((a, b) => a.moy - b.moy);
const ligne = (s) => `${s.fr.padEnd(26)} ${s.moy.toFixed(2)} indices · trouvée dès l'indice de départ ${(100 * s.un / s.n).toFixed(0).padStart(2)}% · en 2 indices max ${(100 * s.deux / s.n).toFixed(0).padStart(3)}%`;
console.log(`${liste.length} cartes jouables, moyenne générale ${(liste.reduce((a, s) => a + s.moy, 0) / liste.length).toFixed(2)} indices\n\nLes plus faciles :`);
liste.slice(0, 12).forEach((s) => console.log("  " + ligne(s)));
console.log("\nLes plus difficiles :");
liste.slice(-12).reverse().forEach((s) => console.log("  " + ligne(s)));
