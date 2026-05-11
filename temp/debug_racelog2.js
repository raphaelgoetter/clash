// debug temporaire — vérifier participants fame vs clan.fame dans raceLog
import dotenv from "dotenv";
dotenv.config();
import { fetchRaceLog } from "../backend/services/clashApi.js";

for (const tag of ["LRQP20V9", "Y8JUPC9C", "QU9UQJRL"]) {
  const rl = await fetchRaceLog(tag);
  const s = rl[0];
  const standing = (s?.standings ?? []).find(
    (st) => st.clan?.tag === `#${tag}`,
  );
  if (!standing) {
    console.log(tag, "not found");
    continue;
  }

  const participants = standing.clan?.participants ?? [];
  const sumParticipantsFame = participants.reduce(
    (a, p) => a + (p.fame ?? 0),
    0,
  );
  const sumDecksUsed = participants.reduce((a, p) => a + (p.decksUsed ?? 0), 0);

  console.log(
    `${tag}: clan.fame=${standing.clan?.fame} sum(participants.fame)=${sumParticipantsFame} clanScore=${standing.clan?.clanScore} decks=${sumDecksUsed}`,
  );
}
