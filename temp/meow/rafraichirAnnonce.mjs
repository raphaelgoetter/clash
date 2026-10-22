// Réédite le message officiel Meow en cours (ex. après un changement de config)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { rafraichirMessage } = await import("../../api/discord/_handlers/meow.js");
const { readState, readPartie } = await import("../../backend/services/meow.js");
await rafraichirMessage(await readState(), await readPartie());
console.log("Message rafraîchi.");
