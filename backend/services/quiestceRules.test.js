import assert from "assert";
import fs from "fs";
import {
  QIDS,
  completerCartes,
  carteEligible,
  profil,
  creerPartie,
  inscrire,
  desinscrire,
  tirerGrille,
  demarrer,
  chasseurs,
  ciblesDisponibles,
  choisirCible,
  points,
  cartesLibres,
  debutAction,
  candidats,
  questionsPossibles,
  accusationsRestantes,
  poser,
  accuser,
  etatObjet,
  utiliserObjet,
  cloturer,
  classement,
  texteJournal,
} from "./quiestceRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/quiestce/quiestce.json", import.meta.url), "utf8"));
const BRUTES = JSON.parse(fs.readFileSync(new URL("../../data/cardNames.json", import.meta.url), "utf8"));
const CARTES = completerCartes(BRUTES, CONFIG.complements);

// Générateur déterministe
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// Partie démarrée avec `n` joueurs j0…j(n-1)
function partieTest(n, rng = seeded()) {
  const p = creerPartie();
  for (let i = 0; i < n; i++) inscrire(p, `j${i}`, `j${i}`, { config: { ...CONFIG, effectif_max: Infinity } });
  demarrer(p, { config: CONFIG, cartesData: CARTES, rng });
  return p;
}

const enqueteVide = () => ({ infos: {}, ordre: [], sources: {}, posees: 0, eliminees: [] });

