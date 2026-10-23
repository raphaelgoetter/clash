import assert from "assert";
import {
  seasonIdForDate,
  nomSaison,
  deMois,
  moisDeSaison,
  libelleMoisAnnee,
  getCurrentSeasonBounds,
  countRemainingWednesdays,
  countRemainingWeekdayOccurrences,
} from "./saison.js";

console.log("Running saison tests...");

// Numérotation : octobre 2026 = 137, un identifiant par mois.
assert.strictEqual(seasonIdForDate(new Date("2026-10-23T12:00:00Z")), 137);
assert.strictEqual(seasonIdForDate(new Date("2026-11-15T12:00:00Z")), 138);
assert.strictEqual(seasonIdForDate(new Date("2026-09-15T12:00:00Z")), 136);
assert.strictEqual(seasonIdForDate(new Date("2027-01-10T12:00:00Z")), 140, "Passage d'année");
console.log("✓ numérotation mensuelle continue");

// Noms affichés : élision devant une voyelle.
assert.strictEqual(nomSaison(137), "Saison d'Octobre");
assert.strictEqual(nomSaison(138), "Saison de Novembre");
assert.strictEqual(deMois(135), "d'Août");
assert.strictEqual(deMois(143), "d'Avril", "Avril 2027");
assert.deepStrictEqual(moisDeSaison(140), { annee: 2027, moisIndex: 0 });
assert.deepStrictEqual(moisDeSaison(125), { annee: 2025, moisIndex: 9 }, "Octobre 2025");
// Libellé avec année, à la frontière Paris/UTC (1er novembre 00h30 à Paris).
assert.strictEqual(libelleMoisAnnee(new Date("2026-10-31T23:30:00Z")), "Novembre 2026");
console.log("✓ noms de saison (mois, élision, année)");

// Bascule au 1er du mois à minuit, heure de Paris (UTC+1 en hiver).
assert.strictEqual(seasonIdForDate(new Date("2026-10-31T22:59:00Z")), 137, "31/10 23h59 à Paris");
assert.strictEqual(seasonIdForDate(new Date("2026-10-31T23:00:00Z")), 138, "1/11 00h00 à Paris");
// Été (UTC+2) : 1er août 00h00 à Paris = 31 juillet 22h00 UTC.
assert.strictEqual(seasonIdForDate(new Date("2026-07-31T21:59:00Z")), 134);
assert.strictEqual(seasonIdForDate(new Date("2026-07-31T22:00:00Z")), 135);
console.log("✓ bascule à minuit, heure de Paris (hiver et été)");

const { start, end } = getCurrentSeasonBounds(new Date("2026-10-23T12:00:00Z"));
assert.strictEqual(start.toISOString(), "2026-09-30T22:00:00.000Z", "1er octobre 00h00 (UTC+2)");
assert.strictEqual(end.toISOString(), "2026-10-31T23:00:00.000Z", "1er novembre 00h00 (UTC+1)");
console.log("✓ bornes du mois calendaire");

// Octobre 2026 : mercredis 7, 14, 21, 28 ; vendredis 2, 9, 16, 23, 30.
assert.strictEqual(countRemainingWednesdays(new Date("2026-10-21T08:00:00Z")), 1, "Reste le 28");
assert.strictEqual(countRemainingWednesdays(new Date("2026-10-28T08:00:00Z")), 0);
assert.strictEqual(countRemainingWeekdayOccurrences(new Date("2026-10-23T18:00:00Z"), 5), 1, "Reste le vendredi 30");
// Samedi 31 octobre : dernier jour de la saison, compté depuis le vendredi.
assert.strictEqual(countRemainingWeekdayOccurrences(new Date("2026-10-30T12:00:00Z"), 6), 1);
console.log("✓ occurrences restantes dans le mois");
