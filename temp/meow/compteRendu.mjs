// Partie complète jouée par les PNJ, puis compte-rendu final
import fs from "fs";
import { creerPartie, inscrire, demarrer, rattraper, compteRendu, parisInstant } from "../../backend/services/meowRules.js";
const config = JSON.parse(fs.readFileSync("data/meow/meow.json", "utf8"));
for (let seed = 1; seed <= 4; seed++) {
  let x = seed;
  const rng = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const partie = creerPartie();
  for (let i = 0; i < 15; i++) inscrire(partie, `pnj-${i}`, `Chat${i}`, { config });
  partie.pnjActifs = true;
  const t0 = parisInstant("2026-11-02", 8);
  demarrer(partie, { config, now: t0, rng });
  rattraper(partie, { config, now: t0 + 8 * 86400_000, rng });
  console.log(`\n# seed ${seed} (terminée : ${partie.termine})`);
  for (const p of compteRendu(partie)) console.log("- " + p);
}
// Exploit forcé (les PNJ n'attaquent qu'à 60 % de chances ou plus)
const p = creerPartie();
for (let i = 0; i < 15; i++) inscrire(p, `pnj-${i}`, `Chat${i}`, { config });
demarrer(p, { config, now: parisInstant("2026-11-02", 8) });
p.exploit = { p: 0.18, p_id: "pnj-3", b: 2, def: 0, vers: "armoire", aInit: 2, dInit: 5, j: 4 };
p.mercenaires = { jour: 3, b: 0, n: 5, coin: "carton" };
console.log("\n# exploit forcé"); for (const x of compteRendu(p)) console.log("- " + x);
