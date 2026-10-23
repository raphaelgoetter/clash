import assert from "assert";
import {
  ACTIVE_GAME_REFERENCE_SEASON,
  getActiveLetterGame,
} from "./jeuxdelettres.js";

async function main() {
  // getActiveLetterGame — la saison de référence (celle en cours au moment
  // de la mise en place) reste Anagram, jamais de bascule en milieu de
  // saison.
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON), "anagram");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 1), "pelemele");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON + 2), "anagram");
  // À partir de la saison de bascule (139), la nouvelle paire prend le
  // relais : voir refonte.test.js.
  // robuste même sur une saison antérieure à la référence (jamais censé
  // arriver en pratique, mais ne doit pas planter ni renvoyer une parité
  // fausse à cause d'un modulo négatif en JS)
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON - 1), "pelemele");
  assert.strictEqual(getActiveLetterGame(ACTIVE_GAME_REFERENCE_SEASON - 2), "anagram");

  console.log("✓ jeuxdelettres service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
