// Lecture seule : joueurs uniques tous mini-jeux confondus
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const ids = new Set();
for (const m of ["frames","trivia","anagrams","pelemele","zoom","palette","blindroyale","lajustecarte"])
  for (const r of await (await import(`../backend/services/${m}.js`)).getAllArchivedResults()) ids.add(r.discordId);
const hebdo = ids.size;
for (const m of ["quiz","blackjack"]) for (const x of await (await import(`../backend/services/${m}.js`)).listManches({ limit: Infinity })) for (const r of x.ranking) ids.add(r.discordId);
for (const id of Object.keys(await (await import("../backend/services/gobelet.js")).readPoints())) ids.add(id);
console.log("hebdo:", hebdo, "tous jeux:", ids.size);
process.exit(0);
