// Restaure les 12 entrées "solved" de zoom:participants:battle-ram-base et
// zoom:archived:136 effacées par inadvertance (probablement pendant les
// tests de l'unification Zoom/Palette, 19/09/2026) — reconstruites à partir
// de zoom:season:136:pseudos (discordId <-> pseudo) et de la capture d'écran
// fournie par l'utilisateur (scores + ordre de résolution).
//
// IMPORTANT : ne touche PAS zoom:season:136 (le zset des scores de saison)
// — ces points sont déjà comptabilisés, un second zincrby les doublerait.
// Idempotent sur zoom:archived (hsetnx) : sans effet si déjà présent.
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

const GAME_ID = "battle-ram-base";
const SEASON_ID = 136;
const POSTED_AT = "2026-09-18T18:20:58.090Z"; // state.startedAt
const ENTRY = { cardKey: "Battle Ram", variant: "base", answer: "Bélier de combat" };

// Ordre = celui de la capture d'écran (déjà trié score desc, solvedAt asc
// par computeGameRanking) — horodatages synthétiques, espacés et placés
// avant la première résolution légitime post-incident (Libertade,
// 2026-09-19T16:14:29.738Z), pour ne jamais interférer avec l'ordre réel.
const PLAYERS = [
  { discordId: "1412392532930728087", username: "Capi", score: 10, solvedAt: "2026-09-18T19:00:00.000Z" },
  { discordId: "1028611091351224412", username: "𝔽𝕠𝕣𝕥 𝕄𝕚𝕟𝕠𝕣", score: 10, solvedAt: "2026-09-18T19:05:00.000Z" },
  { discordId: "824576376668422164", username: "☆. Eloise", score: 10, solvedAt: "2026-09-18T19:10:00.000Z" },
  { discordId: "704676253071966290", username: "nb", score: 7, solvedAt: "2026-09-18T20:00:00.000Z" },
  { discordId: "497391862307487751", username: "Snaatchou", score: 7, solvedAt: "2026-09-18T20:15:00.000Z" },
  { discordId: "900102629240213524", username: "☆. Aurel", score: 5, solvedAt: "2026-09-19T08:00:00.000Z" },
  { discordId: "1313959110504612057", username: "TechNinYo", score: 5, solvedAt: "2026-09-19T08:10:00.000Z" },
  { discordId: "478954387192938498", username: "☆. Mariechou", score: 5, solvedAt: "2026-09-19T08:20:00.000Z" },
  { discordId: "643461492599029782", username: "☆. Azzgameuse", score: 5, solvedAt: "2026-09-19T08:30:00.000Z" },
  { discordId: "915294299011301417", username: "𝑨 𝒖 𝒃 𝒓 𝒆 𝒚  🍓", score: 5, solvedAt: "2026-09-19T08:40:00.000Z" },
  { discordId: "1540819278565998663", username: "✨𝐕𝐒✨𝐋𝐮𝐟𝐟𝐲✨𝐁𝐚𝐢𝐭✨", score: 3, solvedAt: "2026-09-19T10:00:00.000Z" },
  { discordId: "765326982250102824", username: "☆. Electron", score: 3, solvedAt: "2026-09-19T10:10:00.000Z" },
];

const DRY_RUN = process.argv.includes("--dry-run");

for (const p of PLAYERS) {
  const participant = {
    discordId: p.discordId,
    username: p.username,
    attempts: 0, // non récupérable — n'est affiché/relu nulle part
    solved: true,
    solvedAt: p.solvedAt,
    score: p.score,
  };
  const archived = {
    gameId: GAME_ID,
    seasonId: SEASON_ID,
    cardKey: ENTRY.cardKey,
    variant: ENTRY.variant,
    answer: ENTRY.answer,
    postedAt: POSTED_AT,
    discordId: p.discordId,
    pseudo: p.username,
    score: p.score,
    solvedAt: p.solvedAt,
  };

  console.log(`${p.username} (${p.discordId}) — score ${p.score}`);
  if (DRY_RUN) continue;

  await redis.hset(`zoom:participants:${GAME_ID}`, { [p.discordId]: JSON.stringify(participant) });
  await redis.hset(`zoom:usernames:${GAME_ID}`, { [p.discordId]: p.username });
  const wasSet = Number(await redis.hsetnx(`zoom:archived:${SEASON_ID}`, `${GAME_ID}:${p.discordId}`, JSON.stringify(archived)));
  if (!wasSet) {
    console.log(`  (archive déjà présente pour ${p.username} — non touchée)`);
  }
}

console.log(DRY_RUN ? "\nDRY-RUN — rien écrit." : "\nRestauration terminée.");
