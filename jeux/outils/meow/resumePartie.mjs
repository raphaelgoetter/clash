// Lecture seule : résumé jour par jour de la partie Meow en cours (Redis)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { readPartie, readState } = await import("../../services/meow.js");
const { BANDES, nomCoin, parisParts, PIECES, coinsDe } = await import("../../services/meowRules.js");
const [p, state] = await Promise.all([readPartie(), readState()]);
const N = ["R", "N", "C"];
console.log(`État : phase ${state?.phase}, jour publié ${state?.jour}, terminé ${p.termine}, journal ${p.journal.length} entrées (J${p.journal[0]?.j} → J${p.journal.at(-1)?.j})`);
console.log("Décomptes (territoires tenus à minuit, R/N/C) :", p.decomptes.map((d) => `J${d.jour} ${d.coins.join("/")}`).join(" · "));
console.log("Points finaux :", p.points.join(" / "));
const humains = Object.entries(p.joueurs).filter(([id]) => !id.startsWith("pnj-")).map(([id, j]) => `${j.username} (${BANDES[j.bande].nom})`);
console.log("Humains :", humains.join(", "));
const jours = [...new Set(p.journal.map((e) => e.j))].sort((a, b) => a - b);
for (const jour of jours) {
  const sq = p.journal.filter((e) => e.k === "squat" && e.j === jour);
  const parBande = [0, 1, 2].map((b) => {
    const tentes = sq.filter((e) => e.b === b);
    return `${N[b]}: ${tentes.length} squats (${tentes.filter((e) => e.issue === "victoire").length} ok), perdus ${sq.filter((e) => e.def === b && e.issue === "victoire").length}`;
  });
  const croq = p.journal.filter((e) => e.k === "croquettes" && e.j === jour);
  const croqTxt = [0, 1, 2].map((b) => croq.filter((e) => e.b === b).reduce((t, e) => t + e.n, 0)).join("/");
  console.log(`J${jour} | ${parBande.join(" | ")} | croquettes R/N/C ${croqTxt}`);
  for (const e of sq.filter((e) => e.b === 1 && e.issue === "victoire")) {
    const { h, min } = parisParts(e.t);
    console.log(`     ⚫ ${h}h${String(min).padStart(2, "0")} ${p.joueurs[e.p]?.username} prend ${nomCoin(e.vers)} (${PIECES[Object.keys(PIECES).find((x) => PIECES[x].coins.includes(e.vers))].nom}) aux ${e.def === -1 ? "errants" : BANDES[e.def].nom}, depuis ${nomCoin(e.de)}`);
  }
}
console.log("Carte actuelle, Noirs :", coinsDe(p, 1).map((c) => `${nomCoin(c)} ${p.coins[c].n}`).join(", "));
