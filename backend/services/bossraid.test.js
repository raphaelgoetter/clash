import assert from "assert";
import {
  computeProtection,
  activeEventForDay,
  resolveDayParams,
  applyStatReduction,
  protectionMultiplier,
  computeSorcierDamage,
  computeArcheresDamage,
  computeDefenseEffective,
  computeActionCounts,
  computeComboDamage,
  allocateOptimalProtection,
  computeBestCombo,
  gradeForRatio,
  cumulativeScore,
  computeUltimateMultiplier,
  isChevalierVoteAllowed,
  computeCloture,
  MAX_VOTES_PAR_ROLE,
} from "./bossraid.js";

const CONFIG = {
  boss_stats_base: { defense: 5, resistance: 5 },
  roles: {
    chevalier: { label: "Chevalier", emoji: "🛡️", protection_slots: 2 },
    voleuse: { label: "Voleuse", emoji: "🗡️", degats: 20, debuff_defense_par_vote: 1 },
    sorcier: { label: "Sorcier", emoji: "🔮", degats: 90 },
    archeres: { label: "Archères", emoji: "🏹", degats: 80 },
    princesse: { label: "Princesse", emoji: "👑", degats: 25 },
  },
  evenements_boss: [
    { jour: 3, id: "frappe_lethale", effects: { malus_multiplier_override: 0 } },
    { jour: 4, id: "muraille", effects: { defense_override: 10 } },
    { jour: 5, id: "point_faible", effects: { resistance_override: 1 } },
    { jour: 6, id: "miroir_mana", effects: { sorcier_multiplier: 0.5 } },
    { jour: 7, id: "bouclier_instable", effects: { protection_slots_override: 1 } },
    { jour: 8, id: "rage", effects: { voleuse_debuff_disabled: true } },
  ],
};

