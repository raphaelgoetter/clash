import assert from "assert";
import {
  clampGauge,
  computeDayImpact,
  applyGaugeDelta,
  applyActionOverrides,
  rateDay,
  eventForDay,
  computeFinalTier,
} from "./tamagotchi.js";

const ACTIONS = {
  nourrir: {
    label: "Nourrir",
    emoji: "🍭",
    impact: { estomac: 25, energie: -10, moral: 0 },
  },
  bretzel: {
    label: "Bretzel",
    emoji: "🥨",
    impact: { estomac: 15, energie: -5, moral: 20 },
  },
  sieste: {
    label: "Sieste",
    emoji: "😴",
    impact: { estomac: -10, energie: 30, moral: -10 },
  },
  jouer: {
    label: "Entraînement",
    emoji: "🎾",
    impact: { estomac: -20, energie: -20, moral: 25 },
  },
  inspecter: { label: "Inspecter", emoji: "🔍", is_info_action: true },
};

const EVENEMENTS = [
  {
    id: "sans_appetit",
    jour: 2,
    modificateur_jauges: { estomac: -10, energie: 0, moral: 0 },
  },
  {
    id: "strasbourg",
    jour: 3,
    modificateur_jauges: { moral: 15, estomac: 0, energie: 0 },
  },
  {
    id: "nouveau_jouet",
    jour: 5,
    modificateur_jauges: { moral: 10, estomac: 0, energie: 0 },
  },
  {
    id: "canicule",
    jour: 6,
    modificateur_jauges: { energie: -10, estomac: 0, moral: -10 },
  },
  {
    id: "indigestion_bonbons",
    jour: 8,
    actions_modifiees: { nourrir: { estomac: 10 }, bretzel: { estomac: 5 } },
  },
  {
    id: "choucroute",
    jour: 9,
    modificateur_jauges: { energie: -15, estomac: 20, moral: 0 },
  },
];

