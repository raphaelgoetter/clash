import assert from "assert";
import { computeCloture, rollDice, rollSort, isTooSoonSinceLastClosure } from "./marioclash.js";

const CONFIG = {
  duree_jours: 7,
  case_arrivee: 49,
  points_boutique_par_jour: 1,
  objets: {
    accelerateur: { label: "Accélérateur", cout: 2, cible: "soi", avance: 4 },
    bombe: { label: "Bombe", cout: 2, cible: "adversaire", recul: 3 },
    etoile: { label: "Étoile", cout: 3, cible: "soi", invincible: true },
    banane: { label: "Peau de banane", cout: 3, cible: "adversaire", echange: true },
  },
  sorts: [
    { id: 1, label: "Recule de 2 cases", avance: -2 },
    { id: 2, label: "Perd son objet spécial", perdObjet: true },
    { id: 3, label: "Échange sa place avec un adversaire aléatoire", echangeAleatoire: true },
    { id: 4, label: "Gagne un point de boutique supplémentaire", pointsBoutique: 1 },
    { id: 5, label: "Avance de 1 case", avance: 1 },
    { id: 6, label: "Avance de 3 cases", avance: 3 },
  ],
};

function rngSeq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

async function main() {
  // ── rollDice / rollSort ───────────────────────────────────────────
  assert.strictEqual(rollDice(() => 0), 1);
  assert.strictEqual(rollDice(() => 0.999999), 6);
  assert.strictEqual(rollSort(CONFIG.sorts, () => 0).id, 1);
  assert.strictEqual(rollSort(CONFIG.sorts, () => 0.999999).id, 6);

  // ── Dé : avance simple, jamais bloqué par une immunité ─────────────
  {
    const joueursAvant = { a: { username: "A", position: 10, points: 0, objet: null } };
    const actionsRaw = { a: { dice: true } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([0.5]) }); // dé -> 4
    assert.strictEqual(r.joueursApres.a.position, 14);
    assert.deepStrictEqual(r.lignes, [{ type: "de", discordId: "a", valeur: 4 }]);
  }

  // ── Accélérateur : avance de 4, objet consommé ─────────────────────
  {
    const joueursAvant = { a: { username: "A", position: 5, points: 0, objet: "accelerateur" } };
    const actionsRaw = { a: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 9);
    assert.strictEqual(r.joueursApres.a.objet, null);
  }

  // ── Bombe : recul de la cible, sauf si la cible est immunisée (Étoile) ──
  {
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "bombe" },
      b: { username: "B", position: 10, points: 0, objet: null },
    };
    const actionsRaw = { a: { item: { target: "b" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 7);
  }
  {
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "bombe" },
      b: { username: "B", position: 10, points: 0, objet: "etoile" },
    };
    const actionsRaw = { a: { item: { target: "b" } }, b: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 10, "la cible immunisée par l'Étoile ne recule pas");
    assert.ok(r.immunises.includes("b"));
  }

  // ── Peau de banane : échange de positions ───────────────────────────
  {
    const joueursAvant = {
      a: { username: "A", position: 3, points: 0, objet: "banane" },
      b: { username: "B", position: 20, points: 0, objet: null },
    };
    const actionsRaw = { a: { item: { target: "b" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 20);
    assert.strictEqual(r.joueursApres.b.position, 3);
  }

  // ── Sort #2 : perte d'objet ──────────────────────────────────────────
  {
    const joueursAvant = { a: { username: "A", position: 0, points: 0, objet: "etoile" } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([1 / 6 + 0.001]) }); // sort id 2
    assert.strictEqual(r.joueursApres.a.objet, null);
  }

  // ── Sort #4 : point de boutique supplémentaire ──────────────────────
  {
    const joueursAvant = { a: { username: "A", position: 0, points: 2, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([3 / 6 + 0.001]) }); // sort id 4
    assert.strictEqual(r.joueursApres.a.points, 3);
  }

  // ── Sort bloqué par l'Étoile (aucun effet, même positif) ────────────
  {
    const joueursAvant = { a: { username: "A", position: 5, points: 0, objet: "etoile" }, b: { username: "B", position: 0, points: 0, objet: null } };
    const actionsRaw = { a: { item: { target: null } }, b: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([5 / 6 + 0.001]) }); // sort id 6 (avance 3), bloqué
    assert.strictEqual(r.joueursApres.a.position, 5, "immunisée, le sort n'a aucun effet même positif");
  }

  // ── Clamp : jamais sous 0, jamais au-dessus de case_arrivee (49) ────
  {
    const joueursAvant = { a: { username: "A", position: 1, points: 0, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([0.001]) }); // sort id 1 (-2)
    assert.strictEqual(r.joueursApres.a.position, 0);
  }
  {
    const joueursAvant = { a: { username: "A", position: 47, points: 0, objet: null } };
    const actionsRaw = { a: { dice: true } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: () => 0.999999 }); // dé -> 6
    assert.strictEqual(r.joueursApres.a.position, 49);
  }

  // ── Ordre de résolution : objets actifs -> sorts -> dé, sur le même jour ──
  {
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "etoile" },
      b: { username: "B", position: 0, points: 0, objet: "bombe" },
    };
    const actionsRaw = {
      a: { item: { target: null }, dice: true },
      b: { item: { target: "a" } },
    };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([0.5]) }); // dé -> 4
    assert.strictEqual(r.joueursApres.a.position, 4, "la bombe est bloquée par l'Étoile, seul le dé s'applique");
  }

  // ── isTooSoonSinceLastClosure ────────────────────────────────────────
  assert.strictEqual(isTooSoonSinceLastClosure(null), false);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date().toISOString()), true);
  assert.strictEqual(isTooSoonSinceLastClosure(new Date(Date.now() - 9 * 3_600_000).toISOString()), false);

  console.log("✓ marioclash service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
