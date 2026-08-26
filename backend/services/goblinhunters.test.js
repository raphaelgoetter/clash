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
  resolveExplosifRetaliation,
  resolveGuetApensReveal,
  knownEnqueteTargets,
  computeTourDeGuetOccupants,
  isTourDeGuetOvercrowded,
} from "./goblinhunters.js";

const CONFIG = {
  duree_jours: 10,
  taverne_seuil_protection: 3,
  vote_quorum_min: 2,
  combat: { pv_base: 3, degats_base: 1 },
  roles: { bucheron: { degats: 2 }, explosif: { degats_riposte: 1 } },
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
    assert.strictEqual(assignments.filter((a) => a.role === "explosif").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "guet_apens").length, 1);
    assert.ok(assignments.find((a) => a.role === "infiltre").camp === "gobelin");
    assert.ok(assignments.find((a) => a.role === "eclaireur").camp === "chasseur");
    assert.ok(assignments.find((a) => a.role === "bucheron").camp === "chasseur");
    assert.ok(assignments.find((a) => a.role === "explosif").camp === "gobelin");
    assert.ok(assignments.find((a) => a.role === "guet_apens").camp === "chasseur");
  }
  {
    // Effectif plancher (8 -> 3 Gobelins/5 Villageois, table minority_table) :
    // les 2 rôles Gobelins et les 3 rôles Villageois doivent quand même tenir.
    const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const assignments = assignCampsAndRoles(ids, 3, rngSequence([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    assert.strictEqual(assignments.filter((a) => a.role === "infiltre").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "explosif").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "eclaireur").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "bucheron").length, 1);
    assert.strictEqual(assignments.filter((a) => a.role === "guet_apens").length, 1);
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

  // ── Filet de sécurité (Arène) : personne d'éligible ->
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

  // ── Tour de Guet surpeuplée : plus de la moitié des vivants -> aucune
  // enquête n'aboutit ce jour-là (même esprit que la protection Taverne) ──
  {
    assert.strictEqual(isTourDeGuetOvercrowded(0, 10), false); // personne -> jamais surpeuplée
    assert.strictEqual(isTourDeGuetOvercrowded(5, 10), false); // exactement la moitié -> pas "plus de"
    assert.strictEqual(isTourDeGuetOvercrowded(6, 10), true); // strictement plus de la moitié
    assert.strictEqual(isTourDeGuetOvercrowded(3, 5), true); // 3/5 = 60% > 50%
    assert.strictEqual(isTourDeGuetOvercrowded(0, 0), false); // aucun vivant -> pas de crash
    assert.strictEqual(isTourDeGuetOvercrowded(3, 10, 0.2), true); // ratio personnalisé (seuil = 2)
    assert.strictEqual(isTourDeGuetOvercrowded(2, 10, 0.2), false); // pile au seuil -> pas "plus de"
  }
  {
    const actionsRaw = {
      a: { primary: { lieu: "tour_de_guet", cibleId: null } },
      b: { primary: { lieu: "tour_de_guet", cibleId: null } },
      c: { primary: { lieu: "chateau", cibleId: null } },
    };
    assert.deepStrictEqual(computeTourDeGuetOccupants(actionsRaw), new Set(["a", "b"]));
  }
  {
    // computeCloture bout en bout : 5 enquêteurs sur 8 vivants (>50%) ->
    // aucune investigation renvoyée, même via le filet de sécurité.
    const joueursAvant = Array.from({ length: 8 }, (_, i) => joueur(`p${i}`));
    const actionsRaw = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}`, { primary: { lieu: "tour_de_guet", cibleId: null } }]),
    );
    const result = computeCloture({ jour: 2, actionsRaw, joueursAvant, config: CONFIG });
    assert.deepStrictEqual(result.investigations, []);
    assert.strictEqual(result.tourDeGuetSurpeuplee, true);
  }
  {
    // Sous le seuil (4/8 = exactement la moitié, pas "plus de") -> les
    // enquêtes aboutissent normalement.
    const joueursAvant = Array.from({ length: 8 }, (_, i) => joueur(`p${i}`));
    const actionsRaw = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`p${i}`, { primary: { lieu: "tour_de_guet", cibleId: null } }]),
    );
    const result = computeCloture({ jour: 2, actionsRaw, joueursAvant, config: CONFIG });
    assert.strictEqual(result.tourDeGuetSurpeuplee, false);
    assert.strictEqual(result.investigations.length, 4);
  }

  // ── knownEnqueteTargets : dérive les cibles déjà connues du carnet d'indices ──
  {
    const indices = [
      { type: "enquete", cibleId: "a", campReporte: "gobelin" },
      { type: "combat", cibleId: "b", campReporte: null }, // pas une enquête -> ignoré
      { type: "enquete", cibleId: "c", campReporte: "chasseur" },
    ];
    assert.deepStrictEqual(knownEnqueteTargets(indices), new Set(["a", "c"]));
    assert.deepStrictEqual(knownEnqueteTargets([]), new Set());
  }

  // ── Filet de sécurité (Tour de Guet) : ne doit JAMAIS retomber sur une
  // cible dont le camp est déjà connu de cet enquêteur (bug repéré en test
  // réel — même cible révélée 2 fois de suite) ──
  {
    const joueursAvant = [
      joueur("enqueteur"),
      joueur("deja_connu", { camp: "gobelin" }),
      joueur("inconnu", { camp: "chasseur" }),
    ];
    const actions = { enqueteur: { primary: { lieu: "tour_de_guet", cibleId: null } } };
    const knownTargetsByInvestigator = { enqueteur: new Set(["deja_connu"]) };
    // rng choisirait "deja_connu" en 1er sans l'exclusion (ordre de shuffle
    // déterministe avec ce rng constant) -> vérifie qu'il est bien sauté.
    for (const seed of [0.1, 0.5, 0.9]) {
      const [investigation] = computeInvestigations(
        actions,
        joueursAvant,
        rngSequence([seed]),
        knownTargetsByInvestigator,
      );
      assert.strictEqual(investigation.cibleId, "inconnu");
    }
  }

  // ── Résultat délibéré (cible choisie sur le plateau) déjà connu -> écarté,
  // filet de sécurité prend le relais sur une cible encore inconnue ──
  {
    const joueursAvant = [
      joueur("enqueteur"),
      joueur("deja_connu", { camp: "gobelin", position: "tour_de_guet" }),
      joueur("inconnu", { camp: "chasseur" }), // pas au bon lieu mais servira de repli
    ];
    const actions = { enqueteur: { primary: { lieu: "tour_de_guet", cibleId: "deja_connu" } } };
    const knownTargetsByInvestigator = { enqueteur: new Set(["deja_connu"]) };
    const [investigation] = computeInvestigations(
      actions,
      joueursAvant,
      rngSequence([0.1]),
      knownTargetsByInvestigator,
    );
    assert.strictEqual(investigation.cibleId, "inconnu"); // jamais "deja_connu"
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

  // ── resolveGuetApensReveal : mort au combat -> révèle le camp de(s)
  // attaquant(s), jamais au vote (pas d'attaquant identifiable) ──
  {
    const joueursAvant = [
      joueur("guetteur", { role: "guet_apens" }),
      joueur("attaquant_gobelin", { camp: "gobelin" }),
    ];
    const attacks = [{ attackerId: "attaquant_gobelin", targetId: "guetteur", lieu: "camp_entrainement", degats: 1 }];
    const reveal = resolveGuetApensReveal({ deathIdCombat: "guetteur", attacks, joueursAvant });
    assert.deepStrictEqual(reveal, {
      guetApensId: "guetteur",
      attackers: [{ attackerId: "attaquant_gobelin", campReporte: "gobelin" }],
    });
  }
  {
    // Pas Guet-Apens -> pas de révélation.
    const joueursAvant = [joueur("normal"), joueur("attaquant", { camp: "gobelin" })];
    const attacks = [{ attackerId: "attaquant", targetId: "normal", lieu: "camp_entrainement", degats: 1 }];
    assert.strictEqual(resolveGuetApensReveal({ deathIdCombat: "normal", attacks, joueursAvant }), null);
  }
  {
    // Mort au vote (pas de deathIdCombat) -> jamais de révélation, même si
    // la victime est Guet-Apens.
    const joueursAvant = [joueur("guetteur", { role: "guet_apens" })];
    assert.strictEqual(resolveGuetApensReveal({ deathIdCombat: null, attacks: [], joueursAvant }), null);
  }

  // ── resolveExplosifRetaliation : riposte 1 dégât sur un Villageois, jamais
  // sur un tir ami Gobelin, jamais mortelle ──
  {
    // Mort au combat -> riposte sur l'attaquant, uniquement s'il est Villageois.
    const joueursAvant = [
      joueur("boom", { camp: "gobelin", role: "explosif" }),
      joueur("chasseur1"),
      joueur("gobelin_ami", { camp: "gobelin" }),
    ];
    const attacks = [
      { attackerId: "chasseur1", targetId: "boom", lieu: "camp_entrainement", degats: 1 },
      { attackerId: "gobelin_ami", targetId: "boom", lieu: "camp_entrainement", degats: 1 }, // tir ami -> jamais ciblé
    ];
    const retaliation = resolveExplosifRetaliation({
      eliminationsParVote: null,
      deathIdCombat: "boom",
      actionsRaw: {},
      attacks,
      joueursAvant,
    });
    assert.deepStrictEqual(retaliation, { gobelinId: "boom", targetId: "chasseur1" });
  }
  {
    // Mort au vote -> riposte sur un votant Villageois tiré au hasard parmi
    // ceux qui ont voté contre lui (les votants Gobelins, s'il y en a, sont
    // exclus des cibles).
    const joueursAvant = [
      joueur("boom", { camp: "gobelin", role: "explosif" }),
      joueur("chasseur1"),
      joueur("chasseur2"),
    ];
    const actionsRaw = {
      chasseur1: { primary: { lieu: "chateau", cibleId: "boom" } },
      chasseur2: { primary: { lieu: "chateau", cibleId: "boom" } },
    };
    const rng = rngSequence([0.9]);
    const retaliation = resolveExplosifRetaliation({
      eliminationsParVote: "boom",
      deathIdCombat: null,
      actionsRaw,
      attacks: [],
      joueursAvant,
      rng,
    });
    assert.strictEqual(retaliation.gobelinId, "boom");
    assert.ok(["chasseur1", "chasseur2"].includes(retaliation.targetId));
  }
  {
    // Le mort n'est pas l'Explosif -> pas de riposte.
    const joueursAvant = [joueur("normal", { camp: "gobelin" }), joueur("chasseur1")];
    assert.strictEqual(
      resolveExplosifRetaliation({
        eliminationsParVote: "normal",
        deathIdCombat: null,
        actionsRaw: { chasseur1: { primary: { lieu: "chateau", cibleId: "normal" } } },
        attacks: [],
        joueursAvant,
      }),
      null,
    );
  }
  {
    // computeCloture bout en bout : la riposte de l'Explosif ne cause jamais
    // de 2e mort le même jour, même si la cible est déjà à 1 PV avant la
    // riposte (décision explicite : "2e option", jamais de kill via la riposte).
    const joueursAvant = [
      joueur("boom", { camp: "gobelin", role: "explosif" }),
      joueur("voteur_gobelin", { camp: "gobelin" }),
      joueur("chasseur1", { pv: 1 }), // déjà à 1 PV, avant même toute riposte
    ];
    const actionsRaw = {
      voteur_gobelin: { primary: { lieu: "chateau", cibleId: "boom" } },
      chasseur1: { primary: { lieu: "chateau", cibleId: "boom" } }, // quorum 2, seul votant Villageois -> seule cible possible
    };
    const result = computeCloture({ jour: 2, actionsRaw, joueursAvant, config: CONFIG });
    assert.strictEqual(result.eliminationsParVote, "boom");
    assert.deepStrictEqual(result.explosifRetaliation, { gobelinId: "boom", targetId: "chasseur1" });
    const chasseur1Apres = result.joueursApres.find((j) => j.discordId === "chasseur1");
    assert.strictEqual(chasseur1Apres.alive, true);
    assert.strictEqual(chasseur1Apres.pv, 1); // clampé, jamais négatif/nul
  }

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
