// Compare les illustrations de base de l'API officielle et de RoyaleAPI
// (cdns3, à jour) pour repérer les designs périmés côté API.
// Usage : node temp/compare_card_art.mjs <dossierSortie>
import "dotenv/config";
import fs from "node:fs";
import { PNG } from "pngjs";
import { fetchCards } from "../backend/services/clashApi.js";

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
const slug = (n) => n.toLowerCase().replace(/\./g, "").replace(/\s+/g, "-");

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

// Grille G×G de couleurs moyennes sur le centre de la zone opaque
function signature(buf, G = 12) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 200) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  // marge 15 % pour ignorer le cadre
  const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.15;
  x0 += mx; x1 -= mx; y0 += my; y1 -= my;
  const sig = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    let r = 0, g = 0, b = 0, n = 0;
    const ax = x0 + (gx * (x1 - x0)) / G, bx = x0 + ((gx + 1) * (x1 - x0)) / G;
    const ay = y0 + (gy * (y1 - y0)) / G, by = y0 + ((gy + 1) * (y1 - y0)) / G;
    for (let y = Math.floor(ay); y < by; y++) for (let x = Math.floor(ax); x < bx; x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    sig.push(r / n, g / n, b / n);
  }
  return sig;
}

const cards = await fetchCards();
const rows = [];
for (const c of cards) {
  const api = await get(c.iconUrls?.medium);
  const rapi = await get(`https://cdns3.royaleapi.com/static/img/cards-150/${slug(c.name)}.png`);
  if (!api || !rapi) { rows.push({ name: c.name, diff: null }); continue; }
  const a = signature(api), b = signature(rapi);
  const diff = a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  rows.push({ name: c.name, diff });
  fs.writeFileSync(`${outDir}/${slug(c.name)}-api.png`, api);
  fs.writeFileSync(`${outDir}/${slug(c.name)}-royaleapi.png`, rapi);
}
rows.sort((x, y) => (y.diff ?? 999) - (x.diff ?? 999));
for (const r of rows) console.log(r.diff == null ? "  absent" : r.diff.toFixed(1).padStart(8), r.name);
