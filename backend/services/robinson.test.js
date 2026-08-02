import assert from "assert";
import {
  rollHarvestAmount,
  rollCappedEventAmount,
  rollExplorerYield,
  harvestCapForEvent,
  isExplorerDisabled,
  computeDailyConsumption,
  applyFlooredDelta,
  updateZeroStreaks,
  computeGobelinsTheft,
  computeRaftSections,
  isRaftVictory,
  isSurvivalVictory,
  eventForDay,
  computeEpaveBonus,
} from "./robinson.js";

const CONFIG = { radeau_sections_max: 5, points_par_section: 5 };

const EVENEMENTS = [
  { jour: 3, id: "canicule" },
  { jour: 6, id: "ouragan" },
  { jour: 8, id: "gobelins" },
  { jour: 4, id: "colis_royal", condition_votants_veille: 12, bonus_ressources: 2 },
  { jour: 7, id: "epave", points_base: 26, points_min: 10 },
  { jour: 9, id: "indigestion_royale" },
];

function rngSequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function main() {
  // ── rollHarvestAmount — tirage 0 à 5, ~16,7% chacun ──
  assert.strictEqual(rollHarvestAmount(rngSequence([0])), 0);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.2])), 1);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.4])), 2);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.6])), 3);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.7])), 4);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.99])), 5);

  // ── rollCappedEventAmount — tirage dédié 0/1, 50/50 ──
  assert.strictEqual(rollCappedEventAmount(rngSequence([0])), 0);
  assert.strictEqual(rollCappedEventAmount(rngSequence([0.49])), 0);
  assert.strictEqual(rollCappedEventAmount(rngSequence([0.5])), 1);
  assert.strictEqual(rollCappedEventAmount(rngSequence([0.99])), 1);

  // ── rollExplorerYield — toujours 3 unités d'une seule et même ressource ──
  for (let i = 0; i < 200; i++) {
    const y = rollExplorerYield(Math.random);
    const values = [y.poisson, y.eau, y.bois];
    assert.strictEqual(values.filter((v) => v === 3).length, 1); // exactement une ressource à 3
    assert.strictEqual(values.filter((v) => v === 0).length, 2); // les deux autres à 0
    assert.strictEqual(y.poisson + y.eau + y.bois, 3);
  }
  assert.deepStrictEqual(rollExplorerYield(rngSequence([0])), { poisson: 3, eau: 0, bois: 0 });
  assert.deepStrictEqual(rollExplorerYield(rngSequence([0.4])), { poisson: 0, eau: 3, bois: 0 });
  assert.deepStrictEqual(rollExplorerYield(rngSequence([0.7])), { poisson: 0, eau: 0, bois: 3 });

  // ── harvestCapForEvent ──
  assert.strictEqual(harvestCapForEvent({ id: "canicule" }, "eau"), true);
  assert.strictEqual(harvestCapForEvent({ id: "canicule" }, "peche"), false);
  assert.strictEqual(harvestCapForEvent({ id: "ouragan" }, "peche"), true);
  assert.strictEqual(harvestCapForEvent({ id: "ouragan" }, "bois"), true);
  assert.strictEqual(harvestCapForEvent({ id: "ouragan" }, "eau"), false);
  assert.strictEqual(harvestCapForEvent({ id: "gobelins" }, "peche"), false);
  assert.strictEqual(harvestCapForEvent({ id: "indigestion_royale" }, "eau"), true);
  assert.strictEqual(harvestCapForEvent({ id: "indigestion_royale" }, "peche"), false);
  assert.strictEqual(harvestCapForEvent(null, "eau"), false);

  // ── isExplorerDisabled ──
  assert.strictEqual(isExplorerDisabled({ id: "gobelins" }), true);
  assert.strictEqual(isExplorerDisabled({ id: "canicule" }), false);
  assert.strictEqual(isExplorerDisabled(null), false);

  // ── computeDailyConsumption ──
  assert.deepStrictEqual(computeDailyConsumption(4), { poisson: 4, eau: 4, bois: 2 });
  assert.deepStrictEqual(computeDailyConsumption(5), { poisson: 5, eau: 5, bois: 3 }); // ceil(5/2)=3
  assert.deepStrictEqual(computeDailyConsumption(0), { poisson: 0, eau: 0, bois: 0 });

  // ── applyFlooredDelta — plancher 0 ──
  assert.deepStrictEqual(
    applyFlooredDelta({ poisson: 5, eau: 5, bois: 5 }, { poisson: 5, eau: 4, bois: 3 }),
    { poisson: 0, eau: 1, bois: 2 },
  );
  assert.deepStrictEqual(
    applyFlooredDelta({ poisson: 2, eau: 5, bois: 5 }, { poisson: 5, eau: 0, bois: 0 }),
    { poisson: 0, eau: 5, bois: 5 }, // jamais négatif
  );

  // ── updateZeroStreaks — cœur de la défaite ──
  // Jamais à 0 -> pas de défaite
  assert.deepStrictEqual(updateZeroStreaks({ poisson: 0, eau: 0, bois: 0 }, { poisson: 3, eau: 2, bois: 1 }), {
    streaks: { poisson: 0, eau: 0, bois: 0 },
    defeated: false,
  });
  // 1er jour à 0 -> streak=1, pas de défaite
  assert.deepStrictEqual(updateZeroStreaks({ poisson: 0, eau: 0, bois: 0 }, { poisson: 0, eau: 2, bois: 1 }), {
    streaks: { poisson: 1, eau: 0, bois: 0 },
    defeated: false,
  });
  // 2e jour consécutif à 0 -> streak=2, défaite
  assert.deepStrictEqual(updateZeroStreaks({ poisson: 1, eau: 0, bois: 0 }, { poisson: 0, eau: 2, bois: 1 }), {
    streaks: { poisson: 2, eau: 0, bois: 0 },
    defeated: true,
  });
  // À 0 puis remonte puis retombe -> le streak repasse à 1, pas 2 (bien réinitialisé entre-temps)
  assert.deepStrictEqual(updateZeroStreaks({ poisson: 0, eau: 0, bois: 0 }, { poisson: 0, eau: 2, bois: 1 }).streaks.poisson, 1);

  // ── computeGobelinsTheft ──
  assert.strictEqual(computeGobelinsTheft(4), true);
  assert.strictEqual(computeGobelinsTheft(5), false); // seuil inclusif : >=5 = pas de vol
  assert.strictEqual(computeGobelinsTheft(0), true);

  // ── computeRaftSections / isRaftVictory ──
  assert.strictEqual(computeRaftSections(24, 5), 4);
  assert.strictEqual(computeRaftSections(25, 5), 5);
  assert.strictEqual(isRaftVictory(24, CONFIG), false);
  assert.strictEqual(isRaftVictory(25, CONFIG), true);
  assert.strictEqual(isRaftVictory(30, CONFIG), true);

  // ── isSurvivalVictory ──
  assert.strictEqual(isSurvivalVictory(10, 10), false);
  assert.strictEqual(isSurvivalVictory(11, 10), true);

  // ── eventForDay ──
  assert.strictEqual(eventForDay(3, EVENEMENTS).id, "canicule");
  assert.strictEqual(eventForDay(6, EVENEMENTS).id, "ouragan");
  assert.strictEqual(eventForDay(8, EVENEMENTS).id, "gobelins");
  assert.strictEqual(eventForDay(5, EVENEMENTS), null);
  assert.strictEqual(eventForDay(1, EVENEMENTS), null);
  // Événement conditionnel (Colis Royal, jour 4) : ne se déclenche que si
  // la mobilisation de la veille atteint le seuil.
  assert.strictEqual(eventForDay(4, EVENEMENTS, 12)?.id, "colis_royal"); // pile au seuil -> déclenché
  assert.strictEqual(eventForDay(4, EVENEMENTS, 15)?.id, "colis_royal");
  assert.strictEqual(eventForDay(4, EVENEMENTS, 11), null); // sous le seuil -> journée normale
  assert.strictEqual(eventForDay(4, EVENEMENTS), null); // previousDayVoters par défaut = 0 -> pas déclenché
  // Événement non conditionnel (Épave, jour 7) : toujours déclenché, peu importe V.
  assert.strictEqual(eventForDay(7, EVENEMENTS, 0)?.id, "epave");
  assert.strictEqual(eventForDay(7, EVENEMENTS, 20)?.id, "epave");
  // Événement non conditionnel (Indigestion Royale, jour 9).
  assert.strictEqual(eventForDay(9, EVENEMENTS)?.id, "indigestion_royale");

  // ── computeEpaveBonus — dégressif selon les votants de la veille, plancher points_min ──
  const epave = { points_base: 26, points_min: 10 };
  assert.strictEqual(computeEpaveBonus(epave, 6), 20);
  assert.strictEqual(computeEpaveBonus(epave, 15), 11);
  assert.strictEqual(computeEpaveBonus(epave, 20), 10); // 26-20=6 < points_min -> plancher à 10
  assert.strictEqual(computeEpaveBonus(epave, 0), 26);

  console.log("✓ robinson service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
