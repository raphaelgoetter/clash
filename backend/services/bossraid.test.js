import assert from "assert";
import {
  computeProtection,
  detectAllIn,
  activeEventForDay,
  rollDamageInRange,
  rollVoleuseDebuff,
  rollRegenAmount,
  applyStatReduction,
  protectionMultiplier,
  computeVoleuseDamage,
  computeSorcierDamage,
  computeArcheresDamage,
  computeBossStatsNextDay,
  isChevalierVoteAllowed,
  computeCloture,
} from "./bossraid.js";

const CONFIG = {
  roles: {
    chevalier: { label: "Chevalier", emoji: "🛡️", protection_slots: 2 },
    voleuse: { label: "Voleuse", emoji: "🗡️", degats_min: 30, degats_max: 40, chance_debuff: 0.25 },
    sorcier: { label: "Sorcier", emoji: "🔮", degats_min: 80, degats_max: 100, reduction_stat: "resistance" },
    archeres: { label: "Archères", emoji: "🏹", degats_min: 70, degats_max: 90, reduction_stat: "defense" },
    espion: { label: "Espion", emoji: "🔍", is_info_action: true },
  },
  evenements_boss: [
    { jour: 3, id: "frappe_lethale" },
    { jour: 6, id: "bouclier_acier" },
    { jour: 9, id: "miroir_mana" },
  ],
};

function rngSequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

