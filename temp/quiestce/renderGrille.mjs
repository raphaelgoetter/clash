// Rendu local de la grille (fiche avec cartes barrées).
// Usage : node temp/quiestce/renderGrille.mjs <sortie.png>
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import fs from "fs";
import { tirerGrille } from "../../backend/services/quiestceRules.js";
import { encodeGrille, decodeGrille, getGrilleImage } from "../../backend/services/quiestceImage.js";
const cartes = JSON.parse(fs.readFileSync("data/cardNames.json", "utf8"));
const grille = tirerGrille(cartes, 30).map((c) => c.cardKey);
const d = await encodeGrille(grille, grille.slice(0, 12));
console.log("longueur paramètre :", d.length);
const img = await getGrilleImage(await decodeGrille(d));
fs.writeFileSync(process.argv[2] || "grille.png", img.buffer);