async function main() {
  // ── clampGauge ──
  assert.strictEqual(clampGauge(150), 100);
  assert.strictEqual(clampGauge(-20), 0);
  assert.strictEqual(clampGauge(55), 55);

  // ── computeDayImpact ──
  // Zéro vote -> impact nul (l'événement peut quand même s'appliquer séparément)
  assert.deepStrictEqual(computeDayImpact({}, ACTIONS), {
    estomac: 0,
    energie: 0,
    moral: 0,
  });

  // Une seule action votée à 100% -> son impact s'applique intégralement
  assert.deepStrictEqual(computeDayImpact({ nourrir: 4 }, ACTIONS), {
    estomac: 25,
    energie: -10,
    moral: 0,
  });

  // Égalité 50/50 entre deux actions -> moyenne pondérée
  const impact5050 = computeDayImpact({ nourrir: 5, bretzel: 5 }, ACTIONS);
  assert.strictEqual(impact5050.estomac, 20); // (25+15)/2
  assert.strictEqual(impact5050.energie, -7.5); // (-10-5)/2
  assert.strictEqual(impact5050.moral, 10); // (0+20)/2

  // Inspecter (is_info_action) n'entre jamais dans le calcul même si présent
  assert.deepStrictEqual(
    computeDayImpact({ nourrir: 3, inspecter: 100 }, ACTIONS),
    {
      estomac: 25,
      energie: -10,
      moral: 0,
    },
  );

  // ── applyGaugeDelta ──
  assert.deepStrictEqual(
    applyGaugeDelta(
      { estomac: 95, energie: 50, moral: 5 },
      { estomac: 20, energie: 0, moral: -20 },
    ),
    { estomac: 100, energie: 50, moral: 0 },
  );
  // Arrondi d'un delta fractionnaire
  assert.deepStrictEqual(
    applyGaugeDelta(
      { estomac: 50, energie: 50, moral: 50 },
      { estomac: 20, energie: -7.5, moral: 10 },
    ),
    { estomac: 70, energie: 43, moral: 60 }, // Math.round(42.5) = 43 (arrondi JS "round half to +Infinity")
  );

  // ── rateDay ──
  const zones = { min: 40, max: 70 };
  // Bornes exactes incluses -> en zone
  assert.deepStrictEqual(
    rateDay({ estomac: 40, energie: 70, moral: 55 }, zones),
    {
      rating: "parfaite",
      starDelta: 1,
    },
  );
  // Juste hors bornes
  assert.deepStrictEqual(
    rateDay({ estomac: 39, energie: 70, moral: 55 }, zones).rating,
    "moyenne",
  );
  assert.deepStrictEqual(
    rateDay({ estomac: 71, energie: 70, moral: 55 }, zones).rating,
    "moyenne",
  );
  // 1 jauge hors zone -> journée moyenne, pas de pénalité
  assert.deepStrictEqual(
    rateDay({ estomac: 90, energie: 70, moral: 55 }, zones),
    {
      rating: "moyenne",
      starDelta: 0,
    },
  );
  // 2 jauges hors zone -> catastrophe
  assert.deepStrictEqual(
    rateDay({ estomac: 90, energie: 10, moral: 55 }, zones),
    {
      rating: "catastrophe",
      starDelta: -1,
    },
  );
  // 3 jauges hors zone -> catastrophe
  assert.deepStrictEqual(
    rateDay({ estomac: 90, energie: 10, moral: 95 }, zones),
    {
      rating: "catastrophe",
      starDelta: -1,
    },
  );

  // ── applyActionOverrides ──
  // Sans override : renvoie la config telle quelle.
  assert.deepStrictEqual(applyActionOverrides(ACTIONS, undefined), ACTIONS);

  // Fusion superficielle par axe : seul l'axe précisé change, les autres
  // axes de l'action modifiée (et les actions non listées) restent intacts.
  const overridden = applyActionOverrides(ACTIONS, {
    nourrir: { estomac: 10 },
    bretzel: { estomac: 5 },
  });
  assert.deepStrictEqual(overridden.nourrir.impact, {
    estomac: 10,
    energie: -10,
    moral: 0,
  });
  assert.deepStrictEqual(overridden.bretzel.impact, {
    estomac: 5,
    energie: -5,
    moral: 20,
  });
  assert.deepStrictEqual(overridden.sieste.impact, ACTIONS.sieste.impact);
  assert.deepStrictEqual(overridden.jouer.impact, ACTIONS.jouer.impact);

  // Un vote 100% Nourrir un jour d'Indigestion de bonbons ne rapporte que
  // +10 Estomac (au lieu de +25) — computeDayImpact doit refléter l'override.
  assert.deepStrictEqual(computeDayImpact({ nourrir: 4 }, overridden), {
    estomac: 10,
    energie: -10,
    moral: 0,
  });

  // ── eventForDay ──
  assert.strictEqual(eventForDay(2, EVENEMENTS).id, "sans_appetit");
  assert.strictEqual(eventForDay(3, EVENEMENTS).id, "strasbourg");
  assert.strictEqual(eventForDay(5, EVENEMENTS).id, "nouveau_jouet");
  assert.strictEqual(eventForDay(6, EVENEMENTS).id, "canicule");
  assert.strictEqual(eventForDay(8, EVENEMENTS).id, "indigestion_bonbons");
  assert.strictEqual(eventForDay(9, EVENEMENTS).id, "choucroute");
  assert.strictEqual(eventForDay(1, EVENEMENTS), null);
  assert.strictEqual(eventForDay(4, EVENEMENTS), null);
  assert.strictEqual(eventForDay(7, EVENEMENTS), null);
  assert.strictEqual(eventForDay(10, EVENEMENTS), null);

  // ── computeFinalTier ──
  assert.strictEqual(computeFinalTier(10), "S");
  assert.strictEqual(computeFinalTier(8), "S");
  assert.strictEqual(computeFinalTier(7), "B");
  assert.strictEqual(computeFinalTier(4), "B");
  assert.strictEqual(computeFinalTier(3), "F");
  assert.strictEqual(computeFinalTier(-5), "F");

  console.log("✓ tamagotchi service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
