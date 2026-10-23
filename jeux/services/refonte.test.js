import assert from "assert";
import { REFONTE_SEASON, REFONTE_PAIRS, getRefonteGame, getWiredGame, groupLabel, groupLabelForDate } from "./refonte.js";
import { getActiveCultureGame } from "./jeuxculture.js";
import { getActiveBlindGame } from "./jeuxaveugle.js";
import { getActiveLetterGame } from "./jeuxdelettres.js";
import { getActiveVisualGame } from "./jeuxvisuels.js";

console.log("Running refonte tests...");

const GROUPS = {
  culture: getActiveCultureGame,
  aveugle: getActiveBlindGame,
  lettres: getActiveLetterGame,
  visuels: getActiveVisualGame,
};

// Novembre 2026 (138) : dernières saisons des anciennes paires, intactes.
assert.strictEqual(getActiveCultureGame(137), "trivia");
assert.strictEqual(getActiveCultureGame(138), "frame");
assert.strictEqual(getActiveBlindGame(138), "lajustecarte");
assert.strictEqual(getActiveLetterGame(138), "anagram");
assert.strictEqual(getActiveVisualGame(138), "zoom");
console.log("✓ anciennes paires inchangées avant la bascule");

for (const [group, getActive] of Object.entries(GROUPS)) {
  const bascule = REFONTE_SEASON[group];
  const [premier, second] = REFONTE_PAIRS[group];
  assert.strictEqual(getRefonteGame(group, bascule - 1), null, group);
  assert.strictEqual(getActive(bascule), premier, group);
  assert.strictEqual(getActive(bascule + 1), second, group);
  assert.strictEqual(getActive(bascule + 2), premier, group);
  assert.strictEqual(getActive(bascule + 11), second, group);
}
console.log("✓ nouvelles paires à partir de la saison de bascule");

// Décembre 2026 = 1er jeu de chaque nouvelle paire.
assert.strictEqual(getActiveCultureGame(139), "synopsis");
assert.strictEqual(getActiveBlindGame(139), "triviageek");
assert.strictEqual(getActiveLetterGame(139), "concept");
assert.strictEqual(getActiveVisualGame(139), "platpays");
assert.strictEqual(getActiveCultureGame(140), "frame");
console.log("✓ calendrier décembre/janvier");

// Jeux prêts : avant la bascule tout passe ; après, seuls ceux de
// REFONTE_PRETS (Pêle-mêle et Zoom gardent leur id mais ne doivent jamais
// relancer leur version Clash Royale).
assert.strictEqual(getWiredGame("visuels", 138, "zoom"), "zoom");
assert.strictEqual(getWiredGame("visuels", 140, "zoom"), null);
assert.strictEqual(getWiredGame("lettres", 140, "pelemele"), null);
assert.strictEqual(getWiredGame("culture", 139, "synopsis"), null);
assert.strictEqual(getWiredGame("culture", 140, "frame"), "frame");
console.log("✓ seuls les jeux prêts sont lancés après la bascule");

assert.strictEqual(groupLabel("aveugle", 138), "🙈 Jeux à l'aveugle");
assert.strictEqual(groupLabel("aveugle", 139), "🎮 Culture geek");
// Frontière Paris/UTC : 1er décembre 00h30 à Paris = 30 novembre 23h30 UTC.
assert.strictEqual(groupLabelForDate("culture", new Date("2026-11-30T23:30:00Z")), "🎬 Ciné-club");
assert.strictEqual(groupLabelForDate("culture", new Date("2026-11-30T22:30:00Z")), "🎬 Jeux de culture");
console.log("✓ libellés de groupe selon la saison");
