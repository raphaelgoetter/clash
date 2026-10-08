// Rendu local du plateau d'avancement (tapis lu dans data/, pas encore sur Blob).
// Usage : node temp/bang/renderTable.mjs <sortie.png> [joueurs] [éliminés]
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import fs from "fs";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).endsWith("bang/images/bang-table.jpg")) {
    const buf = fs.readFileSync("data/bang/images/bang-table.jpg");
    return { ok: true, arrayBuffer: async () => buf };
  }
  return realFetch(url, opts);
};
const { getTableImage, encodeTable, decodeTable } = await import("../../backend/services/bangImage.js");
const n = Number(process.argv[3] || 15);
const morts = Number(process.argv[4] || 5);
const noms = ["Pierre", "Lucas", "Thomas", "Sofia", "Kévina", "Josette", "Raphaël", "MaximeLeTrèsLongPseudoQuiDéborde", "Inès", "Le Gobelin Masqué du 67", "Léa", "xX_DarkSasuke_93_Xx", "Chloé", "Yanis", "Manon", "Enzo", "Jade", "Louis", "Zoé la Reine des Fripons", "Adam"];
const rois = noms.slice(0, n).map((nom, i) => ({ nom, cartes: (i * 3) % 9, vivant: i >= morts }));
rois.sort((a, b) => Number(b.vivant) - Number(a.vivant));
const etat = decodeTable(encodeTable({ jour: 3, duree: 7, pioche: 47, bombes: 11, rois }));
fs.writeFileSync(process.argv[2], (await getTableImage(etat)).buffer);
console.log("ok", encodeTable({ jour: 3, duree: 7, pioche: 47, bombes: 11, rois }).length, "caractères");
