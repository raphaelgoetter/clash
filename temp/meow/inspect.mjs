// Lecture seule : événements de la partie Meow concernant un territoire
// Usage : node temp/meow/inspect.mjs <coin>
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { readPartie } = await import("../../backend/services/meow.js");
const { texteJournal, parisParts, BANDES } = await import("../../backend/services/meowRules.js");
const coin = process.argv[2] || "tapis";
const p = await readPartie();
console.log(`Jour actuel (horloge) : ${parisParts(Date.now() + (p.decalage ?? 0)).date}, état du ${coin} :`, p.coins[coin], BANDES[p.coins[coin].b]?.nom ?? "errants");
for (const e of p.journal.filter((e) => e.vers === coin || e.de === coin || e.coin === coin)) {
  const { date, h, min } = parisParts(e.t);
  console.log(`J${e.j} ${date} ${h}h${String(min).padStart(2, "0")} [${e.k}${e.issue ? ` ${e.issue}` : ""}] ${texteJournal(p, e)}`);
}