async function main() {
  // ── computeProtection ──
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
  {
    const distants = [{ discordId: "a", votedAt: "t1" }, { discordId: "b", votedAt: "t2" }];
    const r = computeProtection(1, distants, 2); // égalité stricte 2 distants === capacité 2
    assert.strictEqual(r.tousProteges, true);
    assert.strictEqual(r.protectedIds.size, 2);
  }

  // ── detectAllIn ──
  assert.strictEqual(detectAllIn({ archeres: 5 }, 10), null); // 50% pile -> pas déclenché (strict >)
  assert.strictEqual(detectAllIn({ archeres: 6 }, 10), "archeres");
  assert.strictEqual(detectAllIn({ voleuse: 6 }, 10), "voleuse");
  assert.strictEqual(detectAllIn({ sorcier: 6 }, 10), "sorcier");
  assert.strictEqual(detectAllIn({}, 0), null);
  assert.strictEqual(
    detectAllIn({ archeres: 3, sorcier: 3, voleuse: 3, chevalier: 1 }, 10),
    null,
  );

  // ── activeEventForDay ──
  assert.strictEqual(activeEventForDay(3, CONFIG.evenements_boss)?.id, "frappe_lethale");
  assert.strictEqual(activeEventForDay(6, CONFIG.evenements_boss)?.id, "bouclier_acier");
  assert.strictEqual(activeEventForDay(9, CONFIG.evenements_boss)?.id, "miroir_mana");
  assert.strictEqual(activeEventForDay(1, CONFIG.evenements_boss), null);

  // ── rollDamageInRange ──
  assert.strictEqual(rollDamageInRange(30, 40, rngSequence([0])), 30);
  assert.strictEqual(rollDamageInRange(30, 40, rngSequence([0.999999])), 40);
  assert.strictEqual(rollDamageInRange(70, 90, rngSequence([0])), 70);
  assert.strictEqual(rollDamageInRange(70, 90, rngSequence([0.999999])), 90);

  // ── rollVoleuseDebuff — 25% de déclenchement, 50/50 à l'intérieur ──
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0])), "defense");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.1])), "defense");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.124])), "defense");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.125])), "resistance");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.2])), "resistance");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.249])), "resistance");
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.25])), null);
  assert.strictEqual(rollVoleuseDebuff(rngSequence([0.5])), null);

  // ── applyStatReduction ──
  assert.strictEqual(applyStatReduction(100, 0), 100);
  assert.strictEqual(applyStatReduction(100, 5), 50);
  assert.strictEqual(applyStatReduction(100, 10), 0);
  assert.strictEqual(applyStatReduction(100, 15), 0); // plafonné à 10

  // ── protectionMultiplier ──
  assert.strictEqual(protectionMultiplier(true, false), 1);
  assert.strictEqual(protectionMultiplier(true, true), 1); // protégé -> jamais de malus, même Frappe Léthale
  assert.strictEqual(protectionMultiplier(false, false), 0.5);
  assert.strictEqual(protectionMultiplier(false, true), 0);

  // ── computeVoleuseDamage — jamais réduit ──
  assert.strictEqual(computeVoleuseDamage(35), 35);

  // ── computeSorcierDamage ──
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, frappeLethaleActive: false, surchargeArcaneActive: false, miroirManaActive: false }),
    100,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: false, frappeLethaleActive: false, surchargeArcaneActive: false, miroirManaActive: false }),
    50,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: false, frappeLethaleActive: true, surchargeArcaneActive: false, miroirManaActive: false }),
    0,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, frappeLethaleActive: false, surchargeArcaneActive: true, miroirManaActive: false }),
    200,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, frappeLethaleActive: false, surchargeArcaneActive: false, miroirManaActive: true }),
    50,
  );
  // Composition Surcharge Arcane x2 * Miroir de Mana x0.5 = net x1
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 0, protege: true, frappeLethaleActive: false, surchargeArcaneActive: true, miroirManaActive: true }),
    100,
  );
  assert.strictEqual(
    computeSorcierDamage({ base: 100, resistance: 10, protege: true, frappeLethaleActive: false, surchargeArcaneActive: true, miroirManaActive: true }),
    0,
  );

  // ── computeArcheresDamage ──
  // Volée Céleste (All-In) l'emporte sur tout, y compris Bouclier d'Acier (defense=10) et non-protection
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 10, protege: false, frappeLethaleActive: true, voleeCelesteActive: true }),
    90,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: true, frappeLethaleActive: false, voleeCelesteActive: false }),
    90,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 10, protege: true, frappeLethaleActive: false, voleeCelesteActive: false }),
    0,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: false, frappeLethaleActive: false, voleeCelesteActive: false }),
    45,
  );
  assert.strictEqual(
    computeArcheresDamage({ base: 90, defense: 0, protege: false, frappeLethaleActive: true, voleeCelesteActive: false }),
    0,
  );

  // ── rollRegenAmount — régénération nocturne, 0 ou 1, 30% de chances de +1 ──
  assert.strictEqual(rollRegenAmount(rngSequence([0])), 0);
  assert.strictEqual(rollRegenAmount(rngSequence([0.69])), 0);
  assert.strictEqual(rollRegenAmount(rngSequence([0.7])), 1);
  assert.strictEqual(rollRegenAmount(rngSequence([0.99])), 1);

  // ── computeBossStatsNextDay — debuffs (plancher 0) PUIS régénération (plafond 10) ──
  const NO_REGEN = { defense: 0, resistance: 0 };
  assert.deepStrictEqual(computeBossStatsNextDay({ defense: 5, resistance: 5 }, [], null, NO_REGEN), { defense: 5, resistance: 5 });
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 5, resistance: 5 }, ["defense", "defense", "resistance"], null, NO_REGEN),
    { defense: 3, resistance: 4 },
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 1, resistance: 5 }, ["defense", "defense"], null, NO_REGEN),
    { defense: 0, resistance: 5 }, // plancher 0
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 8, resistance: 8 }, ["defense", "resistance"], "voleuse", { defense: 5, resistance: 5 }),
    { defense: 0, resistance: 0 }, // Coup à la Gorge écrase tout, ignore même un regen généreux
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 5, resistance: 5 }, [], null, { defense: 2, resistance: 1 }),
    { defense: 7, resistance: 6 }, // régénération pure, pas de debuff ce jour-là
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 9, resistance: 9 }, [], null, { defense: 2, resistance: 2 }),
    { defense: 10, resistance: 10 }, // plafond 10, le surplus de régénération est perdu
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 5, resistance: 5 }, ["defense", "defense", "resistance"], null, { defense: 2, resistance: 2 }),
    { defense: 5, resistance: 6 }, // (5-2)+2=5, (5-1)+2=6 — la régénération compense une partie des debuffs
  );
  assert.deepStrictEqual(
    computeBossStatsNextDay({ defense: 1, resistance: 5 }, ["defense", "defense"], null, { defense: 1, resistance: 0 }),
    { defense: 1, resistance: 5 }, // plancher 0 puis régénération : 0+1=1
  );

  // ── isChevalierVoteAllowed ──
  assert.strictEqual(isChevalierVoteAllowed(undefined), true);
  assert.strictEqual(isChevalierVoteAllowed(null), true);
  assert.strictEqual(isChevalierVoteAllowed("sorcier"), true);
  assert.strictEqual(isChevalierVoteAllowed("chevalier"), false);

  // ── computeCloture — scénarios bout-en-bout ──

  // (a) Jour normal (jour 1, pas d'événement, pas d'All-In)
  {
    const votesRaw = { u1: "chevalier", u2: "voleuse", u3: "sorcier", u4: "archeres", u5: "espion" };
    const voteAtRaw = { u3: "2020-01-01T00:00:01Z", u4: "2020-01-01T00:00:02Z" };
    const rng = rngSequence([0, 0.5, 0, 0, 0.9, 0.5]); // dmg voleuse, debuff voleuse (pas déclenché), dmg sorcier, dmg archeres, regen défense (+1), regen résistance (+0)
    const r = computeCloture({
      jour: 1,
      votesRaw,
      voteAtRaw,
      bossStatsAvant: { defense: 5, resistance: 5 },
      totalDegatsAvant: 0,
      config: CONFIG,
      rng,
    });
    assert.strictEqual(r.allIn, null);
    assert.strictEqual(r.event, null);
    assert.strictEqual(r.totalVotes, 5);
    assert.strictEqual(r.protection.tousProteges, true); // 1 Chevalier -> capacité 2, 2 distants
    // Voleuse 30 (flat) + Sorcier 80 réduit à 40 (résistance 5, protégé) + Archères 70 réduit à 35 (défense 5, protégé)
    assert.strictEqual(r.totalDamageDuJour, 105);
    assert.strictEqual(r.totalDegatsApres, 105);
    assert.deepStrictEqual(r.voleuseDebuffs, []);
    assert.deepStrictEqual(r.regen, { defense: 1, resistance: 0 });
    assert.deepStrictEqual(r.bossStatsApres, { defense: 6, resistance: 5 }); // 5+1 régénération défense, résistance inchangée
  }

  // (b) All-In Archères + Bouclier d'Acier simultanés (jour 6)
  {
    const votesRaw = { u1: "archeres", u2: "archeres", u3: "archeres", u4: "chevalier" };
    const voteAtRaw = {
      u1: "2020-01-01T00:00:01Z",
      u2: "2020-01-01T00:00:02Z",
      u3: "2020-01-01T00:00:03Z",
    };
    const rng = rngSequence([0, 0, 0, 0.9, 0.9]); // 3 tirages Archères (borne min 70), regen défense (+1), regen résistance (+1)
    const r = computeCloture({
      jour: 6,
      votesRaw,
      voteAtRaw,
      bossStatsAvant: { defense: 5, resistance: 5 },
      totalDegatsAvant: 50,
      config: CONFIG,
      rng,
    });
    assert.strictEqual(r.allIn, "archeres");
    assert.strictEqual(r.event.id, "bouclier_acier");
    assert.strictEqual(r.protection.tousProteges, false); // 3 distants, capacité 2 (1 Chevalier)
    assert.strictEqual(r.protection.protectedIds.size, 2);
    // Volée Céleste ignore Défense (même à 10 via Bouclier) ET la protection : 70 x 3
    assert.strictEqual(r.totalDamageDuJour, 210);
    assert.strictEqual(r.totalDegatsApres, 260);
    assert.deepStrictEqual(r.bossStatsApres, { defense: 6, resistance: 6 }); // pas de debuff Voleuse, +1 régénération chacune
  }

  // (c) All-In Voleuse (Coup à la Gorge) avec debuffs individuels redondants
  {
    const votesRaw = { u1: "voleuse", u2: "voleuse", u3: "voleuse", u4: "chevalier" };
    const voteAtRaw = {};
    // Pour chaque Voleuse : tirage dégâts (0 -> 30), tirage debuff (0 -> "defense")
    const rng = rngSequence([0, 0, 0, 0, 0, 0]);
    const r = computeCloture({
      jour: 1,
      votesRaw,
      voteAtRaw,
      bossStatsAvant: { defense: 5, resistance: 5 },
      totalDegatsAvant: 0,
      config: CONFIG,
      rng,
    });
    assert.strictEqual(r.allIn, "voleuse");
    assert.strictEqual(r.totalDamageDuJour, 90); // 30 x 3
    assert.strictEqual(r.voleuseDebuffs.length, 3); // les debuffs individuels sont bien tirés et visibles...
    // ...mais n'influencent jamais le résultat : Coup à la Gorge écrase à {0,0} inconditionnellement
    assert.deepStrictEqual(r.bossStatsApres, { defense: 0, resistance: 0 });
  }

  console.log("✓ bossraid service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