function main() {
  const rng = seeded();

  // ── Cartes éligibles : PV et portée connus pour les troupes ──
  {
    assert.strictEqual(carteEligible(CARTES.find((c) => c.cardKey === "Goblin Gang")), false);
    assert.strictEqual(carteEligible(BRUTES.find((c) => c.cardKey === "Monk")), false);
    const moine = CARTES.find((c) => c.cardKey === "Monk");
    assert.strictEqual(carteEligible(moine), true);
    assert.deepStrictEqual([profil(moine).pv, profil(moine).portee], ["plus de 1500", "mêlée"]);
    const exclues = CARTES.filter((c) => (c.type === "troop" || c.type === "flying") && !carteEligible(c)).map((c) => c.cardKey).sort();
    assert.deepStrictEqual(exclues, ["Goblin Gang", "Rascals", "Spirit Empress"]);
    const tesla = CARTES.find((c) => c.cardKey === "Tesla");
    assert.strictEqual(profil(tesla).pv, "sans objet (sort ou bâtiment)");
  }

  // ── Pool : 4 questions par jour, chacune 4 ou 5 fois dans la semaine ──
  {
    const compte = {};
    for (const [jour, qs] of Object.entries(CONFIG.pool)) {
      assert.strictEqual(qs.length, 4, `jour ${jour}`);
      for (const q of qs) compte[q] = (compte[q] || 0) + 1;
    }
    for (const q of QIDS) assert.ok(compte[q] >= 4 && compte[q] <= 5, q);
  }

  // ── Grille : taille, sans jumelles, contraintes de composition ──
  for (let k = 0; k < 20; k++) {
    const g = tirerGrille(CARTES, 30, rng);
    assert.strictEqual(g.length, 30);
    assert.strictEqual(new Set(g.map((c) => QIDS.map((q) => profil(c)[q]).join("|"))).size, 30);
    assert.ok(g.filter((c) => c.type === "spell").length >= 4);
  }

  // ── Démarrage : cartes uniques, cercle de cibles, indice de départ hors pool ──
  {
    const p = partieTest(12);
    assert.strictEqual(new Set(Object.values(p.joueurs).map((j) => j.carte)).size, 12);
    for (const [id, j] of Object.entries(p.joueurs)) {
      assert.strictEqual(chasseurs(p, id).length, 1);
      assert.notStrictEqual(p.joueurs[j.cible].cible, id);
      const [q] = j.enquete.ordre;
      assert.strictEqual(j.enquete.sources[q], "depart");
      assert.strictEqual(j.enquete.infos[q], p.cartes[p.joueurs[j.cible].carte].profil[q]);
      assert.ok(!CONFIG.pool["1"].includes(q), "indice hors des questions du jour");
      assert.strictEqual(questionsPossibles(p, id, { config: CONFIG }).length, 4);
    }
    assert.strictEqual(cartesLibres(p).length, 18);
  }

  // ── Inscriptions : plafond, désinscription, fermées au lancement ──
  {
    const p = creerPartie();
    for (let i = 0; i < CONFIG.effectif_max; i++) assert.ok(inscrire(p, `i${i}`, `i${i}`, { config: CONFIG }).nouveau);
    assert.strictEqual(inscrire(p, "trop", "Trop", { config: CONFIG }).erreur, "complet");
    assert.ok(desinscrire(p, "i3").ok);
    assert.ok(inscrire(p, "trop", "Trop", { config: CONFIG }).nouveau);
    demarrer(p, { config: CONFIG, cartesData: CARTES, rng });
    assert.strictEqual(inscrire(p, "tard", "Tard", { config: CONFIG }).erreur, "inscriptions");
  }

  // ── Objet du jour : un par jour, réserve plafonnée ──
  {
    const p = partieTest(6);
    const r = debutAction(p, "j0", { config: CONFIG, rng });
    assert.ok(r.objetRecu && p.joueurs.j0.objets.length === 1);
    assert.strictEqual(debutAction(p, "j0", { config: CONFIG, rng }).objetRecu, null, "un seul objet par jour");
    for (let d = 0; d < 5; d++) {
      cloturer(p, { config: CONFIG });
      debutAction(p, "j0", { config: CONFIG, rng });
    }
    assert.strictEqual(p.joueurs.j0.objets.length, CONFIG.inventaire_max);
  }

  // ── Question : une par jour, parmi le pool du jour ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    const cible = p.joueurs[moi.cible];
    moi.enquete = enqueteVide();
    assert.deepStrictEqual(questionsPossibles(p, "j0", { config: CONFIG }), CONFIG.pool["1"]);
    assert.strictEqual(poser(p, "j0", "pv", { config: CONFIG }).erreur, "question");
    const r = poser(p, "j0", "rarete", { config: CONFIG });
    assert.strictEqual(r.valeur, p.cartes[cible.carte].profil.rarete);
    assert.strictEqual(poser(p, "j0", "elixir", { config: CONFIG }).erreur, "plafondQuestion");
    assert.ok(candidats(p, "j0").every((k) => p.cartes[k].profil.rarete === r.valeur));
  }

  // ── Accusation : ratée barrée, juste = carte découverte + cible au hasard ──
  {
    const p = partieTest(8);
    const moi = p.joueurs.j0;
    const cibleId = moi.cible;
    const cible = p.joueurs[cibleId];
    const fausse = candidats(p, "j0").find((k) => k !== cible.carte);
    assert.strictEqual(accuser(p, "j0", fausse, { config: CONFIG }).correct, false);
    assert.strictEqual(moi.erreurs, 1);
    assert.strictEqual(accuser(p, "j0", cible.carte, { config: CONFIG }).erreur, "plafondAccusation");
    assert.strictEqual(accusationsRestantes(moi), 0);
    cloturer(p, { config: CONFIG });
    const r = accuser(p, "j0", cible.carte, { config: CONFIG, rng });
    assert.strictEqual(r.correct, true);
    assert.deepStrictEqual(moi.demasques, [cibleId]);
    assert.strictEqual(cible.nbDemasque, 1);
    assert.strictEqual(moi.cible, null, "le chasseur choisit sa prochaine cible");
    assert.ok(!ciblesDisponibles(p, "j0", { config: CONFIG }).includes(cibleId), "jamais un joueur déjà démasqué");
    const suivante = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    assert.ok(choisirCible(p, "j0", suivante, { config: CONFIG, rng }).depart, "indice de départ sur la nouvelle cible");
    assert.ok(!candidats(p, "j0").includes(cible.carte), "carte découverte barrée");
    assert.strictEqual(choisirCible(p, "j0", suivante, { config: CONFIG }).erreur, "dejaCible");
    assert.strictEqual(texteJournal(p, p.journal.find((e) => e.k === "demasque")), `🎯 **j0** a démasqué **${cible.username}** !`);
  }

  // ── Choix de cible : meneur proposé en premier, 2 chasseurs au plus ──
  {
    const p = partieTest(6);
    p.joueurs.j4.demasques = ["a", "b"]; // 2 pts
    p.joueurs.j2.demasques = ["a"]; // 1 pt
    p.joueurs.j0.cible = null;
    const dispo = ciblesDisponibles(p, "j0", { config: CONFIG });
    const ordre = dispo.map((id) => points(p.joueurs[id]));
    assert.deepStrictEqual(ordre, [...ordre].sort((a, b) => b - a), "triées du meneur au dernier");
    for (const id of ["j1", "j2", "j3", "j5"]) {
      p.joueurs[id].cible = null;
      choisirCible(p, id, "j4", { config: CONFIG, rng });
    }
    assert.ok(chasseurs(p, "j4").length <= CONFIG.chasseurs_max);
    assert.ok(!ciblesDisponibles(p, "j0", { config: CONFIG }).includes("j4"), "cible pleine");
  }

  // ── Brouillard : questions sans réponse jusqu'à la clôture ──
  {
    const p = partieTest(6);
    const chasseur = "j0";
    const cibleId = p.joueurs.j0.cible;
    p.joueurs[cibleId].objets = ["brouillard"];
    assert.ok(!utiliserObjet(p, cibleId, "brouillard", { config: CONFIG }).erreur);
    const q = questionsPossibles(p, chasseur, { config: CONFIG })[0];
    const avant = p.joueurs.j0.enquete.ordre.length;
    assert.strictEqual(poser(p, chasseur, q, { config: CONFIG }).brouille, true);
    assert.strictEqual(p.joueurs.j0.enquete.ordre.length, avant, "aucune information");
    assert.strictEqual(poser(p, chasseur, q, { config: CONFIG }).erreur, "plafondQuestion", "question perdue");
    assert.strictEqual(accuser(p, chasseur, candidats(p, chasseur)[0], { config: CONFIG }).erreur, "brouillard", "accusation impossible");
    cloturer(p, { config: CONFIG });
    assert.ok(!poser(p, chasseur, questionsPossibles(p, chasseur, { config: CONFIG })[0], { config: CONFIG }).brouille);
  }

  // ── Déguisement : nouvelle carte libre, indices des chasseurs effacés ──
  {
    const p = partieTest(6);
    const cibleId = p.joueurs.j0.cible;
    const ancienne = p.joueurs[cibleId].carte;
    p.joueurs.j3.renseignements[cibleId] = { rarete: "x" };
    p.joueurs[cibleId].objets = ["deguisement"];
    const r = utiliserObjet(p, cibleId, "deguisement", { config: CONFIG, rng });
    assert.ok(!r.erreur);
    assert.notStrictEqual(p.joueurs[cibleId].carte, ancienne);
    assert.strictEqual(p.joueurs.j0.enquete.ordre.length, 0);
    assert.strictEqual(p.joueurs.j3.renseignements[cibleId], undefined, "renseignements du Miroir effacés");
    assert.ok(candidats(p, "j0").includes(p.joueurs[cibleId].carte));
    // La carte découverte par un chasseur n'est jamais redistribuée
    p.joueurs.j1.cartesConnues.push(ancienne);
    assert.ok(!cartesLibres(p).includes(ancienne));
  }

  // ── Loupe, Double accusation, un objet par jour ──
  {
    const p = partieTest(8);
    const moi = p.joueurs.j0;
    moi.objets = ["loupe", "double"];
    assert.ok(!utiliserObjet(p, "j0", "loupe", { config: CONFIG }).erreur);
    assert.strictEqual(utiliserObjet(p, "j0", "double", { config: CONFIG }).erreur, "objetJour");
    assert.ok(!poser(p, "j0", questionsPossibles(p, "j0", { config: CONFIG })[0], { config: CONFIG }).erreur);
    assert.ok(!poser(p, "j0", questionsPossibles(p, "j0", { config: CONFIG })[0], { config: CONFIG }).erreur, "2e question avec la Loupe");
    cloturer(p, { config: CONFIG });
    assert.ok(!utiliserObjet(p, "j0", "double", { config: CONFIG }).erreur);
    moi.enquete = enqueteVide();
    const vraie = p.joueurs[moi.cible].carte;
    const fausse = candidats(p, "j0").find((k) => k !== vraie);
    assert.strictEqual(accuser(p, "j0", fausse, { config: CONFIG }).correct, false);
    assert.strictEqual(accuser(p, "j0", vraie, { config: CONFIG, rng }).correct, true, "2e accusation le même jour");
  }

  // ── Miroir : la cible apprend la même caractéristique de son chasseur ──
  {
    const p = partieTest(6);
    const chasseur = "j0";
    const cibleId = p.joueurs.j0.cible;
    const cible = p.joueurs[cibleId];
    cible.objets = ["miroir"];
    assert.ok(!utiliserObjet(p, cibleId, "miroir", { config: CONFIG }).erreur);
    const q = questionsPossibles(p, chasseur, { config: CONFIG })[0];
    assert.ok(poser(p, chasseur, q, { config: CONFIG }).valeur, "le chasseur reçoit quand même sa réponse");
    assert.strictEqual(cible.renseignements[chasseur][q], p.cartes[p.joueurs[chasseur].carte].profil[q]);
    assert.strictEqual(cible.miroir, false, "une seule fois");
    // Renseignement repris si le chasseur devient la cible
    cible.cible = null;
    p.joueurs[chasseur].nbDemasque = 0;
    const autres = Object.keys(p.joueurs).filter((id) => id !== cibleId);
    for (const id of autres) if (id !== chasseur && p.joueurs[id].cible === chasseur) p.joueurs[id].cible = null;
    assert.ok(choisirCible(p, cibleId, chasseur, { config: CONFIG, rng }).cible);
    assert.strictEqual(cible.enquete.sources[q], "miroir");
  }

  // ── Désamorçage : coupe le Brouillard actif, sinon détruit un défensif ──
  {
    const p = partieTest(6);
    const cibleId = p.joueurs.j0.cible;
    const cible = p.joueurs[cibleId];
    cible.brouillard = true;
    cible.objets = ["deguisement", "loupe"];
    p.joueurs.j0.objets = ["desamorcage"];
    assert.strictEqual(utiliserObjet(p, "j0", "desamorcage", { config: CONFIG, rng }).detruit, "brouillard");
    assert.strictEqual(cible.brouillard, false);
    cloturer(p, { config: CONFIG });
    p.joueurs.j0.objets = ["desamorcage"];
    assert.strictEqual(utiliserObjet(p, "j0", "desamorcage", { config: CONFIG, rng }).detruit, "deguisement");
    assert.deepStrictEqual(cible.objets, ["loupe"], "les objets offensifs restent");
    cloturer(p, { config: CONFIG });
    p.joueurs.j0.objets = ["desamorcage"];
    assert.strictEqual(utiliserObjet(p, "j0", "desamorcage", { config: CONFIG, rng }).detruit, null);
  }

  // ── Classement : points = découvertes - démasquages, puis découvertes, puis ratées ──
  {
    const p = partieTest(4);
    const [a, b, c, d] = ["j0", "j1", "j2", "j3"].map((id) => p.joueurs[id]);
    a.demasques = ["x", "y", "z"]; a.nbDemasque = 1; // 2 pts, 3 découvertes
    b.demasques = ["x", "y"]; b.nbDemasque = 0; b.erreurs = 2; // 2 pts, 2 découvertes
    c.demasques = ["x", "y"]; c.nbDemasque = 0; // 2 pts, 2 découvertes, 0 ratée
    d.demasques = ["x", "y", "z", "w"]; d.nbDemasque = 3; // 1 pt
    const r = classement(p);
    assert.deepStrictEqual(r.map((x) => x.discordId), ["j0", "j2", "j1", "j3"]);
    assert.deepStrictEqual([r[0].score, r[0].decouvertes], [2, 3]);
  }

  console.log("quiestceRules.test.js : OK");
}

main();
