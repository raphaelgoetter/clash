// Lecture seule : stats de participation tous temps confondus
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const S = (m) => import(`../backend/services/${m}.js`);
for (const m of ["frames","trivia","anagrams","pelemele","zoom","palette","blindroyale","lajustecarte"]) {
  const res = await (await S(m)).getAllArchivedResults();
  const rounds = new Set(res.map((r) => `${r.seasonId}:${r.gameId}`));
  const dates = res.map((r) => r.postedAt || r.solvedAt).filter(Boolean).sort();
  console.log(`${m}: ${new Set(res.map((r) => r.discordId)).size} joueurs, ${rounds.size} manches, ${dates[0]?.slice(0,10)} → ${dates.at(-1)?.slice(0,10)}`);
}
for (const m of ["quiz","tamagotchi","robinson","bossraid","goblinhunters","blackjack","marioclash","gobelet","bang","quiestce","meow"]) {
  try {
    const manches = await (await S(m)).listManches({ limit: Infinity });
    console.log(`\n${m}: ${manches.length} manche(s)`);
    for (const x of manches) {
      const arrays = Object.entries(x).filter(([, v]) => Array.isArray(v) || (v && typeof v === "object")).map(([k, v]) => `${k}[${Array.isArray(v) ? v.length : Object.keys(v).length}]`);
      console.log(`  manche ${x.manche ?? "?"} ${String(x.resolvedAt || x.startedAt || "").slice(0,10)} keys=${Object.keys(x).join(",")} | ${arrays.join(" ")}`);
    }
  } catch (e) { console.log(`${m}: erreur ${e.message}`); }
}
process.exit(0);
