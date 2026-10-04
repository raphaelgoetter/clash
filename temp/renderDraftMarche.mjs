// Rendu local du marché du Draft Royale (vérification visuelle du placement)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import fs from "fs";
import { buildMarcheSvg } from "../backend/services/draftroyaleImage.js";
import { rasterize } from "../backend/services/elixirImage.js";
import { loadCatalog } from "../backend/services/draftroyale.js";
const catalog = await loadCatalog();
const mat = `data:image/jpeg;base64,${fs.readFileSync("data/draftroyale/images/draft-game.jpg").toString("base64")}`;
const n = Number(process.argv[2] || 14);
const keys = [...catalog.keys()].sort(() => Math.random() - 0.5).slice(0, n).map((key, i) => ({ key, count: i % 5 === 0 ? 2 : 1 }));
const svg = await buildMarcheSvg(keys, catalog, mat);
fs.writeFileSync(`temp/draft-marche-${n}.png`, await rasterize(svg, 1200));
console.log("ok", n);
