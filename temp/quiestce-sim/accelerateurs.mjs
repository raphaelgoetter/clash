// Jours pour démasquer une cible, règle actuelle (1 question puis 1 accusation
// par jour), avec différents accélérateurs. Profils : "sûr" accuse à 1 carte,
// "pari" accuse dès 2 cartes restantes.
import fs from "fs";
import { completerCartes, profil, tirerGrille, QIDS } from "../../backend/services/quiestceRules.js";
const config = JSON.parse(fs.readFileSync("data/quiestce/quiestce.json", "utf8"));
const cartes = completerCartes(JSON.parse(fs.readFileSync("data/cardNames.json", "utf8")), config.complements);
const score = (cs, f) => { const m = {}; cs.forEach((c) => { const v = f(c); m[v] = (m[v] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };
const nbCommuns = (a, b) => QIDS.filter((q) => a.p[q] === b.p[q]).length;
const VARIANTES = {
  "actuel": {},
  "indice de départ (au hasard)": { depart: true },
  "indice de départ hors pool du jour": { depart: true, horsPool: true },
  "accusation ratée → proche/loin": { fb: (a, b) => (nbCommuns(a, b) >= 4 ? "proche" : "loin") },
  "accusation ratée → nb communs": { fb: nbCommuns },
  "indice de départ + proche/loin": { depart: true, fb: (a, b) => (nbCommuns(a, b) >= 4 ? "proche" : "loin") },
};
for (const [nom, v] of Object.entries(VARIANTES)) {
  for (const seuil of [1, 2]) {
    const jours = {}; let n = 0; let rates = 0;
    for (let g = 0; g < 300; g++) {
      const grille = tirerGrille(cartes, 30).map((c) => ({ k: c.cardKey, p: profil(c) }));
      for (const cible of grille) {
        const jour0 = 1 + Math.floor(Math.random() * 5);
        let cs = grille.slice(); const connues = new Set(); let d = 0; let trouve = false;
        if (v.depart) {
          const choixQ = v.horsPool ? QIDS.filter((x) => !config.pool[jour0].includes(x)) : QIDS;
          const q = choixQ[Math.floor(Math.random() * choixQ.length)]; connues.add(q); cs = cs.filter((c) => c.p[q] === cible.p[q]);
        }
        while (!trouve && d < 9) {
          const jour = ((jour0 - 1 + d) % 7) + 1; d++;
          let pool = config.pool[jour].filter((x) => !connues.has(x));
          if (!pool.length) pool = QIDS.filter((x) => !connues.has(x));
          if (pool.length && cs.length > 1) {
            const q = pool.map((x) => [x, score(cs, (c) => c.p[x])]).sort((a, b) => a[1] - b[1])[0][0];
            connues.add(q); cs = cs.filter((c) => c.p[q] === cible.p[q]);
          }
          // Accusation : à coup sûr, au pari (≤ seuil), ou pour l'indice si la variante en donne un
          const veut = cs.length <= seuil || (v.fb && cs.length > 1);
          if (!veut) continue;
          const choix = cs.length === 1 || !v.fb ? cs[Math.floor(Math.random() * cs.length)] : cs.map((a) => [a, score(cs, (c) => (c === a ? "ok" : v.fb(a, c)))]).sort((x, y) => x[1] - y[1])[0][0];
          if (choix === cible) { trouve = true; break; }
          rates++;
          cs = cs.filter((c) => c !== choix && (!v.fb || v.fb(choix, c) === v.fb(choix, cible)));
        }
        jours[d] = (jours[d] || 0) + 1; n++;
      }
    }
    const moy = Object.entries(jours).reduce((a, [k, x]) => a + k * x, 0) / n;
    console.log(`${nom.padEnd(32)} ${seuil === 1 ? "sûr " : "pari"} : ${Object.entries(jours).sort((a, b) => a[0] - b[0]).map(([k, x]) => `${k}j:${(100 * x / n).toFixed(0)}%`).join(" ")} | moy ${moy.toFixed(2)} j | ratées ${(rates / n).toFixed(2)}`);
  }
}
