#!/usr/bin/env node
// Rendu local de l'image du jour de Robinson avec un état d'exemple (aucun
// accès Redis ; la police vient de Vercel Blob, BLOB_READ_WRITE_TOKEN requis).
// Usage : node jeux/outils/robinson/renderPlateau.mjs <sortie.jpg> [jour]
// Vérifier ensuite la lisibilité mobile : sips -Z 360 <sortie.jpg> --out <petite.jpg>
import "../../env.js";
import fs from "node:fs/promises";
import { decodePlateau, encodePlateau, getPlateauImage } from "../../services/robinsonImage.js";

const [sortie = "temp/robinson-plateau.jpg", jourArg = "4"] = process.argv.slice(2);
const jour = Number(jourArg);
const plateau = decodePlateau(
  encodePlateau({
    jour,
    duree: 7,
    meteo: "soleil",
    prevision: "pluie",
    passees: ["nuages", "pluie", "tempete", "soleil", "pluie", "nuages"].slice(0, jour - 1),
    stocks: { poisson: 18, eau: 9, bois: 7 },
    besoin: { poisson: 15, eau: 15, bois: 8 },
    planches: 14,
    objectif: 30,
    aBord: 0,
  }),
);
const { buffer } = await getPlateauImage(plateau);
await fs.writeFile(sortie, buffer);
console.log(`Image écrite : ${sortie}`);
