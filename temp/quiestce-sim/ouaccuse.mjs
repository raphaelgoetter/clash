// Variante : chaque jour, UNE action au choix — question (pool du jour) OU
// accusation (indice = nombre de caractéristiques communes si ratée).
// Profils : "prudent" n'accuse qu'à coup sûr ; "audacieux" accuse dès que
// l'accusation informe autant qu'une question (ou à 3 cartes ou moins).
import fs from "fs";
import { completerCartes, profil, tirerGrille, QIDS } from "../../backend/services/quiestceRules.js";
const config = JSON.parse(fs.readFileSync("data/quiestce/quiestce.json", "utf8"));
const cartes = completerCartes(JSON.parse(fs.readFileSync("data/cardNames.json", "utf8")), config.complements);
const taille = Number(process.argv[2] || 30);
const mode = process.argv[3] || "nb";
const score = (cs, f) => { const m = {}; cs.forEach((c) => { const v = f(c); m[v] = (m[v] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };
const fbOf = (a, b) => { const c = QIDS.filter((q) => a.p[q] === b.p[q]); return mode === "nb" ? c.length : c.join("|"); };
for (const profilJ of ["prudent", "audacieux"]) {
  const jours = {}; let n = 0; let erreurs = 0;
  for (let g = 0; g < 300; g++) {
    const grille = tirerGrille(cartes, taille).map((c) => ({ k: c.cardKey, p: profil(c) }));
    for (const cible of grille) {
      const jour0 = 1 + Math.floor(Math.random() * 5);
      let cs = grille.slice(); const connues = new Set(); let d = 0; let trouve = false;
      while (!trouve && d < 9) {
        const jour = ((jour0 - 1 + d) % 7) + 1; d++;
        let pool = config.pool[jour].filter((x) => !connues.has(x));
        if (!pool.length) pool = QIDS.filter((x) => !connues.has(x));
        const q = pool.length ? pool.map((x) => [x, score(cs, (c) => c.p[x])]).sort((a, b) => a[1] - b[1])[0] : null;
        const acc = cs.map((a) => [a, score(cs, (c) => (c === a ? "trouvé" : fbOf(a, c)))]).sort((x, y) => x[1] - y[1])[0];
        const accuser = cs.length === 1 || !q || (profilJ === "audacieux" && (acc[1] <= q[1] || cs.length <= 3));
        if (!accuser) { connues.add(q[0]); cs = cs.filter((c) => c.p[q[0]] === cible.p[q[0]]); continue; }
        const choix = acc[0];
        if (choix === cible) { trouve = true; break; }
        erreurs++;
        const fb = fbOf(choix, cible);
        cs = cs.filter((c) => c !== choix && fbOf(choix, c) === fb);
      }
      jours[d] = (jours[d] || 0) + 1; n++;
    }
  }
  const moy = Object.entries(jours).reduce((a, [k, v]) => a + k * v, 0) / n;
  console.log(`grille ${taille}, indice ${mode}, ${profilJ.padEnd(9)} : ${Object.entries(jours).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}j:${(100 * v / n).toFixed(0)}%`).join(" ")} | moyenne ${moy.toFixed(2)} j | ratées/cible ${(erreurs / n).toFixed(2)}`);
}
