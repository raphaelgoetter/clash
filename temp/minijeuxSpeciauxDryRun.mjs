// Lecture seule : structure des manches spéciales de la saison + état Gobelet
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { getCurrentSeasonBounds } from "../backend/services/dateUtils.js";
const { start } = getCurrentSeasonBounds(new Date());
const mc = await import("../backend/services/marioclash.js");
const m = (await mc.listManches({ limit: Infinity })).filter((x) => new Date(x.resolvedAt || x.startedAt) >= start);
for (const x of m) console.log("marioclash keys:", Object.keys(x), JSON.stringify(x).slice(0, 600));
const g = await import("../backend/services/gobelet.js");
console.log("gobelet exports:", Object.keys(g).join(","));
const st = await g.readState(); console.log("gobelet state keys:", Object.keys(st || {}), "jour", st?.jour);
process.exit(0);
