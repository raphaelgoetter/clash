// debug temporaire — vérifier raceLog[0] pour le bilan semaine
import dotenv from "dotenv";
dotenv.config();
import { fetchRaceLog } from "../backend/services/clashApi.js";

for (const tag of ["LRQP20V9", "Y8JUPC9C", "QU9UQJRL"]) {
  const rl = await fetchRaceLog(tag);
  const s = rl[0];
  console.log(`\n=== ${tag} ===`);
  console.log(
    "raceLog[0] seasonId:",
    s?.seasonId,
    "sectionIndex:",
    s?.sectionIndex,
    "createdDate:",
    s?.createdDate,
  );
  const standing = (s?.standings ?? []).find(
    (st) => st.clan?.tag === `#${tag}`,
  );
  if (standing) {
    const decks = (standing.clan?.participants ?? []).reduce(
      (a, p) => a + (p.decksUsed ?? 0),
      0,
    );
    console.log(
      "rank:",
      standing.rank,
      "trophyChange:",
      standing.trophyChange,
      "clan.fame:",
      standing.clan?.fame,
      "apiWeekDecks:",
      decks,
    );
  } else {
    console.log("standing NOT FOUND");
  }
}
