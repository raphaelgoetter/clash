// Désinscrit un joueur Meow (admin) et rafraîchit le message officiel
// Usage : node jeux/outils/meow/desinscrireAdmin.mjs <discordId>
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { handleDesinscrire } = await import("../../discord/handlers/meow.js");
const { readPartie } = await import("../../services/meow.js");
await handleDesinscrire(null, process.argv[2]);
const p = await readPartie();
console.log(Object.values(p.joueurs).length, Object.values(p.joueurs).map((j) => j.username).join(" · "));
