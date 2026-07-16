import assert from "assert";
import {
  getFirstMondayOfMonth,
  getCurrentSeasonBounds,
  countWednesdaysInRange,
  computeSeasonMancheTotal,
} from "./dateUtils.js";

async function main() {
  // getFirstMondayOfMonth — mois commençant un lundi
  assert.strictEqual(
    getFirstMondayOfMonth(2026, 5).toISOString(), // juin 2026 commence un lundi
    "2026-06-01T00:00:00.000Z",
  );

  // getFirstMondayOfMonth — mois commençant un dimanche
  assert.strictEqual(
    getFirstMondayOfMonth(2026, 10).toISOString(), // novembre 2026 commence un dimanche
    "2026-11-02T00:00:00.000Z",
  );

  // getFirstMondayOfMonth — mois commençant un mardi
  assert.strictEqual(
    getFirstMondayOfMonth(2026, 8).toISOString(), // septembre 2026 commence un mardi
    "2026-09-07T00:00:00.000Z",
  );

  // getCurrentSeasonBounds — milieu de mois (saison 134 réelle, vérifiée empiriquement)
  {
    const { start, end } = getCurrentSeasonBounds(new Date("2026-07-16T12:00:00Z"));
    assert.strictEqual(start.toISOString(), "2026-07-06T00:00:00.000Z");
    assert.strictEqual(end.toISOString(), "2026-08-03T00:00:00.000Z");
  }

  // getCurrentSeasonBounds — pile le jour de bascule (premier lundi du mois)
  {
    const { start, end } = getCurrentSeasonBounds(new Date("2026-08-03T00:00:00Z"));
    assert.strictEqual(
      start.toISOString(),
      "2026-08-03T00:00:00.000Z",
      "Le jour de bascule doit démarrer la nouvelle saison, pas prolonger l'ancienne",
    );
    assert.strictEqual(end.toISOString(), "2026-09-07T00:00:00.000Z");
  }

  // getCurrentSeasonBounds — rollover décembre → janvier
  {
    const { start, end } = getCurrentSeasonBounds(new Date("2026-12-20T12:00:00Z"));
    assert.strictEqual(start.toISOString(), "2026-12-07T00:00:00.000Z");
    assert.strictEqual(end.toISOString(), "2027-01-04T00:00:00.000Z");
  }

  // countWednesdaysInRange
  assert.strictEqual(
    countWednesdaysInRange(
      new Date("2026-07-06T00:00:00Z"),
      new Date("2026-08-03T00:00:00Z"),
    ),
    4,
  );

  // computeSeasonMancheTotal — mois à 4 semaines (juillet 2026)
  assert.strictEqual(computeSeasonMancheTotal(new Date("2026-07-16T12:00:00Z")), 4);

  // computeSeasonMancheTotal — mois à 5 semaines (mars 2026 : 2026-03-02 → 2026-04-06)
  assert.strictEqual(computeSeasonMancheTotal(new Date("2026-03-10T12:00:00Z")), 5);

  console.log("✓ dateUtils service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
