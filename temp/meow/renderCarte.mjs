// Rendu local de la carte d'une partie fictive : node temp/meow/renderCarte.mjs <sortie.jpg>
import fs from "node:fs";
import { creerPartie, inscrire, demarrer } from "../../backend/services/meowRules.js";
import { encodeCarte, decodeCarte, getCarteImage } from "./meowImageLocal.mjs";
const config = JSON.parse(fs.readFileSync(new URL("../../data/meow/meow.json", import.meta.url)));
const partie = creerPartie();
for (let i = 0; i < 14; i++) inscrire(partie, `j${i}`, `J${i}`, { config });
demarrer(partie, { config });
partie.coins.canape = { b: 0, n: 12 };
partie.coins.malle = { b: 2, n: 3 };
const d = encodeCarte(partie);
const t = Date.now();
const img = await getCarteImage(decodeCarte(d));
fs.writeFileSync(process.argv[2], img.buffer);
console.log(d.length, "car.,", Math.round(img.buffer.length / 1024), "Ko,", Date.now() - t, "ms");
