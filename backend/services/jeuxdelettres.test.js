import assert from "assert";
import {
  ACTIVE_GAME_REFERENCE_SEASON,
  getActiveLetterGame,
  computeWeeklySlotIndex,
  shouldPostThisSlot,
  LETTRES_CRON_HOURS,
} from "./jeuxdelettres.js";

async function main() {
  // getActiveLetterGame — la saison de référence (celle en cours au moment
  // de la mise en place) reste Anagram, jamais de bascule en milieu de
  // saison.
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON), "anagram");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 1), "pelemele");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 2), "anagram");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 3), "pelemele");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 10), "anagram");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 11), "pelemele");
  // robuste même sur une saison antérieure à la référence (jamais censé
  // arriver en pratique, mais ne doit pas planter ni renvoyer une parité
  // fausse à cause d'un modulo négatif en JS)
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON - 1), "pelemele");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON - 2), "anagram");

  // computeWeeklySlotIndex — copie fonctionnelle du mécanisme d'Anagram
  assert.strictEqual(LETTRES_CRON_HOURS.length, 2);
  assert.strictEqual(computeWeeklySlotIndex(new Date("2026-09-19T09:00:00Z")), 1);
  assert.strictEqual(computeWeeklySlotIndex(new Date("2026-09-19T10:00:00Z")), 1);
  assert.strictEqual(computeWeeklySlotIndex(new Date("2026-09-19T17:59:00Z")), 1);
  assert.strictEqual(computeWeeklySlotIndex(new Date("2026-09-19T18:00:00Z")), 2);
  assert.strictEqual(computeWeeklySlotIndex(new Date("2026-09-19T23:00:00Z")), 2);

  // shouldPostThisSlot — 1/2 au premier créneau, garanti (1/1) au second
  assert.strictEqual(shouldPostThisSlot(1, () => 0.4), true); // < 0.5
  assert.strictEqual(shouldPostThisSlot(1, () => 0.6), false); // >= 0.5
  assert.strictEqual(shouldPostThisSlot(2, () => 0.999), true); // toujours vrai

  console.log("✓ jeuxdelettres service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
