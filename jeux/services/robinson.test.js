import assert from "assert";
import {
  rollHarvestAmount,
  rollModerateCapAmount,
  rollMildCapAmount,
  rollEventCappedAmount,
  rollExplorerYield,
  pickChefExplorateur,
  pickChefCharpentier,
  rollCharpentierRadeauPoints,
  harvestCapForEvent,
  isExplorerDisabled,
  isRadeauDisabled,
  computeDailyConsumption,
  applyFlooredDelta,
  updateZeroStreaks,
  computeGobelinsTheft,
  computeRaftSections,
  isRaftVictory,
  isSurvivalVictory,
  isTooSoonSinceLastClosure,
  eventForDay,
  computeEpaveBoisBonus,
  computePoissonsPourrisLoss,
  computeMancheScore,
  drawEventProgramme,
  isProgrammeValide,
  forecastForDay,
  computeEpuisementPalier,
  computeEpuisementMalus,
  computeHarvestAmount,
  computeExplorerAmount,
  isConstructionDone,
  constructionHarvestBonus,
  raftPointsPerVote,
  computeRadeauPlafondJour,
  clipRaftGain,
  computeAppauvrissement,
  harvestMaxForDay,
  computeDay1ConsumptionVoters,
  hasEmptyResource,
} from "./robinson.js";

const CONFIG = { radeau_sections_max: 5, points_par_section: 5 };

