// Lecture seule : manches de la saison manquées par un joueur (pseudo en argument)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { getCurrentSeasonBounds } from "../backend/services/dateUtils.js";
const needle = process.argv[2] || "Snaatchou";
const { start, end } = getCurrentSeasonBounds(new Date());
const rounds = new Map(); let id = null;
for (const m of ["frames","trivia","anagrams","pelemele","zoom","palette","blindroyale","lajustecarte"]) {
  for (const r of await (await import(`../backend/services/${m}.js`)).getAllArchivedResults()) {
    const d = r.postedAt || r.solvedAt; if (!d || new Date(d) < start || new Date(d) >= end) continue;
    const k = `${m}|${r.seasonId}|${r.gameId}|${String(r.postedAt).slice(0,10)}`;
    if (!rounds.has(k)) rounds.set(k, new Set()); rounds.get(k).add(r.discordId);
    if (r.pseudo?.includes(needle)) id = r.discordId;
  }
}
console.log("discordId:", id);
for (const [k, s] of rounds) console.log(s.has(id) ? "✅" : "❌", k, `(${s.size} joueurs)`);
process.exit(0);
