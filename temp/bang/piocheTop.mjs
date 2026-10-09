import dotenv from "dotenv";
dotenv.config();
const { readPartie } = await import("../../backend/services/bang.js");
const p = await readPartie();
console.log(p.pioche.slice(0, 6), p.pioche.length);
