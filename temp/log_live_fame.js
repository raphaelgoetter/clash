// Script pour logger la réponse brute de l'API /currentriverrace et sommer les fame
// Usage : node temp/log_live_fame.js <CLAN_TAG>
import "dotenv/config";
import { fetchCurrentRace } from "../backend/services/clashApi.js";

const clanTag = process.argv[2] || "LRQP20V9";

(async () => {
  const race = await fetchCurrentRace(clanTag);
  if (!race || !race.clan || !race.clan.participants) {
    console.error("Aucune donnée live trouvée pour ce clan.");
    process.exit(1);
  }
  const participants = race.clan.participants;
  const totalFame = participants.reduce((sum, p) => sum + (p.fame || 0), 0);
  console.log("Réponse brute API /currentriverrace :");
  console.dir(participants, { depth: null });
  console.log("\nSomme totale des fame (live API) :", totalFame);
})();
