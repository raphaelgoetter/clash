import assert from "assert";
import { REFONTE_SEASON, REFONTE_PAIRS, getRefonteGame, getWiredGame, groupLabel, groupLabelForDate } from "./refonte.js";
import { getActiveCultureGame } from "./jeuxculture.js";
import { getActiveBlindGame } from "./jeuxaveugle.js";
import { getActiveLetterGame } from "./jeuxdelettres.js";
import { getActiveVisualGame } from "./jeuxvisuels.js";
import { getActiveClashGame, publicationWeekday, CLASH_WEEKDAY } from "./jeuxclash.js";
import { countRemainingWeekdayOccurrences } from "./saison.js";
import { computeSeasonMancheTotal as triviaMancheTotal } from "./trivia.js";
import { computeSeasonMancheTotal as zoomMancheTotal } from "./zoom.js";

console.log("Running refonte tests...");

const GROUPS = {
  culture: getActiveCultureGame,
  aveugle: getActiveBlindGame,
  lettres: getActiveLetterGame,
  visuels: getActiveVisualGame,
  clash: getActiveClashGame,
};

// Octobre 2026 (137) : dernière saison des anciennes paires, intacte.
assert.strictEqual(getActiveCultureGame(137), "trivia");
assert.strictEqual(getActiveBlindGame(137), "blindroyale");
assert.strictEqual(getActiveLetterGame(137), "pelemele");
assert.strictEqual(getActiveVisualGame(137), "palette");
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

// Novembre 2026 = 1er jeu de chaque nouvelle paire, décembre = 2nd.
assert.strictEqual(getActiveCultureGame(138), "synopsis");
assert.strictEqual(getActiveBlindGame(138), "triviageek");
assert.strictEqual(getActiveLetterGame(138), "concept");
assert.strictEqual(getActiveVisualGame(138), "zoom2");
assert.strictEqual(getActiveVisualGame(139), "platpays");
assert.strictEqual(getActiveCultureGame(139), "frame");
assert.strictEqual(getActiveBlindGame(139), "intrus");
assert.strictEqual(getActiveLetterGame(139), "pelemele");
console.log("✓ calendrier novembre/décembre");

// Jeux prêts : avant la bascule tout passe ; après, seuls ceux de
// REFONTE_PRETS (Zoom carte n'est plus lancé par le groupe visuels).
assert.strictEqual(getWiredGame("visuels", 137, "palette"), "palette");
assert.strictEqual(getWiredGame("visuels", 139, "zoom"), null);
for (const [group, getActive] of Object.entries(GROUPS)) {
  for (const s of [138, 139]) assert.strictEqual(getWiredGame(group, s, getActive(s)), getActive(s), `${group} ${s}`);
}
console.log("✓ seuls les jeux prêts sont lancés après la bascule");

// Groupe Clash : rien avant la bascule, puis Trivia (nov.) / Zoom carte
// (déc.), jamais Zoom carte et Zoom logo le même mois.
assert.strictEqual(getActiveClashGame(137), null);
assert.strictEqual(getActiveClashGame(138), "trivia");
assert.strictEqual(getActiveClashGame(139), "zoom");
for (let s = 138; s < 150; s++) {
  assert.ok(!(getActiveClashGame(s) === "zoom" && getActiveVisualGame(s) === "zoom2"), `saison ${s}`);
}
// Créneau : ancien jour jusqu'en octobre, mardi ensuite (total de manches).
assert.strictEqual(publicationWeekday(137, 3), 3);
assert.strictEqual(publicationWeekday(138, 3), CLASH_WEEKDAY);
const oct = new Date("2026-10-28T18:00:00Z");
const nov = new Date("2026-11-03T18:00:00Z");
const dec = new Date("2026-12-01T18:00:00Z");
assert.strictEqual(triviaMancheTotal(1, oct), 1 + countRemainingWeekdayOccurrences(oct, 3));
assert.strictEqual(triviaMancheTotal(1, nov), 1 + countRemainingWeekdayOccurrences(nov, CLASH_WEEKDAY));
assert.strictEqual(zoomMancheTotal(1, dec), 1 + countRemainingWeekdayOccurrences(dec, CLASH_WEEKDAY));
console.log("✓ groupe Clash (alternance et créneau du mardi)");

assert.strictEqual(groupLabel("aveugle", 137), "🙈 Jeux à l'aveugle");
assert.strictEqual(groupLabel("aveugle", 138), "🎮 Culture geek");
// Frontière Paris/UTC : 1er novembre 00h30 à Paris = 31 octobre 23h30 UTC.
assert.strictEqual(groupLabelForDate("culture", new Date("2026-10-31T23:30:00Z")), "🎬 Ciné-club");
assert.strictEqual(groupLabelForDate("culture", new Date("2026-10-31T22:30:00Z")), "🎬 Jeux de culture");
console.log("✓ libellés de groupe selon la saison");
