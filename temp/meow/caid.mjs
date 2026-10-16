// Lecture seule : classement Caïd détaillé et activité de chaque joueur
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { readPartie, loadMeowConfig } = await import("../../backend/services/meow.js");
const { classementCaid, BANDES } = await import("../../backend/services/meowRules.js");
const [p, config] = await Promise.all([readPartie(), loadMeowConfig()]);
const squats = p.journal.filter((e) => e.k === "squat");
classementCaid(p, config).forEach((r, i) => {
  const s = squats.filter((e) => e.p === r.discordId);
  const issues = ["victoire", "defaite", "retraite", "retraiteAuto"].map((k) => `${k} ${s.filter((e) => e.issue === k).length}`).join(", ");
  console.log(`${String(i + 1).padStart(2)}. ${r.username.padEnd(16)} ${BANDES[r.bande].emoji} ${String(r.score).padStart(3)} pts | pris ${r.coinsPris}, délogés ${r.chatsDeloges} | ${s.length} squats (${issues}) | appels ${p.journal.filter((e) => e.k === "appel" && e.p === r.discordId).length}`);
});
console.log(`Journal : ${p.journal.length} entrées gardées (max 400), premier jour présent : J${p.journal[0]?.j}`);
