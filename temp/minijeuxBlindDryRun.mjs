// Lecture seule : Fort Minor a-t-il tenté la manche Blind Royale "Elixir Golem" ?
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const b = await import("../backend/services/blindroyale.js");
const id = "1028611091351224412";
console.log("participant:", await b.readParticipant("Elixir Golem", id));
if (b.hasPlayerInteracted) console.log("interagi:", await b.hasPlayerInteracted("Elixir Golem", id));
process.exit(0);
