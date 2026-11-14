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
  enqueteurs,
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
  compteRendu,
  stats,
  cloturer,
  classement,
  texteJournal,
} from "./quiestceRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../data/quiestce/quiestce.json", import.meta.url), "utf8"));
const BRUTES = JSON.parse(fs.readFileSync(new URL("../data/cardNames.json", import.meta.url), "utf8"));
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

  // ── Pool : 3 questions de base par jour (3 ou 4 fois chacune), + 1 avec la Loupe ──
  {
    const compte = {};
    for (const [jour, qs] of Object.entries(CONFIG.pool)) {
      assert.strictEqual(qs.length, 3, `jour ${jour}`);
      assert.ok(!qs.includes(CONFIG.pool_loupe[jour]), `question Loupe hors base, jour ${jour}`);
      for (const q of qs) compte[q] = (compte[q] || 0) + 1;
    }
    for (const q of QIDS) assert.ok(compte[q] >= 3 && compte[q] <= 4, q);
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
      assert.strictEqual(enqueteurs(p, id).length, 1);
      assert.notStrictEqual(p.joueurs[j.cible].cible, id);
      const [q] = j.enquete.ordre;
      assert.strictEqual(j.enquete.sources[q], "depart");
      assert.strictEqual(j.enquete.infos[q], p.cartes[p.joueurs[j.cible].carte].profil[q]);
      assert.ok(![...CONFIG.pool["1"], CONFIG.pool_loupe["1"]].includes(q), "indice hors des questions du jour (Loupe comprise)");
      assert.strictEqual(questionsPossibles(p, id, { config: CONFIG }).length, 3);
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
    assert.strictEqual(moi.malus, 0, "accusation ratée gratuite le jour 1");
    assert.strictEqual(accuser(p, "j0", cible.carte, { config: CONFIG }).erreur, "plafondAccusation");
    assert.strictEqual(accusationsRestantes(moi), 0);
    cloturer(p, { config: CONFIG });
    const r = accuser(p, "j0", cible.carte, { config: CONFIG, rng });
    assert.strictEqual(r.correct, true);
    assert.deepStrictEqual(moi.demasques, [cibleId]);
    assert.strictEqual(cible.nbDemasque, 1);
    assert.strictEqual(moi.cible, null, "l'enquêteur choisit sa prochaine cible");
    assert.ok(!ciblesDisponibles(p, "j0", { config: CONFIG }).includes(cibleId), "jamais un joueur déjà démasqué");
    const suivante = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    assert.ok(choisirCible(p, "j0", suivante, { config: CONFIG, rng }).depart, "indice de départ sur la nouvelle cible");
    assert.ok(!candidats(p, "j0").includes(cible.carte), "carte découverte barrée");
    assert.strictEqual(choisirCible(p, "j0", suivante, { config: CONFIG }).erreur, "dejaCible");
    assert.strictEqual(texteJournal(p, p.journal.find((e) => e.k === "demasque")), `🎯 **j0** a démasqué **${cible.username}** !`);
  }

  // ── Choix de cible : meneur proposé en premier, 2 enquêteurs au plus ──
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
    assert.ok(enqueteurs(p, "j4").length <= CONFIG.enqueteurs_max);
    assert.ok(!ciblesDisponibles(p, "j0", { config: CONFIG }).includes("j4"), "cible pleine");
  }

  // ── Brouillard : questions sans réponse jusqu'à la clôture ──
  {
    const p = partieTest(6);
    const enqueteur = "j0";
    const cibleId = p.joueurs.j0.cible;
    p.joueurs[cibleId].objets = ["brouillard"];
    assert.ok(!utiliserObjet(p, cibleId, "brouillard", { config: CONFIG }).erreur);
    const q = questionsPossibles(p, enqueteur, { config: CONFIG })[0];
    const avant = p.joueurs.j0.enquete.ordre.length;
    assert.strictEqual(poser(p, enqueteur, q, { config: CONFIG }).brouille, true);
    assert.strictEqual(p.joueurs.j0.enquete.ordre.length, avant, "aucune information");
    assert.strictEqual(poser(p, enqueteur, q, { config: CONFIG }).erreur, "plafondQuestion", "question perdue");
    assert.strictEqual(accuser(p, enqueteur, candidats(p, enqueteur)[0], { config: CONFIG }).erreur, "brouillard", "accusation impossible");
    cloturer(p, { config: CONFIG });
    assert.ok(!poser(p, enqueteur, questionsPossibles(p, enqueteur, { config: CONFIG })[0], { config: CONFIG }).brouille);
  }

  // ── Déguisement : nouvelle carte libre, indices des enquêteurs effacés ──
  {
    const p = partieTest(6);
    const cibleId = p.joueurs.j0.cible;
    const ancienne = p.joueurs[cibleId].carte;
    p.joueurs.j3.renseignements[cibleId] = { rarete: "x" };
    p.joueurs[cibleId].objets = ["deguisement"];
    const r = utiliserObjet(p, cibleId, "deguisement", { config: CONFIG, rng });
    assert.ok(!r.erreur);
    assert.notStrictEqual(p.joueurs[cibleId].carte, ancienne);
    // Classement final : toutes les cartes tenues, dans l'ordre
    assert.deepStrictEqual(classement(p).find((x) => x.discordId === cibleId).cartes, [ancienne, p.joueurs[cibleId].carte]);
    assert.strictEqual(p.joueurs.j0.enquete.ordre.length, 0);
    assert.strictEqual(p.joueurs.j3.renseignements[cibleId], undefined, "renseignements du Miroir effacés");
    assert.ok(candidats(p, "j0").includes(p.joueurs[cibleId].carte));
    // La carte découverte par un enquêteur n'est jamais redistribuée
    p.joueurs.j1.cartesConnues.push(ancienne);
    assert.ok(!cartesLibres(p).includes(ancienne));
  }

  // ── Loupe (4e question au choix), Double accusation, un objet par jour ──
  {
    const p = partieTest(8);
    const moi = p.joueurs.j0;
    moi.enquete = enqueteVide();
    moi.objets = ["loupe", "double"];
    assert.deepStrictEqual(questionsPossibles(p, "j0", { config: CONFIG }), CONFIG.pool["1"]);
    assert.ok(!utiliserObjet(p, "j0", "loupe", { config: CONFIG }).erreur);
    assert.deepStrictEqual(questionsPossibles(p, "j0", { config: CONFIG }), [...CONFIG.pool["1"], CONFIG.pool_loupe["1"]]);
    assert.ok(!poser(p, "j0", CONFIG.pool_loupe["1"], { config: CONFIG }).erreur, "question Loupe posée");
    assert.strictEqual(poser(p, "j0", CONFIG.pool["1"][0], { config: CONFIG }).erreur, "plafondQuestion", "toujours une seule question");
    cloturer(p, { config: CONFIG });
    assert.strictEqual(moi.loupe, false);
    // Loupe inutile une fois la question posée
    poser(p, "j0", questionsPossibles(p, "j0", { config: CONFIG })[0], { config: CONFIG });
    moi.objets.push("loupe");
    assert.strictEqual(etatObjet(p, "j0", "loupe", { config: CONFIG }).raison, "questionPosee");
    assert.ok(!utiliserObjet(p, "j0", "double", { config: CONFIG }).erreur);
    moi.enquete = enqueteVide();
    const vraie = p.joueurs[moi.cible].carte;
    const fausse = candidats(p, "j0").find((k) => k !== vraie);
    assert.strictEqual(accuser(p, "j0", fausse, { config: CONFIG }).correct, false);
    assert.strictEqual(accuser(p, "j0", vraie, { config: CONFIG, rng }).correct, true, "2e accusation le même jour");
    // Double accusation sur la cible actuelle, même après une accusation
    // réussie plus tôt dans la journée sur une autre cible (cas du 12/10)
    cloturer(p, { config: CONFIG });
    const c1 = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    choisirCible(p, "j0", c1, { config: CONFIG, rng });
    assert.strictEqual(accuser(p, "j0", p.joueurs[c1].carte, { config: CONFIG, rng }).correct, true);
    const c2 = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    choisirCible(p, "j0", c2, { config: CONFIG, rng });
    assert.strictEqual(accusationsRestantes(moi), 0, "sans objet : quota du jour épuisé");
    moi.objets = ["double"];
    moi.objetJour = false;
    assert.ok(!utiliserObjet(p, "j0", "double", { config: CONFIG }).erreur);
    assert.strictEqual(accusationsRestantes(moi), 2, "deux accusations sur la nouvelle cible");
    moi.enquete = enqueteVide();
    const fausse2 = candidats(p, "j0").find((k) => k !== p.joueurs[c2].carte);
    accuser(p, "j0", fausse2, { config: CONFIG });
    assert.strictEqual(accuser(p, "j0", p.joueurs[c2].carte, { config: CONFIG, rng }).correct, true);
  }

  // ── Miroir : la cible apprend la même caractéristique de son enquêteur ──
  {
    const p = partieTest(6);
    const enqueteur = "j0";
    const cibleId = p.joueurs.j0.cible;
    const cible = p.joueurs[cibleId];
    cible.objets = ["miroir"];
    assert.ok(!utiliserObjet(p, cibleId, "miroir", { config: CONFIG }).erreur);
    const q = questionsPossibles(p, enqueteur, { config: CONFIG })[0];
    assert.ok(poser(p, enqueteur, q, { config: CONFIG }).valeur, "l'enquêteur reçoit quand même sa réponse");
    assert.strictEqual(cible.renseignements[enqueteur][q], p.cartes[p.joueurs[enqueteur].carte].profil[q]);
    assert.strictEqual(cible.miroir, false, "une seule fois");
    // Renseignement repris si l'enquêteur devient la cible
    cible.cible = null;
    p.joueurs[enqueteur].nbDemasque = 0;
    const autres = Object.keys(p.joueurs).filter((id) => id !== cibleId);
    for (const id of autres) if (id !== enqueteur && p.joueurs[id].cible === enqueteur) p.joueurs[id].cible = null;
    assert.ok(choisirCible(p, cibleId, enqueteur, { config: CONFIG, rng }).cible);
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

  // ── Accusation ratée : gratuite le jour 1, -malus_erreur ensuite ──
  {
    const p = partieTest(8);
    const moi = p.joueurs.j0;
    cloturer(p, { config: CONFIG });
    const avant = points(moi);
    const fausse = candidats(p, "j0").find((k) => k !== p.joueurs[moi.cible].carte);
    assert.strictEqual(accuser(p, "j0", fausse, { config: CONFIG }).malus, CONFIG.malus_erreur);
    assert.strictEqual(points(moi), avant - CONFIG.malus_erreur);
  }

  // ── Classement : points = points des cartes - malus, puis découvertes, puis ratées ──
  {
    const p = partieTest(4);
    const [a, b, c, d] = ["j0", "j1", "j2", "j3"].map((id) => p.joueurs[id]);
    a.demasques = ["x", "y", "z"]; a.pointsCartes = 9; a.malus = 3; // 6 pts, 3 découvertes
    b.demasques = ["x", "y"]; b.pointsCartes = 6; b.erreurs = 2; // 6 pts, 2 découvertes
    c.demasques = ["x", "y"]; c.pointsCartes = 6; // 6 pts, 2 découvertes, 0 ratée
    d.demasques = ["x", "y", "z", "w"]; d.pointsCartes = 12; d.malus = 8; // 4 pts
    const r = classement(p);
    assert.deepStrictEqual(r.map((x) => x.discordId), ["j0", "j2", "j1", "j3"]);
    assert.deepStrictEqual([r[0].score, r[0].decouvertes], [6, 3]);
    // Partie antérieure au 13/10 (sans pointsCartes ni malus) : 1 pt par carte, -1 par démasquage
    assert.strictEqual(points({ demasques: ["x", "y"], nbDemasque: 1, bonus: 2, survie: 3 }), 6);
  }

  // ── Bonus d'efficacité (+3/+2/+1 selon les indices connus) et survie ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    const cibleId = moi.cible;
    // 1 indice (indice de départ seul) : +1 et +3 d'efficacité
    assert.strictEqual(moi.enquete.ordre.length, 1);
    const r = accuser(p, "j0", p.joueurs[cibleId].carte, { config: CONFIG, rng });
    assert.deepStrictEqual([r.points, r.bonus, r.nbIndices], [CONFIG.points_carte, CONFIG.bonus_efficacite[0], 1]);
    assert.strictEqual(points(moi), CONFIG.points_carte + CONFIG.bonus_efficacite[0]);
    // Survie : +1 à la clôture pour qui a joué ce jour-là sans être démasqué
    const cible = p.joueurs[cibleId];
    const inactif = Object.values(p.joueurs).find((j) => j !== moi && j !== cible && !j.actifJour);
    cible.actifJour = true;
    cloturer(p, { config: CONFIG });
    assert.strictEqual(moi.survie, CONFIG.bonus_survie_jour);
    assert.strictEqual(cible.survie, 0, "démasqué ce jour-là");
    assert.strictEqual(inactif.survie, 0, "n'a pas joué ce jour-là");
    assert.strictEqual(points(cible), -CONFIG.malus_demasque);
    cible.actifJour = true;
    cloturer(p, { config: CONFIG });
    assert.strictEqual(cible.survie, CONFIG.bonus_survie_jour);
    assert.strictEqual(moi.survie, CONFIG.bonus_survie_jour, "pas d'action ce jour-là");
    // 4 indices ou plus : pas de bonus
    const c2 = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    choisirCible(p, "j0", c2, { config: CONFIG, rng });
    for (const q of QIDS) if (!(q in moi.enquete.infos) && moi.enquete.ordre.length < 4) { moi.enquete.infos[q] = p.cartes[p.joueurs[c2].carte].profil[q]; moi.enquete.ordre.push(q); }
    assert.strictEqual(accuser(p, "j0", p.joueurs[c2].carte, { config: CONFIG, rng }).bonus, 0);
  }

  // ── Objet gagné au démasquage, plusieurs objets par jour ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    const r = accuser(p, "j0", p.joueurs[moi.cible].carte, { config: CONFIG, rng });
    assert.ok(r.objetGagne && moi.objets.includes(r.objetGagne), "objet gagné au démasquage");
    assert.strictEqual(accuser(p, "j1", p.joueurs[p.joueurs.j1.cible].carte, { config: { ...CONFIG, objet_demasquage: false }, rng }).objetGagne, null);
    // Réserve pleine : rien de plus
    const j2 = p.joueurs.j2;
    j2.objets = ["loupe", "loupe", "loupe"];
    assert.strictEqual(accuser(p, "j2", p.joueurs[j2.cible].carte, { config: CONFIG, rng }).objetGagne, null);
    assert.strictEqual(j2.objets.length, CONFIG.inventaire_max);
    // Sans limite par jour (`objets_par_jour` = 0) : deux objets le même jour
    const j3 = p.joueurs.j3;
    j3.objets = ["brouillard", "miroir"];
    assert.ok(!utiliserObjet(p, "j3", "brouillard", { config: CONFIG, rng }).erreur);
    assert.ok(!utiliserObjet(p, "j3", "miroir", { config: CONFIG, rng }).erreur);
    // Plafond à 1 par jour
    const j4 = p.joueurs.j4;
    j4.objets = ["brouillard", "miroir"];
    const un = { ...CONFIG, objets_par_jour: 1 };
    assert.ok(!utiliserObjet(p, "j4", "brouillard", { config: un, rng }).erreur);
    assert.strictEqual(utiliserObjet(p, "j4", "miroir", { config: un, rng }).erreur, "objetJour");
    cloturer(p, { config: un });
    assert.ok(!utiliserObjet(p, "j4", "miroir", { config: un, rng }).erreur, "plafond remis à zéro à la clôture");
  }

  // ── Compte-rendu : statistiques tenues dès le Jour 1, phrases ──
  {
    const p = partieTest(6);
    const ids = Object.keys(p.joueurs);
    debutAction(p, "j0", { config: CONFIG, rng });
    assert.strictEqual(Object.values(stats(p.joueurs.j0).recus).reduce((a, b) => a + b, 0), 1, "objet du jour compté");
    // j0 démasque sa cible au flair, avec seulement l'indice de départ
    const cible = p.joueurs.j0.cible;
    const n = candidats(p, "j0").length;
    accuser(p, "j0", p.joueurs[cible].carte, { config: CONFIG, rng });
    assert.deepStrictEqual(p.coup, { s: "j0", v: cible, n, j: 1 });
    p.joueurs.j1.stats = { recus: { double: 4 }, utilises: {}, pileFaceGagnes: 0, pileFacePerdus: 3, brouillees: 0 };
    for (const id of ids) p.joueurs[id].actifJour = true;
    cloturer(p, { config: CONFIG });
    assert.strictEqual(p.soirs.length, 1);
    const bref = compteRendu(p).join("\n");
    assert.match(bref, /\*\*j0\*\* a mené de bout en bout/);
    assert.match(bref, /\*\*j1\*\* a tiré 4 Doubles accusations/);
    assert.match(bref, /Pas de chance pour \*\*j1\*\* : 3 pile ou face perdus/);
    if (n >= 3) assert.match(bref, new RegExp(`Plus beau coup : \\*\\*j0\\*\\* a démasqué .* avec 1 chance sur ${n}`));
  }

  console.log("quiestceRules.test.js : OK");
}

main();