async function main() {
  // ── computeProtection (inchangé — allocation réelle par ordre d'arrivée) ──
  assert.deepStrictEqual(
    computeProtection(1, [{ discordId: "a", votedAt: "t1" }], 2),
    { capacite: 2, protectedIds: new Set(["a"]), tousProteges: true },
  );
  {
    const distants = [
      { discordId: "a", votedAt: "2020-01-01T00:00:03Z" },
      { discordId: "b", votedAt: "2020-01-01T00:00:01Z" },
      { discordId: "c", votedAt: "2020-01-01T00:00:02Z" },
    ];
    const r = computeProtection(1, distants, 2); // capacité 2, 3 distants -> les 2 premiers par vote_at
    assert.strictEqual(r.capacite, 2);
    assert.strictEqual(r.tousProteges, false);
    assert.deepStrictEqual(r.protectedIds, new Set(["b", "c"]));
  }
  {
    const r = computeProtection(0, [{ discordId: "a", votedAt: "t1" }], 2); // aucun Chevalier -> capacité 0
    assert.strictEqual(r.capacite, 0);
    assert.strictEqual(r.tousProteges, false);
    assert.strictEqual(r.protectedIds.size, 0);
  }

  // ── activeEventForDay ──
  assert.strictEqual(activeEventForDay(3, CONFIG.evenements_boss)?.id, "frappe_lethale");
  assert.strictEqual(activeEventForDay(1, CONFIG.evenements_boss), null);

  // ── resolveDayParams — base sans événement, puis chaque type d'effet ──
  {
    const p = resolveDayParams(1, CONFIG);
    assert.strictEqual(p.event, null);
    assert.strictEqual(p.defense, 5);
    assert.strictEqual(p.resistance, 5);
    assert.strictEqual(p.protectionSlots, 2);
    assert.strictEqual(p.malusMultiplier, 0.5);
    assert.strictEqual(p.sorcierMultiplier, 1);
    assert.strictEqual(p.archeresMultiplier, 1);
    assert.strictEqual(p.princesseMultiplier, 1);
    assert.strictEqual(p.voleuseDebuffDisabled, false);
  }
  assert.strictEqual(resolveDayParams(3, CONFIG).malusMultiplier, 0); // Frappe Léthale
  assert.strictEqual(resolveDayParams(4, CONFIG).defense, 10); // Muraille
  assert.strictEqual(resolveDayParams(5, CONFIG).resistance, 1); // Point Faible
  assert.strictEqual(resolveDayParams(6, CONFIG).sorcierMultiplier, 0.5); // Miroir de Mana
  assert.strictEqual(resolveDayParams(7, CONFIG).protectionSlots, 1); // Bouclier Instable
  assert.strictEqual(resolveDayParams(8, CONFIG).voleuseDebuffDisabled, true); // Rage

  // ── applyStatReduction ──
  assert.strictEqual(applyStatReduction(100, 0), 100);
  assert.strictEqual(applyStatReduction(100, 5), 50);
  assert.strictEqual(applyStatReduction(100, 10), 0);
  assert.strictEqual(applyStatReduction(100, 15), 0); // plafonné à 10

  // ── protectionMultiplier — malus du jour, jamais de malus si protégé ──
  assert.strictEqual(protectionMultiplier(true, 0.5), 1);
  assert.strictEqual(protectionMultiplier(true, 0), 1); // protégé -> jamais de malus, même Frappe Léthale
  assert.strictEqual(protectionMultiplier(false, 0.5), 0.5);
  assert.strictEqual(protectionMultiplier(false, 0), 0);

  // ── computeSorcierDamage — fixe, aucun aléatoire ──
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, malusMultiplier: 0.5, sorcierMultiplier: 1 }),
    100,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: false, malusMultiplier: 0.5, sorcierMultiplier: 1 }),
    50,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: false, malusMultiplier: 0, sorcierMultiplier: 1 }),
    0,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, malusMultiplier: 0.5, sorcierMultiplier: 0.5 }),
    50,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 10, protege: true, malusMultiplier: 0.5, sorcierMultiplier: 1 }),
    0,
  );

  // ── computeArcheresDamage — fixe, aucun aléatoire ──
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: true, malusMultiplier: 0.5, archeresMultiplier: 1 }),
    90,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 10, protege: true, malusMultiplier: 0.5, archeresMultiplier: 1 }),
    0,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: false, malusMultiplier: 0.5, archeresMultiplier: 1 }),
    45,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: false, malusMultiplier: 0, archeresMultiplier: 1 }),
    0,
  );

  // ── computeDefenseEffective — débuff Voleuse déterministe (-1/vote, plancher 0) ──
  assert.strictEqual(computeDefenseEffective(0, { defense: 5, voleuseDebuffDisabled: false }, CONFIG), 5);
  assert.strictEqual(computeDefenseEffective(3, { defense: 5, voleuseDebuffDisabled: false }, CONFIG), 2);
  assert.strictEqual(computeDefenseEffective(10, { defense: 5, voleuseDebuffDisabled: false }, CONFIG), 0); // plancher 0
  assert.strictEqual(computeDefenseEffective(10, { defense: 5, voleuseDebuffDisabled: true }, CONFIG), 5); // Rage du Boss : débuff neutralisé
  // "Rôles identiques limités à 10" — le 11e vote Voleuse n'a plus d'effet.
  assert.strictEqual(
    computeDefenseEffective(11, { defense: 5, voleuseDebuffDisabled: false }, CONFIG),
    computeDefenseEffective(MAX_VOTES_PAR_ROLE, { defense: 5, voleuseDebuffDisabled: false }, CONFIG),
  );

  // ── computeActionCounts — 5 rôles d'action, Princesse incluse (elle
  // inflige désormais un dégât fixe, elle n'est plus hors-combo) ──
  assert.deepStrictEqual(
    computeActionCounts({ u1: "chevalier", u2: "voleuse", u3: "sorcier", u4: "archeres", u5: "princesse" }),
    { chevalier: 1, voleuse: 1, sorcier: 1, archeres: 1, princesse: 1 },
  );
  assert.deepStrictEqual(
    computeActionCounts({ u1: "princesse" }),
    { chevalier: 0, voleuse: 0, sorcier: 0, archeres: 0, princesse: 1 },
  );

  // ── computeComboDamage — combinaison agrégée (jour 1, sans événement) ──
  {
    const dayParams = resolveDayParams(1, CONFIG);
    const counts = { chevalier: 1, voleuse: 2, sorcier: 1, archeres: 1, princesse: 0 };
    // Défense effective = 5 - 2 = 3. Sorcier protégé = round(90*0.5) = 45.
    // Archères protégée = round(80*(1-0.3)) = 56. Voleuse = 2*20 = 40.
    const r = computeComboDamage(counts, dayParams, CONFIG, { protectedSorcier: 1, protectedArcheres: 1 });
    assert.strictEqual(r.defenseEffective, 3);
    assert.deepStrictEqual(r.breakdown, { voleuse: 40, princesse: 0, sorcier: 45, archeres: 56 });
    assert.strictEqual(r.total, 141);
  }

  // ── computeComboDamage — Princesse : dégât fixe, insensible à TOUT SAUF
  // son propre princesseMultiplier (malus, protection, Défense/Résistance,
  // sorcierMultiplier/archeresMultiplier ne la concernent jamais) ──
  {
    const counts = { chevalier: 0, voleuse: 0, sorcier: 0, archeres: 0, princesse: 3 };
    const dayParamsDur = {
      defense: 10, resistance: 10, protectionSlots: 0,
      malusMultiplier: 0, sorcierMultiplier: 0.1, archeresMultiplier: 0.1, princesseMultiplier: 1, voleuseDebuffDisabled: true,
    };
    const dayParamsFacile = {
      defense: 0, resistance: 0, protectionSlots: 10,
      malusMultiplier: 1, sorcierMultiplier: 5, archeresMultiplier: 5, princesseMultiplier: 1, voleuseDebuffDisabled: false,
    };
    const rDur = computeComboDamage(counts, dayParamsDur, CONFIG, { protectedSorcier: 0, protectedArcheres: 0 });
    const rFacile = computeComboDamage(counts, dayParamsFacile, CONFIG, { protectedSorcier: 0, protectedArcheres: 0 });
    assert.strictEqual(rDur.breakdown.princesse, 75); // 3 x 25, identique quel que soit le contexte
    assert.strictEqual(rFacile.breakdown.princesse, 75);

    // Exception assumée : princesseMultiplier (levier événementiel dédié,
    // voir Jour 3 "Brouillard Occultant") scale bien la valeur fixe.
    const rBoost = computeComboDamage(
      counts,
      { ...dayParamsFacile, princesseMultiplier: 3 },
      CONFIG,
      { protectedSorcier: 0, protectedArcheres: 0 },
    );
    assert.strictEqual(rBoost.breakdown.princesse, 225); // 3 x 25 x 3
  }

  // ── computeComboDamage — "Rôles identiques limités à 10" : le 11e vote
  // d'un MÊME rôle n'a plus aucun effet ──
  {
    const dayParams = resolveDayParams(1, CONFIG);
    // Voleuse/Princesse : 11 votes -> identique à 10 (le 11e ignoré).
    const r11 = computeComboDamage(
      { chevalier: 0, voleuse: 11, sorcier: 0, archeres: 0, princesse: 11 },
      dayParams, CONFIG, { protectedSorcier: 0, protectedArcheres: 0 },
    );
    const r10 = computeComboDamage(
      { chevalier: 0, voleuse: 10, sorcier: 0, archeres: 0, princesse: 10 },
      dayParams, CONFIG, { protectedSorcier: 0, protectedArcheres: 0 },
    );
    assert.strictEqual(r11.total, r10.total);
    assert.deepStrictEqual(r11.breakdown, r10.breakdown);

    // Sorcier : 15 votes dont 6 "protégés" (déjà plafonnés par l'appelant,
    // comme le fait evaluateCandidateCombo/computeCloture) -> seuls 10
    // comptent (6 protégés + 4 non protégés), les 5 derniers sont gâchés.
    const rSorcier = computeComboDamage(
      { chevalier: 0, voleuse: 0, sorcier: 15, archeres: 0, princesse: 0 },
      dayParams, CONFIG, { protectedSorcier: 6, protectedArcheres: 0 },
    );
    // Protégé = round(90*0.5) = 45, non protégé = round(45*0.5) = 23.
    assert.strictEqual(rSorcier.breakdown.sorcier, 6 * 45 + 4 * 23);
  }

  // ── computeCloture — bout-en-bout, plafond appliqué à la clôture RÉELLE ──
  // Jour 1 (sans événement) : 12 Sorciers réels (u1..u12, votés dans cet
  // ordre) + 2 Chevaliers (capacité 4). Seuls les 10 premiers Sorciers par
  // ordre d'arrivée comptent (u11/u12 gâchés) ; parmi eux, les 4 premiers
  // (capacité Chevalier) sont protégés, les 6 suivants non protégés.
  {
    const votesRaw = { chev1: "chevalier", chev2: "chevalier" };
    const voteAtRaw = {};
    for (let i = 1; i <= 12; i++) {
      const id = `u${i}`;
      votesRaw[id] = "sorcier";
      voteAtRaw[id] = `2020-01-01T00:00:${String(i).padStart(2, "0")}Z`;
    }
    const dayParams = resolveDayParams(1, CONFIG);
    const r = computeCloture({
      jour: 1,
      votesRaw,
      voteAtRaw,
      dayParams,
      config: CONFIG,
      totalDegatsAvant: 0,
      totalDegatsOptimalAvant: 0,
    });
    assert.strictEqual(r.actionCounts.sorcier, 12); // compte RÉEL affiché, jamais tronqué
    assert.strictEqual(r.totalVotesAction, 14);
    // 4 protégés x 45 + 6 non protégés x 23 = 180 + 138 = 318 (u11/u12 gâchés)
    assert.strictEqual(r.totalDamageDuJour, 318);
  }

  // ── allocateOptimalProtection — priorité au rôle à plus forte plus-value ──
  assert.deepStrictEqual(allocateOptimalProtection(2, 3, 3, 10, 5), { protectedSorcier: 2, protectedArcheres: 1 });
  assert.deepStrictEqual(allocateOptimalProtection(2, 3, 0, 10, 5), { protectedSorcier: 0, protectedArcheres: 0 });
  assert.deepStrictEqual(allocateOptimalProtection(2, 3, 10, 10, 5), { protectedSorcier: 2, protectedArcheres: 3 });
  assert.deepStrictEqual(allocateOptimalProtection(2, 3, 3, 5, 10), { protectedSorcier: 0, protectedArcheres: 3 });

  // ── gradeForRatio ──
  assert.strictEqual(gradeForRatio(1), "SS");
  assert.strictEqual(gradeForRatio(0.98), "SS");
  assert.strictEqual(gradeForRatio(0.9), "S");
  assert.strictEqual(gradeForRatio(0.8), "A");
  assert.strictEqual(gradeForRatio(0.6), "B");
  assert.strictEqual(gradeForRatio(0.5), "C");
  assert.strictEqual(gradeForRatio(0.1), "D");

  // ── cumulativeScore ──
  assert.strictEqual(cumulativeScore(0, 0), null); // rien à comparer avant la 1ère clôture
  assert.strictEqual(cumulativeScore(100, 100), "SS");
  assert.strictEqual(cumulativeScore(50, 100), "C");

  // ── computeUltimateMultiplier — bonus/malus basé sur les 2 derniers scores ──
  assert.strictEqual(computeUltimateMultiplier(null, null), 1); // pas d'historique (jour 1/2)
  assert.strictEqual(computeUltimateMultiplier("A", "SS"), 1); // hier neutre -> peu importe avant-hier
  assert.strictEqual(computeUltimateMultiplier("S", "A"), 1.1); // S hier seul
  assert.strictEqual(computeUltimateMultiplier("SS", "B"), 1.1); // SS hier seul
  assert.strictEqual(computeUltimateMultiplier("SS", "S"), 1.3); // SS/S 2 jours de suite
  assert.strictEqual(computeUltimateMultiplier("S", "SS"), 1.3);
  assert.strictEqual(computeUltimateMultiplier("C", "SS"), 0.9); // C hier -> malus, peu importe avant-hier
  assert.strictEqual(computeUltimateMultiplier("D", null), 0.9);
  assert.strictEqual(computeUltimateMultiplier("B", "SS"), 1); // B/A hier -> neutre

  // ── isChevalierVoteAllowed ──
  assert.strictEqual(isChevalierVoteAllowed(undefined), true);
  assert.strictEqual(isChevalierVoteAllowed(null), true);
  assert.strictEqual(isChevalierVoteAllowed("sorcier"), true);
  assert.strictEqual(isChevalierVoteAllowed("chevalier"), false);

  // ── computeBestCombo — plafond théorique, vérifié à la main sur petit N ──
  {
    // N=1, jour 1 (sans événement) : Princesse seule (25, insensible à
    // tout) bat désormais le Sorcier seul non protégé (round(90*0.5*0.5) =
    // 23) — sans aucun coût d'investissement (pas de Chevalier à
    // dimensionner), elle devient l'option "par défaut" dès que sa valeur
    // fixe dépasse toutes les alternatives non protégées disponibles.
    const dayParams = resolveDayParams(1, CONFIG);
    const best = computeBestCombo(1, dayParams, CONFIG);
    assert.strictEqual(best.damage, 25);
    assert.deepStrictEqual(best.counts, { chevalier: 0, voleuse: 0, sorcier: 0, archeres: 0, princesse: 1 });
  }
  {
    // N=3, jour 3 (Frappe Léthale, malus=0 : un distant non protégé ne fait
    // RIEN) : la combinaison optimale doit sacrifier un vote en Chevalier
    // pour protéger les 2 autres plutôt que de laisser un distant à 0
    // dégât. 1 Chevalier (capacité 2) + 2 Sorciers protégés = 2*45 = 90,
    // toujours meilleur que 3 Princesses (3*25=75) ou toute répartition
    // mélangée (ex. 1 Chevalier + 1 Sorcier protégé + 1 Princesse = 70).
    const dayParams = resolveDayParams(3, CONFIG);
    const best = computeBestCombo(3, dayParams, CONFIG);
    assert.strictEqual(best.damage, 90);
    assert.deepStrictEqual(best.counts, { chevalier: 1, voleuse: 0, sorcier: 2, archeres: 0, princesse: 0 });
  }
  {
    // La recherche exhaustive doit toujours répartir la totalité des votants.
    const dayParams = resolveDayParams(5, CONFIG);
    const best = computeBestCombo(9, dayParams, CONFIG);
    const sum =
      best.counts.chevalier + best.counts.voleuse + best.counts.sorcier + best.counts.archeres + best.counts.princesse;
    assert.strictEqual(sum, 9);
  }

  // ── computeCloture — scénarios bout-en-bout (déterministe, aucun rng) ──

  // (a) Jour 3 (Frappe Léthale) : la communauté a justement voté la
  // combinaison optimale (1 Chevalier + 2 Sorciers) -> score SS.
  {
    const votesRaw = { u1: "chevalier", u2: "sorcier", u3: "sorcier" };
    const voteAtRaw = { u2: "2020-01-01T00:00:01Z", u3: "2020-01-01T00:00:02Z" };
    const dayParams = resolveDayParams(3, CONFIG);
    const r = computeCloture({
      jour: 3,
      votesRaw,
      voteAtRaw,
      dayParams,
      config: CONFIG,
      totalDegatsAvant: 0,
      totalDegatsOptimalAvant: 0,
    });
    assert.strictEqual(r.totalVotes, 3);
    assert.strictEqual(r.totalVotesAction, 3);
    assert.strictEqual(r.protection.tousProteges, true);
    assert.strictEqual(r.totalDamageDuJour, 90);
    assert.strictEqual(r.bestDamage, 90);
    assert.strictEqual(r.score, "SS");
    assert.strictEqual(r.totalDegatsApres, 90);
    assert.strictEqual(r.totalDegatsOptimalApres, 90);
  }

  // (b) Même jour, mais répartition très sous-optimale (tout le monde
  // Voleuse, aucun distant protégé) -> score strictement inférieur au
  // plafond théorique du jour, sans avoir à recalculer ce plafond à la main.
  {
    const votesRaw = { u1: "voleuse", u2: "voleuse", u3: "voleuse" };
    const voteAtRaw = {};
    const dayParams = resolveDayParams(3, CONFIG);
    const r = computeCloture({
      jour: 3,
      votesRaw,
      voteAtRaw,
      dayParams,
      config: CONFIG,
      totalDegatsAvant: 0,
      totalDegatsOptimalAvant: 0,
    });
    assert.strictEqual(r.totalDamageDuJour, 60); // 3 x 20, aucun distant à protéger
    assert.ok(r.bestDamage > r.totalDamageDuJour);
    assert.notStrictEqual(r.score, "SS");
  }

  // (c) Princesse compte désormais réellement : un vote Princesse ajoute
  // son dégât fixe (25, insensible à tout) et entre dans totalVotesAction —
  // plus aucune exclusion façon "Espion" historique.
  {
    const votesRaw = { u1: "chevalier", u2: "sorcier", u3: "sorcier", u4: "princesse" };
    const voteAtRaw = { u2: "2020-01-01T00:00:01Z", u3: "2020-01-01T00:00:02Z" };
    const dayParams = resolveDayParams(3, CONFIG);
    const r = computeCloture({
      jour: 3,
      votesRaw,
      voteAtRaw,
      dayParams,
      config: CONFIG,
      totalDegatsAvant: 0,
      totalDegatsOptimalAvant: 0,
    });
    assert.strictEqual(r.totalVotes, 4);
    assert.strictEqual(r.totalVotesAction, 4); // Princesse comptée désormais
    assert.strictEqual(r.actionCounts.princesse, 1);
    assert.strictEqual(r.voteCounts.princesse, 1);
    assert.strictEqual(r.totalDamageDuJour, 115); // 90 (2 Sorciers protégés, capacité 2) + 25 (Princesse)
  }

  // (d) Ultime actif (+10%, streak de S/SS la veille) : dégâts réels ET
  // plafond théorique scalés à l'identique -> la note reste SS (le
  // multiplicateur ne doit JAMAIS influencer le ratio réel/optimal).
  {
    const votesRaw = { u1: "chevalier", u2: "sorcier", u3: "sorcier" };
    const voteAtRaw = { u2: "2020-01-01T00:00:01Z", u3: "2020-01-01T00:00:02Z" };
    const dayParams = resolveDayParams(3, CONFIG);
    const r = computeCloture({
      jour: 3,
      votesRaw,
      voteAtRaw,
      dayParams,
      config: CONFIG,
      totalDegatsAvant: 100,
      totalDegatsOptimalAvant: 100,
      ultimateMultiplier: 1.1,
    });
    assert.strictEqual(r.totalDamageDuJour, 99); // round(90 * 1.1)
    assert.strictEqual(r.bestDamage, 99);
    assert.strictEqual(r.score, "SS"); // ratio inchangé malgré le multiplicateur
    assert.strictEqual(r.totalDegatsApres, 199);
    assert.strictEqual(r.totalDegatsOptimalApres, 199);
    assert.deepStrictEqual(r.breakdown, { voleuse: 0, princesse: 0, sorcier: 99, archeres: 0 });
  }

  console.log("✓ bossraid service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
