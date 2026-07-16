import assert from "assert";
import {
  getFirstMondayOfMonth,
  getCurrentSeasonBounds,
  countWednesdaysInRange,
  countRemainingWednesdays,
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

  // countRemainingWednesdays — le mercredi du jour lui-même ne compte pas
  // (déjà représenté par la manche en cours, pas "restant")
  assert.strictEqual(countRemainingWednesdays(new Date("2026-07-15T13:00:00Z")), 2); // reste 22 et 29 juillet
  assert.strictEqual(countRemainingWednesdays(new Date("2026-07-22T13:00:00Z")), 1); // reste 29 juillet
  assert.strictEqual(countRemainingWednesdays(new Date("2026-07-29T13:00:00Z")), 0); // dernier mercredi de la saison

  // countRemainingWednesdays — jour hors mercredi (jeudi), doit rester cohérent
  assert.strictEqual(countRemainingWednesdays(new Date("2026-07-16T12:00:00Z")), 2); // reste 22 et 29 juillet

  // Cas réel ayant motivé ce calcul : le jeu Frame a démarré en cours de
  // saison (saison 134 commencée le 2026-07-06, mais 1ʳᵉ manche postée
  // seulement le 2026-07-15, le mercredi SUIVANT — le 2026-07-08 a été
  // manqué). X ne doit PAS compter les 4 mercredis calendaires de la
  // saison entière, seulement les 3 restants à partir du premier post
  // réel (manche 1 = 15/07, manche 2 = 22/07, manche 3 = 29/07, puis fin
  // de saison le 2026-08-03 avant le mercredi suivant).
  {
    const seasonManche = 1;
    const seasonMancheTotal = seasonManche + countRemainingWednesdays(new Date("2026-07-15T13:00:00Z"));
    assert.strictEqual(
      seasonMancheTotal,
      3,
      "X doit refléter les manches réellement restantes pour ce jeu, pas le total calendaire de la saison",
    );
  }

  console.log("✓ dateUtils service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
