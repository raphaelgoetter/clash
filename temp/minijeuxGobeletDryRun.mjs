// Lecture seule : nombre total de joueurs Gobelet sur la partie en cours
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const g = await import("../backend/services/gobelet.js");
const [pts, names] = await Promise.all([g.readPoints(), g.readAllUsernames()]);
console.log("points:", Object.keys(pts || {}).length, "usernames:", Object.keys(names || {}).length);
process.exit(0);
