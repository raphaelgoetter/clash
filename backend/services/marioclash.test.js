import assert from "assert";
import { computeCloture, rollDice, rollSort, sortsDisponibles, clampPosition, isTooSoonSinceLastClosure, rollDieOfType, applyCaseSpeciale, ciblesObjet, partenairesEchange } from "./marioclash.js";

const CONFIG = {
  duree_jours: 7,
  case_arrivee: 48,
  des: {
    classique: { min: 1, max: 6, or: 1 },
    prudent: { min: 3, max: 3, or: 1 },
    epargne: { min: 1, max: 2, or: 2 },
  },
  cases_speciales: {
    4: { label: "Turbo", avance: 3 },
    7: { label: "Coffre", or: 2 },
    12: { label: "Glace", or: -2 },
    19: { label: "Feu", avance: -3 },
    47: { label: "Turbo", avance: 3 },
  },
  objets: {
    accelerateur: { label: "Accélérateur", cout: 2, cible: "soi", avance: 4 },
    bombe: { label: "Bombe", cout: 2, cible: "adversaire", recul: 3, recul_renvoi: 3 },
    etoile: { label: "Étoile", cout: 3, cible: "soi", invincible: true },
    banane: { label: "Peau de banane", cout: 3, cible: "adversaire", echange: true, recul_renvoi: 3 },
    carapace: { label: "Carapace bleue", cout: 5, cible: "leader", recul: 5, recul_renvoi: 3 },
  },
  sorts: [
    { id: 1, label: "Recule de 2 cases", avance: -2 },
    { id: 2, label: "Perd 1 Or", perdOr: 1 },
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

  // ── Types de dé : bornes min/max respectées ────────────────────────
  assert.strictEqual(rollDieOfType(CONFIG.des.classique, () => 0), 1);
  assert.strictEqual(rollDieOfType(CONFIG.des.classique, () => 0.999999), 6);
  assert.strictEqual(rollDieOfType(CONFIG.des.prudent, () => 0), 3);
  assert.strictEqual(rollDieOfType(CONFIG.des.prudent, () => 0.999999), 3);
  assert.strictEqual(rollDieOfType(CONFIG.des.epargne, () => 0), 1);
  assert.strictEqual(rollDieOfType(CONFIG.des.epargne, () => 0.999999), 2);

  // ── Cases spéciales : effet unique, sans enchaînement ───────────────
  {
    const r = applyCaseSpeciale(4, 0, CONFIG);
    assert.strictEqual(r.position, 7, "Turbo +3");
    assert.strictEqual(r.points, 0, "pas d'enchaînement sur le Coffre de la case 7");
    assert.strictEqual(r.caseSpeciale.label, "Turbo");
  }
  assert.strictEqual(applyCaseSpeciale(7, 1, CONFIG).points, 3, "Coffre +2 Or");
  assert.strictEqual(applyCaseSpeciale(12, 1, CONFIG).points, 0, "Glace : jamais d'Or négatif");
  assert.strictEqual(applyCaseSpeciale(19, 0, CONFIG).position, 16, "Feu -3");
  assert.strictEqual(applyCaseSpeciale(47, 0, CONFIG).position, 48, "clamp à l'arrivée");
  {
    const r = applyCaseSpeciale(10, 4, CONFIG);
    assert.deepStrictEqual(r, { position: 10, points: 4, caseSpeciale: null });
  }

  // ── clampPosition : jamais sous 0, jamais au-dessus de case_arrivee ──
  assert.strictEqual(clampPosition(-5, 49), 0);
  assert.strictEqual(clampPosition(52, 49), 49);
  assert.strictEqual(clampPosition(20, 49), 20);

  // ── Accélérateur : avance de 4, objet consommé ─────────────────────
  {
    const joueursAvant = { a: { username: "A", position: 5, points: 0, objet: "accelerateur" } };
    const actionsRaw = { a: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 9);
    assert.strictEqual(r.joueursApres.a.objet, null);
  }

  // ── Ordre : le sort (Échange) s'applique AVANT l'objet (Accélérateur) ──
  {
    const joueursAvant = {
      a: { username: "A", position: 10, points: 0, objet: "accelerateur" },
      b: { username: "B", position: 2, points: 0, objet: null },
    };
    const actionsRaw = { a: { item: { target: null }, spell: { target: "a", sortId: 3 } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: () => 0 });
    assert.strictEqual(r.joueursApres.b.position, 10, "B récupère la position de A avant l'Accélérateur");
    assert.strictEqual(r.joueursApres.a.position, 6, "A échange (case 2) puis garde le bonus de l'Accélérateur");
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
    const r = computeCloture({ actionsRaw, joueursAvant: { ...joueursAvant, a: { ...joueursAvant.a, position: 6 } }, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 10, "la cible immunisée par l'Étoile ne recule pas");
    assert.strictEqual(r.joueursApres.a.position, 3, "l'Étoile renvoie la Bombe : l'attaquant recule de 3");
    assert.ok(r.immunises.includes("b"));
    assert.ok(r.lignes.some((l) => l.effet === "renvoi" && l.discordId === "a" && l.cibleId === "b" && l.valeur === 3));
  }
  // ── Peau de banane renvoyée : pas d'échange, l'attaquant recule ──────
  {
    const joueursAvant = {
      a: { username: "A", position: 4, points: 0, objet: "banane" },
      b: { username: "B", position: 20, points: 0, objet: "etoile" },
    };
    const actionsRaw = { a: { item: { target: "b" } }, b: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 20);
    assert.strictEqual(r.joueursApres.a.position, 1);
    assert.strictEqual(r.joueursApres.a.objet, null);
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

  // ── Sort #2 : perd 1 Or (jamais sous 0) ───────────────────────────────
  {
    const joueursAvant = { a: { username: "A", position: 0, points: 2, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([1 / 6 + 0.001]) }); // sort id 2
    assert.strictEqual(r.joueursApres.a.points, 1);
  }
  {
    const joueursAvant = { a: { username: "A", position: 0, points: 0, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([1 / 6 + 0.001]) }); // sort id 2
    assert.strictEqual(r.joueursApres.a.points, 0, "jamais négatif");
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

  // ── Clamp : jamais sous 0, jamais au-dessus de case_arrivee (48) ────
  {
    const joueursAvant = { a: { username: "A", position: 1, points: 0, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([0.001]) }); // sort id 1 (-2)
    assert.strictEqual(r.joueursApres.a.position, 0);
  }
  {
    const joueursAvant = { a: { username: "A", position: 46, points: 0, objet: null } };
    const actionsRaw = { a: { spell: { target: "a" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: rngSeq([5 / 6 + 0.001]) }); // sort id 6 (+3)
    assert.strictEqual(r.joueursApres.a.position, 48);
  }

  // ── Ordre de résolution : objets actifs -> objets appliqués -> sorts, sur le même jour ──
  // (le dé n'est plus résolu ici : action individuelle sans interaction
  // avec autrui, résolue EN DIRECT au clic, voir rollDiceForPlayer())
  {
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "etoile" },
      b: { username: "B", position: 0, points: 0, objet: "bombe" },
    };
    const actionsRaw = {
      a: { item: { target: null } },
      b: { item: { target: "a" } },
    };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 0, "la bombe est renvoyée par l'Étoile, aucun effet sur la cible");
    assert.strictEqual(r.joueursApres.b.position, 0, "attaquant renvoyé, jamais sous la case 0");
    assert.ok(r.immunises.includes("a"));
  }

  // ── Carapace bleue : frappe le leader, jamais le lanceur ─────────────
  {
    const joueursAvant = {
      a: { username: "A", position: 5, points: 0, objet: "carapace" },
      b: { username: "B", position: 20, points: 0, objet: null },
      c: { username: "C", position: 15, points: 0, objet: null },
    };
    const r = computeCloture({ actionsRaw: { a: { item: { target: null } } }, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 15, "le leader recule de 5");
    assert.strictEqual(r.joueursApres.c.position, 15);
    assert.strictEqual(r.joueursApres.a.objet, null);
  }
  {
    const joueursAvant = {
      a: { username: "A", position: 30, points: 0, objet: "carapace" },
      b: { username: "B", position: 20, points: 0, objet: null },
    };
    const r = computeCloture({ actionsRaw: { a: { item: { target: null } } }, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 30, "le lanceur en tête n'est jamais visé");
    assert.strictEqual(r.joueursApres.b.position, 15, "elle frappe son poursuivant");
  }
  {
    const joueursAvant = {
      a: { username: "A", position: 10, points: 0, objet: "carapace" },
      b: { username: "B", position: 20, points: 0, objet: "etoile" },
    };
    const actionsRaw = { a: { item: { target: null } }, b: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 20, "l'Étoile protège le leader");
    assert.strictEqual(r.joueursApres.a.position, 7, "et renvoie la Carapace : le lanceur recule de 3");
  }
  {
    // Carapace résolue après les autres objets : la Banane fait passer C
    // en tête, c'est donc C qui prend la Carapace.
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "carapace" },
      b: { username: "B", position: 20, points: 0, objet: null },
      c: { username: "C", position: 10, points: 0, objet: "banane" },
    };
    const actionsRaw = { a: { item: { target: null } }, c: { item: { target: "b" } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.c.position, 15, "C, passé en tête par la Banane, prend la Carapace");
    assert.strictEqual(r.joueursApres.b.position, 10);
  }
  {
    // Deux Carapaces le même jour : même classement pour les deux, le
    // leader encaisse les deux coups.
    const joueursAvant = {
      a: { username: "A", position: 0, points: 0, objet: "carapace" },
      b: { username: "B", position: 20, points: 0, objet: null },
      c: { username: "C", position: 18, points: 0, objet: "carapace" },
    };
    const actionsRaw = { a: { item: { target: null } }, c: { item: { target: null } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.b.position, 10);
    assert.strictEqual(r.joueursApres.c.position, 18);
  }

  // ── Dé : déjà appliqué au clic, seulement rapporté dans le bilan ─────
  {
    const joueursAvant = { a: { username: "A", position: 12, points: 0, objet: null } };
    const actionsRaw = { a: { dice: true, diceValue: 3, deId: "prudent", positionDe: 12, caseSpeciale: 12 } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.position, 12, "le dé n'est pas réappliqué à la clôture");
    assert.deepStrictEqual(r.lignes[0], { type: "de", discordId: "a", deId: "prudent", valeur: 3, positionDe: 12, caseSpeciale: 12 });
  }

  // ── Nouveaux sorts (Gel / Rage / Clone) et Concentration ─────────────
  {
    const SORTS = [
      { id: 1, label: "Recul", avance: -2, retire_concentration: 2 },
      { id: 2, label: "Gel", gel: true, retire_concentration: 1 },
      { id: 3, label: "Échange", echangeAleatoire: true },
      { id: 4, label: "Clone", clone: true },
      { id: 5, label: "Rage", rage: 2 },
      { id: 6, label: "Avance", avance: 3 },
    ];
    const C = { ...CONFIG, sorts: SORTS, concentration_max: 2 };

    assert.deepStrictEqual(sortsDisponibles(SORTS, 0).map((x) => x.id), [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(sortsDisponibles(SORTS, 1).map((x) => x.id), [1, 3, 4, 5, 6], "niveau 1 : Gel retiré");
    assert.deepStrictEqual(sortsDisponibles(SORTS, 2).map((x) => x.id), [3, 4, 5, 6], "niveau 2 : Recul retiré aussi");

    // Gel/Rage posés pour demain, anciens purgés ; Concentration +1 (cap 2)
    // pour qui n'a pas lancé de sort.
    const joueursAvant = {
      a: { username: "A", position: 5, points: 0, objet: null, rage: 2 },
      b: { username: "B", position: 5, points: 0, objet: null, gel: true, concentration: 2 },
      c: { username: "C", position: 5, points: 0, objet: null, concentration: 0 },
    };
    const actionsRaw = { a: { spell: { target: "a", sortId: 2 } }, c: { spell: { target: "c", sortId: 5 } } };
    const r = computeCloture({ actionsRaw, joueursAvant, config: C, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.gel, true);
    assert.strictEqual(r.joueursApres.a.rage, 0, "la Rage d'hier est périmée");
    assert.strictEqual(r.joueursApres.c.rage, 2);
    assert.strictEqual(r.joueursApres.b.gel, false, "le Gel d'hier est périmé");
    assert.strictEqual(r.joueursApres.b.concentration, 2, "jauge plafonnée");
    assert.strictEqual(r.joueursApres.c.concentration, 0, "lanceur : jauge déjà remise à 0 au clic");

    // Clone : rejoue le déplacement du dé (bonus compris), sinon sans effet.
    const r2 = computeCloture({
      actionsRaw: {
        a: { dice: true, diceValue: 4, diceAvance: 6, spell: { target: "a", sortId: 4 } },
        c: { spell: { target: "c", sortId: 4 } },
      },
      joueursAvant,
      config: C,
      rng: Math.random,
    });
    assert.strictEqual(r2.joueursApres.a.position, 11);
    assert.strictEqual(r2.joueursApres.c.position, 5);
    assert.strictEqual(r2.lignes.find((l) => l.type === "sort" && l.discordId === "c").valeurClone, 0);
  }

  // ── Objet acheté sans cible choisie : remboursé et retiré ────────────
  {
    const joueursAvant = {
      a: { username: "A", position: 5, points: 1, objet: "bombe" },
      b: { username: "B", position: 8, points: 0, objet: null },
    };
    const r = computeCloture({ actionsRaw: {}, joueursAvant, config: CONFIG, rng: Math.random });
    assert.strictEqual(r.joueursApres.a.objet, null);
    assert.strictEqual(r.joueursApres.a.points, 3);
    assert.strictEqual(r.joueursApres.b.position, 8);
    assert.ok(r.lignes.some((l) => l.effet === "rembourse" && l.discordId === "a" && l.valeur === 2));
  }

  // ── ciblesObjet : portée de la Banane (devant soi, 10 cases max) ─────
  {
    const joueurs = {
      a: { username: "A", position: 10 },
      b: { username: "B", position: 20 }, // pile à 10 cases : ok
      c: { username: "C", position: 21 }, // 11 cases : hors portée
      d: { username: "D", position: 5 },  // derrière : exclu
      e: { username: "E", position: 10 }, // même case : exclu
    };
    const ids = (item) => ciblesObjet(joueurs, "a", item).map((c) => c.discordId).sort();
    assert.deepStrictEqual(ids({ cible: "adversaire", echange: true, portee: 10 }), ["b"]);
    assert.deepStrictEqual(ids({ cible: "adversaire", recul: 3 }), ["b", "c", "d", "e"]);
    // Personne à portée : élargi au(x) plus proche(s) devant, ex aequo inclus.
    const loin = {
      a: { username: "A", position: 10 },
      b: { username: "B", position: 25 },
      c: { username: "C", position: 25 },
      d: { username: "D", position: 30 },
    };
    assert.deepStrictEqual(ciblesObjet(loin, "a", { portee: 10 }).map((c) => c.discordId).sort(), ["b", "c"]);
    // Personne devant : aucune cible.
    assert.deepStrictEqual(ciblesObjet(loin, "d", { portee: 10 }), []);
  }

  // ── partenairesEchange : 10 cases d'écart dans les deux sens ─────────
  {
    const joueurs = {
      a: { position: 20 },
      b: { position: 30 }, // +10 : ok
      c: { position: 10 }, // -10 : ok
      d: { position: 31 }, // hors portée
      e: { position: 20 }, // même case : exclu
    };
    assert.deepStrictEqual(partenairesEchange(joueurs, "a", 10).sort(), ["b", "c"]);
    assert.deepStrictEqual(partenairesEchange(joueurs, "a", null).sort(), ["b", "c", "d", "e"]);
    // Personne à portée : le(s) plus proche(s), quel que soit le sens.
    const loin = { a: { position: 20 }, b: { position: 35 }, c: { position: 2 } };
    assert.deepStrictEqual(partenairesEchange(loin, "a", 10), ["b"]);
    // Tous sur la même case : aucun échange.
    assert.deepStrictEqual(partenairesEchange({ a: { position: 5 }, b: { position: 5 } }, "a", 10), []);
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
