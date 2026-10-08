// Rendu local de l'image d'une main (tapis lu dans data/, pas encore sur Blob).
// Usage : node temp/bang/renderMain.mjs <sortie.png>
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
const { getMainImage } = await import("../../backend/services/bangImage.js");
const img = await getMainImage(["esprit", "gang", "gang", "moine", "fut", "malediction", "sarbacane", "voleuse", "gobelin", "bombe"]);
fs.writeFileSync(process.argv[2], img.buffer);
console.log("ok");
