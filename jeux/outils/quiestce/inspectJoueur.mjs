// Lecture seule : état brut d'un joueur de Qui est-ce ? (debug).
// Usage : node jeux/outils/quiestce/inspectJoueur.mjs <fragment de pseudo>
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { readState, readPartie } from "../../services/quiestce.js";
const st = await readState();
const p = await readPartie();
console.log("state:", JSON.stringify({ phase: st?.phase, jour: st?.jour, publishedAt: st?.publishedAt }), "numeroJour:", p.numeroJour);
for (const [id, j] of Object.entries(p.joueurs)) {
  if (!j.username.toLowerCase().includes((process.argv[2] || "").toLowerCase())) continue;
  const { enquete, ...reste } = j;
  console.log(id, JSON.stringify(reste));
  console.log("enquête:", JSON.stringify(enquete));
  console.log("journal:", p.journal.filter((e) => e.p === id || e.s === id).map((e) => `J${e.j} ${e.t ?? e.k}`).join(" | "));
}
