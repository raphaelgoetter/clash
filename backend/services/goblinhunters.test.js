import assert from "assert";
import {
  computeMinorityCount,
  assignCampsAndRoles,
  computeVoteTally,
  resolveVoteElimination,
  computeTavernOccupants,
  computeTavernProtection,
  computeAttacksFromActions,
  sumDamagePerTarget,
  resolveCombat,
  computeInvestigations,
  computeNewPositions,
  checkVictory,
  computeCloture,
  isLieuRepeatAllowed,
  isActionLocked,
  computeIndicesForDay,
  computeClairiereReveals,
} from "./goblinhunters.js";

const CONFIG = {
  duree_jours: 10,
  taverne_seuil_protection: 3,
  vote_quorum_min: 2,
  combat: { pv_base: 3, degats_base: 1 },
  roles: { bucheron: { degats: 2 } },
};

function rngSequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function joueur(discordId, overrides = {}) {
  return {
    discordId,
    username: discordId,
    camp: "chasseur",
    role: null,
    pv: 3,
    pvMax: 3,
    position: "chateau",
    alive: true,
    campReveleAt: null,
    ...overrides,
  };
}

async function main() {
  // ── computeMinorityCount (table 8→3 … 14→5) ──
  const minorityTable = { 8: 3, 9: 3, 10: 3, 11: 4, 12: 4, 13: 4, 14: 5 };
  assert.strictEqual(computeMinorityCount(8, minorityTable), 3);
  assert.strictEqual(computeMinorityCount(11, minorityTable), 4);
  assert.strictEqual(computeMinorityCount(14, minorityTable), 5);

  // ── assignCampsAndRoles : ratio respecté, 1 exemplaire de chaque rôle ──
  {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const rng = rngSequence([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5, 0.15, 0.25, 0.35, 0.45, 0.55]);
    const assignments = assignCampsAndRoles(ids, 4, rng);
    assert.strictEqual(assignments.length, 12);
    assert.strictEqual(assignments.filter((a) => a.camp === "gobelin").length, 4);
    assert.strictEqual(assignments.filter((a) => a.camp === "chasseur").length, 8);
    assert.strictEqual(assignments.filter((a) => a.role === "infiltre").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "eclaireur").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "bucheron").length, 1);
    assert.ok(assignments.find((a) => a.role === "infiltre").camp === "gobelin");
    assert.ok(assignments.find((a) => a.role === "eclaireur").camp === "chasseur");
    assert.ok(assignments.find((a) => a.role === "bucheron").camp === "chasseur");
  }

  // ── computeVoteTally / resolveVoteElimination (égalité -> personne) ──
  // Le vote est dérivé de actionsRaw (lieu:"chateau"), pas d'un stockage
  // séparé (bug corrigé : cumuler vote + action le même jour était possible).
  const actionsVote = {
    a: { primary: { lieu: "chateau", cibleId: "x" } },
    b: { primary: { lieu: "chateau", cibleId: "x" } },
    c: { primary: { lieu: "chateau", cibleId: "y" } },
    d: { primary: { lieu: "camp_entrainement", cibleId: "z" } }, // pas un vote -> ignoré
  };
  assert.deepStrictEqual(computeVoteTally(actionsVote), { x: 2, y: 1 });
  assert.strictEqual(resolveVoteElimination({ x: 2, y: 1 }), "x");
  assert.strictEqual(resolveVoteElimination({ x: 2, y: 2 }), null); // égalité -> personne éliminé
  assert.strictEqual(resolveVoteElimination({}), null);

  // ── Quorum minimum (2 votants par défaut) : un vote solo ne doit PAS
  // suffire à éliminer sa cible (bug repéré en revue, corrigé) ──
  assert.strictEqual(resolveVoteElimination({ x: 1 }), null); // 1 seul votant -> sous le quorum
  assert.strictEqual(resolveVoteElimination({ x: 1, y: 1 }), null); // 2 votants mais égalité -> personne
  assert.strictEqual(resolveVoteElimination({ x: 2 }), "x"); // 2 votants pour la même cible -> quorum atteint
  assert.strictEqual(resolveVoteElimination({ x: 1 }, 1), "x"); // quorum personnalisé à 1 -> autorisé

  // ── Un joueur ne peut pas cumuler vote + autre action le même jour : le
  // dernier lieu choisi écrase le précédent dans le même slot ──
  {
    const actionsExclusives = { a: { primary: { lieu: "taverne", cibleId: null } } }; // dernier choix : Taverne
    assert.deepStrictEqual(computeVoteTally(actionsExclusives), {}); // aucun vote actif, malgré un vote antérieur possible
  }

  // ── Taverne : protection sous le seuil, nulle à/au-dessus ──
  const actionsTaverne = {
    a: { primary: { lieu: "taverne" } },
    b: { primary: { lieu: "taverne" } },
    c: { primary: { lieu: "chateau" } },
  };
  const occupants = computeTavernOccupants(actionsTaverne);
  assert.deepStrictEqual(occupants, new Set(["a", "b"]));
  assert.deepStrictEqual(computeTavernProtection(occupants, 3), new Set(["a", "b"])); // 2 < seuil 3 -> protégés
  assert.deepStrictEqual(computeTavernProtection(new Set(["a", "b", "c"]), 3), new Set()); // 3 >= seuil -> plus personne protégé

  // ── Ciblage restreint au dernier lieu connu + dégâts Bûcheron ──
  {
    const joueursAvant = [
      joueur("attaquant", { role: "bucheron" }),
      joueur("cible_present", { position: "camp_entrainement" }),
      joueur("cible_absente", { position: "taverne" }), // pas au bon lieu -> no-op
    ];
    const actions = {
      attaquant: { primary: { lieu: "camp_entrainement", cibleId: "cible_present" } },
      autre: { primary: { lieu: "camp_entrainement", cibleId: "cible_absente" } },
    };
    const attacks = computeAttacksFromActions(actions, joueursAvant, CONFIG);
    assert.strictEqual(attacks.length, 1);
    assert.strictEqual(attacks[0].targetId, "cible_present");
    assert.strictEqual(attacks[0].degats, 2); // Bûcheron
  }

  // ── Filet de sécurité (Camp d'Entraînement) : personne d'éligible ->
  // frappe un joueur au hasard plutôt que de perdre l'action pour rien ──
  {
    const joueursAvant = [joueur("attaquant"), joueur("v1"), joueur("v2"), joueur("mort", { alive: false })];
    const actions = { attaquant: { primary: { lieu: "camp_entrainement", cibleId: null } } }; // personne au Camp hier
    const rng = rngSequence([0.9]);
    const attacks = computeAttacksFromActions(actions, joueursAvant, CONFIG, rng);
    assert.strictEqual(attacks.length, 1);
    assert.notStrictEqual(attacks[0].targetId, "attaquant"); // jamais soi-même
    assert.notStrictEqual(attacks[0].targetId, "mort"); // jamais un joueur déjà mort
  }
  {
    // Attaquant seul en vie (aucune autre cible possible) -> pas de filet,
    // pas de crash.
    const joueursAvant = [joueur("seul")];
    const actions = { seul: { primary: { lieu: "camp_entrainement", cibleId: null } } };
    assert.deepStrictEqual(computeAttacksFromActions(actions, joueursAvant, CONFIG), []);
  }

  // ── resolveCombat : plafond 1 mort/jour, égalité -> rng ──
  {
    const pvBefore = { a: 3, b: 3, c: 3 };
    const damage = { a: 3, b: 3 }; // a et b mourraient tous les deux sans plafond
    const rng = rngSequence([0.9]); // choisit le dernier candidat (b)
    const { pvAfter, deathId } = resolveCombat(pvBefore, damage, rng);
    assert.strictEqual(deathId, "b");
    assert.strictEqual(pvAfter.a, 1); // plafonné à 1 PV min, pas mort
    assert.strictEqual(pvAfter.b, 0);
    assert.strictEqual(pvAfter.c, 3); // non ciblé, inchangé
  }
  {
    // Un seul candidat mortel -> mort directe, pas de tirage nécessaire.
    const { deathId, pvAfter } = resolveCombat({ a: 3 }, { a: 5 });
    assert.strictEqual(deathId, "a");
    assert.strictEqual(pvAfter.a, -2);
  }

  // ── computeInvestigations : l'Infiltré renvoie toujours "chasseur" ──
  {
    const joueursAvant = [
      joueur("enqueteur", { position: "tour_de_guet" }),
      joueur("infiltre_cible", { camp: "gobelin", role: "infiltre", position: "tour_de_guet" }),
      joueur("gobelin_normal", { camp: "gobelin", position: "tour_de_guet" }),
    ];
    const actions = {
      enqueteur: { primary: { lieu: "tour_de_guet", cibleId: "infiltre_cible" } },
    };
    const [investigation] = computeInvestigations(actions, joueursAvant);
    assert.strictEqual(investigation.campReporte, "chasseur"); // faux positif

    const actions2 = { enqueteur: { primary: { lieu: "tour_de_guet", cibleId: "gobelin_normal" } } };
    const [investigation2] = computeInvestigations(actions2, joueursAvant);
    assert.strictEqual(investigation2.campReporte, "gobelin");
  }

  // ── Filet de sécurité (Tour de Guet) : personne d'éligible -> enquête
  // sur un joueur au hasard plutôt que de perdre l'action pour rien ──
  {
    const joueursAvant = [joueur("enqueteur"), joueur("v1", { camp: "gobelin" }), joueur("mort", { alive: false })];
    const actions = { enqueteur: { primary: { lieu: "tour_de_guet", cibleId: null } } }; // personne à la Tour hier
    const rng = rngSequence([0.9]);
    const [investigation] = computeInvestigations(actions, joueursAvant, rng);
    assert.strictEqual(investigation.cibleId, "v1"); // seul candidat vivant hors soi-même
    assert.strictEqual(investigation.campReporte, "gobelin");
  }

  // ── computeIndicesForDay : carnet privé (enquête = camp, combat = lieu seul) ──
  {
    const joueursAvant = [
      joueur("enqueteur"),
      joueur("attaquant", { role: "bucheron" }),
      joueur("cible_enquete", { camp: "gobelin", role: "infiltre", position: "tour_de_guet" }),
      joueur("cible_combat", { position: "camp_entrainement" }),
    ];
    const actionsRaw = {
      enqueteur: { primary: { lieu: "tour_de_guet", cibleId: "cible_enquete" } },
      attaquant: { primary: { lieu: "camp_entrainement", cibleId: "cible_combat" } },
    };
    const investigations = computeInvestigations(actionsRaw, joueursAvant);
    const attacks = computeAttacksFromActions(actionsRaw, joueursAvant, CONFIG);
    const indices = computeIndicesForDay(4, attacks, investigations, {}, joueursAvant);

    assert.strictEqual(indices.enqueteur.length, 1);
    assert.deepStrictEqual(indices.enqueteur[0], {
      jour: 4,
      type: "enquete",
      cibleId: "cible_enquete",
      cibleUsername: "cible_enquete",
      lieu: "tour_de_guet",
      campReporte: "chasseur", // Infiltré -> faux positif
    });

    assert.strictEqual(indices.attaquant.length, 1);
    assert.deepStrictEqual(indices.attaquant[0], {
      jour: 4,
      type: "combat",
      cibleId: "cible_combat",
      cibleUsername: "cible_combat",
      lieu: "camp_entrainement",
      campReporte: null, // le combat ne révèle jamais de camp
    });

    assert.strictEqual(indices.cible_enquete, undefined); // aucune action -> aucun indice généré pour lui
  }

  // ── computeClairiereReveals : 2 joueurs au hasard, jamais soi-même, jamais un mort ──
  {
    const joueursApres = [
      joueur("visiteur", { position: "clairiere_mystique" }),
      joueur("v1"),
      joueur("v2"),
      joueur("mort", { alive: false }),
    ];
    const actionsRaw = { visiteur: { primary: { lieu: "clairiere_mystique", cibleId: null } } };
    const rng = rngSequence([0.1, 0.9, 0.5]);
    const reveals = computeClairiereReveals(actionsRaw, joueursApres, rng);
    assert.strictEqual(reveals.visiteur.length, 2);
    const revealedIds = reveals.visiteur.map((r) => r.cibleId);
    assert.ok(!revealedIds.includes("visiteur")); // jamais soi-même
    assert.ok(!revealedIds.includes("mort")); // jamais un joueur déjà éliminé ce jour
  }
  {
    // Un joueur éliminé le jour même (vote/combat) n'a pas de vision, même
    // s'il avait choisi la Clairière.
    const joueursApres = [joueur("visiteur_mort", { position: "clairiere_mystique", alive: false }), joueur("v1")];
    const actionsRaw = { visiteur_mort: { primary: { lieu: "clairiere_mystique", cibleId: null } } };
    const reveals = computeClairiereReveals(actionsRaw, joueursApres);
    assert.strictEqual(reveals.visiteur_mort, undefined);
  }

  // ── computeNewPositions : pass automatique -> Château ──
  {
    const joueursAvant = [joueur("actif", { position: "taverne" }), joueur("passif", { position: "camp_entrainement" })];
    const actions = { actif: { primary: { lieu: "tour_de_guet" } } };
    const positions = computeNewPositions(actions, joueursAvant);
    assert.strictEqual(positions.actif, "tour_de_guet");
    assert.strictEqual(positions.passif, "chateau"); // aucune action -> retombe au Château
  }

  // ── checkVictory ──
  assert.strictEqual(
    checkVictory([joueur("a", { camp: "gobelin" }), joueur("b", { camp: "chasseur" })], 5, 10),
    "gobelins_parite",
  );
  assert.strictEqual(
    checkVictory([joueur("a", { camp: "gobelin", alive: false }), joueur("b", { camp: "chasseur" })], 5, 10),
    "chasseurs_gobelins_elimines",
  );
  assert.strictEqual(
    checkVictory([joueur("a", { camp: "gobelin" }), joueur("b", { camp: "chasseur" }), joueur("c", { camp: "chasseur" })], 10, 10),
    "chasseurs_survie",
  );
  assert.strictEqual(
    checkVictory([joueur("a", { camp: "gobelin" }), joueur("b", { camp: "chasseur" }), joueur("c", { camp: "chasseur" })], 5, 10),
    null,
  );

  // ── isLieuRepeatAllowed : anti-camping, Jour 1 exclu ──
  assert.strictEqual(isLieuRepeatAllowed("chateau", "chateau", 1), true); // Jour 1 : spawn initial, jamais bloquant
  assert.strictEqual(isLieuRepeatAllowed("chateau", "chateau", 2), false); // même lieu que la veille -> refusé
  assert.strictEqual(isLieuRepeatAllowed("chateau", "taverne", 2), true); // lieu différent -> autorisé
  assert.strictEqual(isLieuRepeatAllowed("camp_entrainement", "camp_entrainement", 5), false);

  // ── isActionLocked : toute action validée devient définitive, quel que
  // soit le lieu (élargi depuis un verrou initialement limité au vote) ──
  assert.strictEqual(isActionLocked(undefined, "primary"), false); // aucune action ce jour -> pas de verrou
  assert.strictEqual(isActionLocked({ primary: { lieu: "chateau", cibleId: "x" } }, "primary"), true);
  assert.strictEqual(isActionLocked({ primary: { lieu: "taverne" } }, "primary"), true); // n'importe quel lieu verrouille
  assert.strictEqual(isActionLocked({ primary: { lieu: "camp_entrainement", cibleId: null } }, "primary"), true); // même sans cible trouvée (filet de sécurité à la clôture) -> déjà définitif
  // Le verrou est spécifique au slot : le primary verrouillé n'empêche pas
  // l'Éclaireur de soumettre un secondary différent.
  assert.strictEqual(isActionLocked({ primary: { lieu: "chateau", cibleId: "x" } }, "secondary"), false);

  // ── computeCloture : jour 1, aucune élimination possible (vote/combat no-op) ──
  {
    const joueursAvant = [joueur("a", { camp: "gobelin" }), joueur("b")];
    const result = computeCloture({
      jour: 1,
      actionsRaw: {
        a: { primary: { lieu: "chateau", cibleId: "b" } }, // voté quand même, mais jour 1 -> ignoré
        b: { primary: { lieu: "chateau", cibleId: "a" } },
      },
      joueursAvant,
      config: CONFIG,
    });
    assert.strictEqual(result.eliminationsParVote, null);
    assert.strictEqual(result.deathIdCombat, null);
    assert.ok(result.joueursApres.every((j) => j.alive));
  }

  console.log("goblinhunters.test.js : tous les tests sont passés.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
