#!/usr/bin/env node
// Rendu local du plateau Robinson avec un état d'exemple (aucun accès
// Redis ; la police vient de Vercel Blob, BLOB_READ_WRITE_TOKEN requis).
// Usage : node jeux/outils/robinson/renderPlateau.mjs <sortie.png> [jour]
import "../../env.js";
import fs from "node:fs/promises";
import { decodePlateau, encodePlateau, getPlateauImage } from "../../services/robinsonImage.js";

const [sortie = "temp/robinson-plateau.png", jourArg = "5"] = process.argv.slice(2);
const jour = Number(jourArg);
const plateau = decodePlateau(
  encodePlateau({
    jour,
    stocks: { poisson: 11, eau: 0, bois: 7 },
    besoin: { poisson: 15, eau: 15, bois: 8 },
    zeroStreaks: { poisson: 0, eau: 1, bois: 0 },
    radeauPoints: 13,
    radeauJour: 4,
    constructions: { filet: 4, citerne: 2, atelier: 0 },
    evenements: { 2: "epave", 3: "canicule", 4: "ouragan", 5: "gobelins", 6: "indigestion_royale" },
    zones: { peche: 5, eau: 2, bois: 4, explorer: 0 },
    palier: 4,
    explorerBloque: true,
  }),
);
const { buffer } = await getPlateauImage(plateau);
await fs.writeFile(sortie, buffer);
console.log(`Plateau écrit : ${sortie}`);