const EVENEMENTS = [
  { id: "canicule", famille: "eau_limitee" },
  { id: "ouragan" },
  { id: "gobelins" },
  { id: "colis_royal", condition_votants_veille: 12, bonus_ressources: 2 },
  { id: "epave", bois_base: 19, bois_min: 5 },
  { id: "indigestion_royale", famille: "eau_limitee" },
  { id: "poissons_pourris", condition_votants_veille_max: 10 },
];
const PROGRAMME = { 2: "poissons_pourris", 3: "canicule", 4: "colis_royal", 6: "ouragan", 7: "epave", 8: "gobelins", 9: "indigestion_royale" };

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

  // ── rollModerateCapAmount (Canicule) — 0, 1 ou 2, ~33% chacun ──
  assert.strictEqual(rollModerateCapAmount(rngSequence([0])), 0);
  assert.strictEqual(rollModerateCapAmount(rngSequence([0.4])), 1);
  assert.strictEqual(rollModerateCapAmount(rngSequence([0.99])), 2);

  // ── rollMildCapAmount (Ouragan, Indigestion Royale) — 1 ou 2, jamais 0 ──
  assert.strictEqual(rollMildCapAmount(rngSequence([0])), 1);
  assert.strictEqual(rollMildCapAmount(rngSequence([0.49])), 1);
  assert.strictEqual(rollMildCapAmount(rngSequence([0.5])), 2);
  assert.strictEqual(rollMildCapAmount(rngSequence([0.99])), 2);
  for (let i = 0; i < 200; i++) {
    assert.notStrictEqual(rollMildCapAmount(Math.random), 0);
  }

  // ── rollEventCappedAmount — dispatch par événement ──
  assert.strictEqual(rollEventCappedAmount({ id: "canicule" }, rngSequence([0])), 0);
  assert.strictEqual(rollEventCappedAmount({ id: "ouragan" }, rngSequence([0])), 1);
  assert.strictEqual(rollEventCappedAmount({ id: "indigestion_royale" }, rngSequence([0])), 1);

  // ── pickChefExplorateur — tiré parmi les votants de la veille, jamais un non-votant ──
  const VOTANTS = [
    { discordId: "a", actionId: "peche" },
    { discordId: "b", actionId: "eau" },
    { discordId: "c", actionId: "bois" },
  ];
  assert.strictEqual(pickChefExplorateur(VOTANTS, rngSequence([0])), "a");
  assert.strictEqual(pickChefExplorateur(VOTANTS, rngSequence([0.4])), "b");
  assert.strictEqual(pickChefExplorateur(VOTANTS, rngSequence([0.99])), "c");
  assert.strictEqual(pickChefExplorateur([], rngSequence([0])), null); // personne n'a voté hier -> pas de Chef
  assert.strictEqual(pickChefExplorateur(null, rngSequence([0])), null);

  // ── pickChefCharpentier — même tirage, exclut le Chef Explorateur si possible ──
  assert.strictEqual(pickChefCharpentier(VOTANTS, "a", rngSequence([0])), "b"); // "a" exclu -> b/c restants
  assert.strictEqual(pickChefCharpentier(VOTANTS, "a", rngSequence([0.99])), "c");
  assert.strictEqual(pickChefCharpentier(VOTANTS, null, rngSequence([0])), "a"); // pas d'exclusion
  const UN_SEUL_VOTANT = [{ discordId: "a", actionId: "peche" }];
  assert.strictEqual(pickChefCharpentier(UN_SEUL_VOTANT, "a", rngSequence([0])), "a"); // cumul inévitable
  assert.strictEqual(pickChefCharpentier([], "a", rngSequence([0])), null);

  // ── rollCharpentierRadeauPoints — tirage de récolte +1, doublé (2 à 12) ──
  assert.strictEqual(rollCharpentierRadeauPoints(rngSequence([0])), 2); // (0+1)*2
  assert.strictEqual(rollCharpentierRadeauPoints(rngSequence([0.99])), 12); // (5+1)*2

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
  // Indigestion Royale replafonne l'Eau (retour au durcissement, refonte du 29/08).
  assert.strictEqual(harvestCapForEvent({ id: "indigestion_royale" }, "eau"), true);
  assert.strictEqual(harvestCapForEvent(null, "eau"), false);

  // ── isExplorerDisabled ──
  assert.strictEqual(isExplorerDisabled({ id: "gobelins" }), true);
  assert.strictEqual(isExplorerDisabled({ id: "canicule" }), false);
  assert.strictEqual(isExplorerDisabled(null), false);

  // ── isRadeauDisabled — verrou anti-rush narré, fenêtre lue depuis la config ──
  const RADEAU_VERROUILLE = { jour_debut: 4, jour_fin: 5 };
  assert.strictEqual(isRadeauDisabled(1, RADEAU_VERROUILLE), false);
  assert.strictEqual(isRadeauDisabled(3, RADEAU_VERROUILLE), false);
  assert.strictEqual(isRadeauDisabled(4, RADEAU_VERROUILLE), true);
  assert.strictEqual(isRadeauDisabled(5, RADEAU_VERROUILLE), true);
  assert.strictEqual(isRadeauDisabled(6, RADEAU_VERROUILLE), false);
  assert.strictEqual(isRadeauDisabled(4, null), false); // aucun verrou configuré -> jamais bloqué
  assert.strictEqual(isRadeauDisabled(4, undefined), false);

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
  // 2e jour consécutif à 0 -> streak=2, défaite (limite durcie à 2, refonte du 29/08)
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

  // ── isTooSoonSinceLastClosure — garde-fou anti-double-avancée (26/08) ──
  const NOW = new Date("2026-08-27T12:00:00Z").getTime();
  assert.strictEqual(isTooSoonSinceLastClosure(null, NOW), false); // pas de date -> jamais bloqué
  assert.strictEqual(isTooSoonSinceLastClosure("2026-08-27T11:00:00Z", NOW), true); // 1h -> trop tôt
  assert.strictEqual(isTooSoonSinceLastClosure("2026-08-27T04:01:00Z", NOW), true); // ~7h59 -> encore trop tôt
  assert.strictEqual(isTooSoonSinceLastClosure("2026-08-27T03:00:00Z", NOW), false); // 9h -> OK
  assert.strictEqual(isTooSoonSinceLastClosure("2026-08-26T08:16:00Z", NOW), false); // ~28h (cas réel du 27/08) -> OK

  // ── eventForDay — lookup dans le programme tiré au Jour 1 ──
  assert.strictEqual(eventForDay(3, EVENEMENTS, 0, PROGRAMME).id, "canicule");
  assert.strictEqual(eventForDay(6, EVENEMENTS, 0, PROGRAMME).id, "ouragan");
  assert.strictEqual(eventForDay(8, EVENEMENTS, 0, PROGRAMME).id, "gobelins");
  assert.strictEqual(eventForDay(5, EVENEMENTS, 0, PROGRAMME), null); // jour sans événement
  assert.strictEqual(eventForDay(1, EVENEMENTS, 0, PROGRAMME), null);
  assert.strictEqual(eventForDay(3, EVENEMENTS, 0, null), null); // pas de programme -> aucun événement
  // Conditionnel à seuil minimum (Colis Royal)
  assert.strictEqual(eventForDay(4, EVENEMENTS, 12, PROGRAMME)?.id, "colis_royal"); // pile au seuil
  assert.strictEqual(eventForDay(4, EVENEMENTS, 11, PROGRAMME), null); // sous le seuil
  // Non conditionnel (Épave)
  assert.strictEqual(eventForDay(7, EVENEMENTS, 0, PROGRAMME)?.id, "epave");
  assert.strictEqual(eventForDay(7, EVENEMENTS, 20, PROGRAMME)?.id, "epave");
  // Conditionnel à seuil maximum (Poissons Pourris)
  assert.strictEqual(eventForDay(2, EVENEMENTS, 9, PROGRAMME)?.id, "poissons_pourris");
  assert.strictEqual(eventForDay(2, EVENEMENTS, 10, PROGRAMME), null); // pile au seuil
  assert.strictEqual(eventForDay(2, EVENEMENTS, 15, PROGRAMME), null);

  // ── forecastForDay — prévision sans filtre de condition ──
  assert.strictEqual(forecastForDay(2, EVENEMENTS, PROGRAMME).id, "poissons_pourris");
  assert.strictEqual(forecastForDay(5, EVENEMENTS, PROGRAMME), null);
  assert.strictEqual(forecastForDay(2, EVENEMENTS, null), null);

  // ── drawEventProgramme — chaque événement une fois, Jours 2..duree, familles non consécutives ──
  const SIX = EVENEMENTS.filter((e) => e.id !== "colis_royal");
  for (let i = 0; i < 300; i++) {
    const prog = drawEventProgramme(SIX, 7, Math.random);
    assert.deepStrictEqual(Object.keys(prog).map(Number).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
    assert.deepStrictEqual(Object.values(prog).sort(), SIX.map((e) => e.id).sort());
    assert.ok(isProgrammeValide(prog, SIX));
  }
  // Moins d'événements que de jours : certains jours restent calmes
  const prog3 = drawEventProgramme(SIX.slice(0, 3), 7, Math.random);
  assert.strictEqual(Object.keys(prog3).length, 3);
  assert.ok(Object.keys(prog3).every((j) => j >= 2 && j <= 7));
  // isProgrammeValide : deux plafonds d'Eau consécutifs refusés
  assert.strictEqual(isProgrammeValide({ 3: "canicule", 4: "indigestion_royale" }, SIX), false);
  assert.strictEqual(isProgrammeValide({ 3: "canicule", 5: "indigestion_royale" }, SIX), true);

  // ── computeEpuisementPalier / computeEpuisementMalus ──
  const EP = { palier_jour1: 4, diviseur: 4, palier_min: 3, explorer_min: 1 };
  assert.strictEqual(computeEpuisementPalier(null, EP), 4); // Jour 1
  assert.strictEqual(computeEpuisementPalier(0, EP), 4);
  assert.strictEqual(computeEpuisementPalier(14, EP), 4); // ceil(14/4)
  assert.strictEqual(computeEpuisementPalier(17, EP), 5);
  assert.strictEqual(computeEpuisementPalier(6, EP), 3); // plancher palier_min
  assert.strictEqual(computeEpuisementPalier(14, null), null); // mécanique désactivée
  assert.strictEqual(computeEpuisementMalus(1, 4), 0);
  assert.strictEqual(computeEpuisementMalus(4, 4), 0);
  assert.strictEqual(computeEpuisementMalus(5, 4), 1);
  assert.strictEqual(computeEpuisementMalus(9, 4), 2);
  assert.strictEqual(computeEpuisementMalus(9, null), 0); // ancien état sans palier

  // ── computeHarvestAmount / computeExplorerAmount ──
  assert.strictEqual(computeHarvestAmount({ baseRoll: 3 }), 3);
  assert.strictEqual(computeHarvestAmount({ baseRoll: 1, malus: 2 }), 0); // plancher 0 avant bonus
  assert.strictEqual(computeHarvestAmount({ baseRoll: 1, malus: 2, isChef: true, bonusConstruction: 1 }), 2);
  assert.strictEqual(computeHarvestAmount({ baseRoll: 5, malus: 1, bonusConstruction: 1 }), 5);
  assert.strictEqual(computeExplorerAmount(0, 1), 3);
  assert.strictEqual(computeExplorerAmount(1, 1), 2);
  assert.strictEqual(computeExplorerAmount(5, 1), 1); // jamais sous le minimum

  // ── Constructions ──
  const CONSTR = { filet: { cout: 4 }, citerne: { cout: 4 }, atelier: { cout: 4 } };
  assert.strictEqual(isConstructionDone(3, CONSTR.filet), false);
  assert.strictEqual(isConstructionDone(4, CONSTR.filet), true);
  assert.strictEqual(isConstructionDone(4, undefined), false);
  assert.strictEqual(constructionHarvestBonus("peche", { filet: 4 }, CONSTR), 1);
  assert.strictEqual(constructionHarvestBonus("peche", { filet: 3 }, CONSTR), 0);
  assert.strictEqual(constructionHarvestBonus("eau", { citerne: 4 }, CONSTR), 1);
  assert.strictEqual(constructionHarvestBonus("bois", { filet: 4, citerne: 4 }, CONSTR), 0);
  assert.strictEqual(constructionHarvestBonus("peche", { filet: 4 }, undefined), 0); // config sans constructions
  assert.strictEqual(raftPointsPerVote({ atelier: 4 }, CONSTR), 2);
  assert.strictEqual(raftPointsPerVote({ atelier: 2 }, CONSTR), 1);
  assert.strictEqual(raftPointsPerVote({}, CONSTR), 1);

  // ── Appauvrissement de l'île ──
  const APPAUV = { appauvrissement: [0, 0, 0, 1, 1, 2, 2] };
  assert.strictEqual(computeAppauvrissement(1, APPAUV), 0);
  assert.strictEqual(computeAppauvrissement(4, APPAUV), 1);
  assert.strictEqual(computeAppauvrissement(7, APPAUV), 2);
  assert.strictEqual(computeAppauvrissement(9, APPAUV), 2); // au-delà du calendrier : dernière valeur
  assert.strictEqual(computeAppauvrissement(4, {}), 0); // absent -> aucun appauvrissement
  assert.strictEqual(harvestMaxForDay(1, APPAUV), 5);
  assert.strictEqual(harvestMaxForDay(6, APPAUV), 3);
  assert.strictEqual(rollHarvestAmount(rngSequence([0.99]), 3), 3); // borne haute réduite
  assert.strictEqual(rollHarvestAmount(rngSequence([0.5]), 3), 2);

  // ── Plafond quotidien du Radeau ──
  assert.strictEqual(computeRadeauPlafondJour({ radeau_sections_max_par_jour: 2, points_par_section: 6 }), 12);
  assert.strictEqual(computeRadeauPlafondJour({ points_par_section: 6 }), Infinity); // pas de plafond configuré
  assert.strictEqual(clipRaftGain(2, 0, 12), 2);
  assert.strictEqual(clipRaftGain(2, 11, 12), 1); // gain partiel
  assert.strictEqual(clipRaftGain(2, 12, 12), 0); // plafond atteint
  assert.strictEqual(clipRaftGain(12, 4, 12), 8); // Chef charpentier écrêté
  assert.strictEqual(clipRaftGain(5, 3, Infinity), 5);

  // ── Consommation du Jour 1 / dernière nuit ──
  assert.strictEqual(computeDay1ConsumptionVoters(14, 0.5), 7);
  assert.strictEqual(computeDay1ConsumptionVoters(15, 0.5), 8); // arrondi supérieur
  assert.strictEqual(computeDay1ConsumptionVoters(15, undefined), 15); // pas de ratio -> V entier
  assert.strictEqual(hasEmptyResource({ poisson: 1, eau: 1, bois: 1 }), false);
  assert.strictEqual(hasEmptyResource({ poisson: 1, eau: 0, bois: 1 }), true);

  // ── computePoissonsPourrisLoss — la courbe est calée sur `threshold`, jamais figée ──
  // threshold=10 (valeur historique) : pic à V=3 (perte 7), symétrique des deux côtés.
  assert.strictEqual(computePoissonsPourrisLoss(9, 10), 1);
  assert.strictEqual(computePoissonsPourrisLoss(8, 10), 2);
  assert.strictEqual(computePoissonsPourrisLoss(7, 10), 3);
  assert.strictEqual(computePoissonsPourrisLoss(6, 10), 4);
  assert.strictEqual(computePoissonsPourrisLoss(5, 10), 5);
  assert.strictEqual(computePoissonsPourrisLoss(4, 10), 6);
  assert.strictEqual(computePoissonsPourrisLoss(3, 10), 7);
  assert.strictEqual(computePoissonsPourrisLoss(2, 10), 6);
  assert.strictEqual(computePoissonsPourrisLoss(1, 10), 5);
  // Plancher à 1 au-delà du croisement (10-V devient négatif) — sans lui,
  // l'événement inverserait en gain de Poisson.
  assert.strictEqual(computePoissonsPourrisLoss(10, 10), 1);
  assert.strictEqual(computePoissonsPourrisLoss(13, 10), 1);
  // threshold=14 (config actuelle, relevée le 24/08) : pic recalé à V=5 (perte 9),
  // atterrissage en douceur (plancher 1) juste avant 14 au lieu de 9.
  assert.strictEqual(computePoissonsPourrisLoss(5, 14), 9);
  assert.strictEqual(computePoissonsPourrisLoss(9, 14), 5);
  assert.strictEqual(computePoissonsPourrisLoss(13, 14), 1);

  // ── computeEpaveBoisBonus — don de Bois (inversé le 28/08, avant : points directs) ──
  // dégressif selon les votants de la veille, plancher bois_min.
  const epave = { bois_base: 19, bois_min: 5 };
  assert.strictEqual(computeEpaveBoisBonus(epave, 9), 10);
  assert.strictEqual(computeEpaveBoisBonus(epave, 14), 5);
  assert.strictEqual(computeEpaveBoisBonus(epave, 20), 5); // 19-20<0 < bois_min -> plancher à 5
  assert.strictEqual(computeEpaveBoisBonus(epave, 0), 19);

  // ── computeMancheScore — classement entre manches (jeu rejoué dans l'année) ──
  assert.strictEqual(computeMancheScore("victoire_radeau", 5, 10), 1006); // 1000 + (11-5)
  assert.strictEqual(computeMancheScore("victoire_radeau", 1, 10), 1010); // le plus rapide possible
  assert.strictEqual(computeMancheScore("victoire_radeau", 11, 10), 1000); // bonus de vitesse à 0, jamais négatif
  assert.strictEqual(computeMancheScore("victoire_jour11", 11, 10), 500); // toujours à égalité entre elles
  assert.strictEqual(computeMancheScore("victoire_jour11", 11, 20), 500); // indépendant de dureeJours
  assert.strictEqual(computeMancheScore("defaite", 7, 10), 7); // jours survécus
  assert.strictEqual(computeMancheScore("defaite", 1, 10), 1);
  // Hiérarchie stricte : toute victoire Radeau > toute victoire Jour 11 > toute défaite.
  assert.ok(computeMancheScore("victoire_radeau", 11, 10) > computeMancheScore("victoire_jour11", 11, 10));
  assert.ok(computeMancheScore("victoire_jour11", 11, 10) > computeMancheScore("defaite", 10, 10));

  console.log("✓ robinson service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
