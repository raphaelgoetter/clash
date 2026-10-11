// Nombre de questions pour identifier une carte (certitude) et chances au pari,
// selon la taille de grille, avec le pool du jour et un choix de question optimal.
import fs from "fs";
import { completerCartes, carteEligible, profil, tirerGrille, QIDS } from "../../backend/services/quiestceRules.js";
const config = JSON.parse(fs.readFileSync("data/quiestce/quiestce.json", "utf8"));
const cartes = completerCartes(JSON.parse(fs.readFileSync("data/cardNames.json", "utf8")), config.complements);
const tailles = (process.argv[2] || "30,24,20").split(",").map(Number);
for (const taille of tailles) {
  const hist = {}; let n = 0; const apres2 = {};
  for (let g = 0; g < 400; g++) {
    const grille = tirerGrille(cartes, taille).map((c) => ({ k: c.cardKey, p: profil(c) }));
    for (const cible of grille) {
      const jour0 = 1 + Math.floor(Math.random() * 5);
      let cs = grille.filter((c) => c !== cible || true).filter((c) => c.k !== grille.find((x) => x !== cible).k || c === cible);
      cs = grille.slice(); const connues = new Set(); let q = 0;
      while (cs.length > 1 && q < 8) {
        const jour = ((jour0 - 1 + q) % 7) + 1;
        let pool = config.pool[jour].filter((x) => !connues.has(x));
        if (!pool.length) pool = QIDS.filter((x) => !connues.has(x));
        if (!pool.length) break;
        const best = pool.map((x) => { const m = {}; cs.forEach((c) => (m[c.p[x]] = (m[c.p[x]] || 0) + 1)); return [x, Object.values(m).reduce((a, b) => a + b * b, 0)]; }).sort((a, b) => a[1] - b[1])[0][0];
        connues.add(best); cs = cs.filter((c) => c.p[best] === cible.p[best]); q++;
        if (q === 2) apres2[Math.min(cs.length, 5)] = (apres2[Math.min(cs.length, 5)] || 0) + 1;
      }
      hist[q] = (hist[q] || 0) + 1; n++;
    }
  }
  console.log(`grille ${taille} : questions pour certitude ${Object.entries(hist).sort((a,b)=>a[0]-b[0]).map(([k, v]) => `${k}:${(100 * v / n).toFixed(0)}%`).join(" ")} | candidats après 2 questions ${Object.entries(apres2).map(([k, v]) => `${k === "5" ? "5+" : k}:${(100 * v / n).toFixed(0)}%`).join(" ")}`);
}
