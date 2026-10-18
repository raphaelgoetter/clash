// Lecture seule : moyenne de joueurs par manche, par jeu hebdo
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
for (const m of ["zoom","frames","anagrams","palette","lajustecarte","trivia","blindroyale","pelemele"]) {
  const res = await (await import(`../backend/services/${m}.js`)).getAllArchivedResults();
  const rounds = new Map();
  for (const r of res) { const k = `${r.seasonId}:${r.gameId}`; if (!rounds.has(k)) rounds.set(k, new Set()); rounds.get(k).add(r.discordId); }
  const total = [...rounds.values()].reduce((s, x) => s + x.size, 0);
  console.log(`${m}: ${new Set(res.map((r) => r.discordId)).size} joueurs, moy ${(total / rounds.size).toFixed(1)} (${rounds.size} manches)`);
}
process.exit(0);
