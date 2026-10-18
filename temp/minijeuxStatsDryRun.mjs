// Calcul en lecture seule des stats de participation mini-jeux (saison mini-jeux en cours)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { getCurrentSeasonBounds } from "../backend/services/dateUtils.js";
const S = (m) => import(`../backend/services/${m}.js`);
const { start, end } = getCurrentSeasonBounds(new Date());
const inSeason = (d) => d && new Date(d) >= start && new Date(d) < end;
console.log("Saison mini-jeux :", start.toISOString().slice(0,10), "→", end.toISOString().slice(0,10));
const regs = ["frames","trivia","anagrams","pelemele","zoom","palette","blindroyale","lajustecarte"];
const allPlayers = new Map(); const perPlayerRounds = new Map(); const allRounds = new Set();
for (const m of regs) {
  const res = (await (await S(m)).getAllArchivedResults()).filter((r) => inSeason(r.postedAt || r.solvedAt));
  if (!res.length) continue;
  const rounds = new Map();
  for (const r of res) {
    if (!rounds.has(r.gameId)) rounds.set(r.gameId, new Set());
    rounds.get(r.gameId).add(r.discordId);
    allPlayers.set(r.discordId, r.pseudo);
    const k = `${m}:${r.gameId}`; allRounds.add(k);
    if (!perPlayerRounds.has(r.discordId)) perPlayerRounds.set(r.discordId, new Set());
    perPlayerRounds.get(r.discordId).add(k);
  }
  const uniq = new Set(res.map((r) => r.discordId)).size;
  const sizes = [...rounds.entries()].map(([g, s]) => `${g}:${s.size}`);
  console.log(`${m}: ${uniq} joueurs uniques, ${rounds.size} manches archivées [${sizes.join(", ")}]`);
}
console.log(`Total manches hebdo archivées: ${allRounds.size}, joueurs uniques hebdo: ${allPlayers.size}`);
const counts = [...perPlayerRounds.entries()].map(([id, s]) => [allPlayers.get(id), s.size]).sort((a,b)=>b[1]-a[1]);
console.log("Manches jouées par joueur (top 15):", counts.slice(0,15).map(([p,n])=>`${p}=${n}`).join(" | "));
for (const m of ["quiz","blackjack","marioclash","gobelet","bang","quiestce","meow"]) {
  try {
    const manches = (await (await S(m)).listManches({ limit: Infinity })).filter((x) => inSeason(x.resolvedAt || x.startedAt));
    const ids = new Set();
    for (const x of manches) for (const r of x.ranking || x.classement || []) ids.add(r.discordId || r.id);
    console.log(`${m}: ${manches.length} partie(s) cette saison, ${ids.size} joueurs dans les classements`);
  } catch (e) { console.log(`${m}: erreur ${e.message}`); }
}
process.exit(0);
