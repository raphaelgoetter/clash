// Lecture seule : aperçu de l'embed du bouton "📊 Stats"
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { buildStatsEmbed } = await import("../api/discord/_handlers/minijeux.js");
const e = await buildStatsEmbed();
console.log(e.title + "\n\n" + e.description + "\n\n[footer] " + e.footer.text);
console.log("\nlongueur description:", e.description.length);
process.exit(0);
