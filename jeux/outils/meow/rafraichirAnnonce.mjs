// Réédite le message officiel Meow en cours (ex. après un changement de config)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { rafraichirMessage } = await import("../../discord/handlers/meow.js");
const { readState, readPartie } = await import("../../services/meow.js");
await rafraichirMessage(await readState(), await readPartie());
console.log("Message rafraîchi.");
