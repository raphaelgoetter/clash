// Jours pour démasquer une cible si une accusation ratée renvoie un indice :
// "nb" = nombre de caractéristiques communes, "quelles" = lesquelles.
// Chaque jour : 1 question (pool du jour) puis 1 accusation (carte choisie
// pour maximiser l'information, ou la seule restante). Taille de grille en argument.
import fs from "fs";
import { completerCartes, profil, tirerGrille, QIDS } from "../../services/quiestceRules.js";
const config = JSON.parse(fs.readFileSync("jeux/data/quiestce/quiestce.json", "utf8"));
const cartes = completerCartes(JSON.parse(fs.readFileSync("jeux/data/cardNames.json", "utf8")), config.complements);
const taille = Number(process.argv[2] || 30);
const score = (cs, f) => { const m = {}; cs.forEach((c) => { const v = f(c); m[v] = (m[v] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };
const communs = (a, b) => QIDS.filter((q) => a.p[q] === b.p[q]);
for (const mode of ["aucun", "nb", "quelles"]) {
  const jours = {}; let n = 0; let erreurs = 0;
  for (let g = 0; g < 300; g++) {
    const grille = tirerGrille(cartes, taille).map((c) => ({ k: c.cardKey, p: profil(c) }));
    for (const cible of grille) {
      const jour0 = 1 + Math.floor(Math.random() * 5);
      let cs = grille.slice(); const connues = new Set(); let d = 0; let trouve = false;
      while (!trouve && d < 8) {
        const jour = ((jour0 - 1 + d) % 7) + 1; d++;
        let pool = config.pool[jour].filter((x) => !connues.has(x));
        if (!pool.length) pool = QIDS.filter((x) => !connues.has(x));
        if (pool.length && cs.length > 1) {
          const q = pool.map((x) => [x, score(cs, (c) => c.p[x])]).sort((a, b) => a[1] - b[1])[0][0];
          connues.add(q); cs = cs.filter((c) => c.p[q] === cible.p[q]);
        }
        // Accusation : sans indice, seulement si certain ; avec indice, chaque jour
        if (mode === "aucun" && cs.length > 1) continue;
        const choix = mode === "aucun" || cs.length === 1 ? cs[0]
          : cs.map((a) => [a, score(cs, (c) => (mode === "nb" ? communs(a, c).length : communs(a, c).join("|")))]).sort((x, y) => x[1] - y[1])[0][0];
        if (choix === cible) { trouve = true; break; }
        erreurs++;
        const fb = mode === "nb" ? communs(choix, cible).length : communs(choix, cible).join("|");
        cs = cs.filter((c) => c !== choix && (mode === "nb" ? communs(choix, c).length : communs(choix, c).join("|")) === fb);
      }
      jours[d] = (jours[d] || 0) + 1; n++;
    }
  }
  const moy = Object.entries(jours).reduce((a, [k, v]) => a + k * v, 0) / n;
  console.log(`grille ${taille}, indice ${mode.padEnd(7)} : jours pour démasquer ${Object.entries(jours).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}j:${(100 * v / n).toFixed(0)}%`).join(" ")} | moyenne ${moy.toFixed(2)} j | accusations ratées/cible ${(erreurs / n).toFixed(2)}`);
}
