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
  candidats,
  questionsPossibles,
  poser,
  accuser,
  leaderPrime,
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

function main() {
  const rng = seeded();

  // ── Cartes éligibles : PV et portée connus pour les troupes ──
  {
    // Gang de gobelins : portée ambiguë (mêlée et distance), non complété
    const gang = CARTES.find((c) => c.cardKey === "Goblin Gang");
    assert.strictEqual(carteEligible(gang), false);
    // Moine : complété par quiestce.json, cardNames.json inchangé
    assert.strictEqual(carteEligible(BRUTES.find((c) => c.cardKey === "Monk")), false);
    const moine = CARTES.find((c) => c.cardKey === "Monk");
    assert.strictEqual(carteEligible(moine), true);
    assert.deepStrictEqual([profil(moine).pv, profil(moine).portee], ["plus de 1500", "mêlée"]);
    assert.strictEqual(profil(CARTES.find((c) => c.cardKey === "Inferno Dragon")).portee, "distance");
    assert.strictEqual(carteEligible(CARTES.find((c) => c.cardKey === "Ronin")), true);
    const exclues = CARTES.filter((c) => (c.type === "troop" || c.type === "flying") && !carteEligible(c)).map((c) => c.cardKey).sort();
    assert.deepStrictEqual(exclues, ["Goblin Gang", "Rascals", "Spirit Empress"]);
    const miroir = CARTES.find((c) => c.elixir == null);
    assert.strictEqual(carteEligible(miroir), false);
    const tesla = CARTES.find((c) => c.cardKey === "Tesla");
    assert.strictEqual(carteEligible(tesla), true);
    assert.strictEqual(profil(tesla).pv, "sans objet (sort ou bâtiment)");
    const bebe = profil(CARTES.find((c) => c.cardKey === "Baby Dragon"));
    assert.deepStrictEqual(bebe, { rarete: "épique", elixir: "4", type: "troupe aérienne", portee: "distance", famille: "aucune", pv: "500 à 1500" });
  }

  // ── Grille : taille, sans jumelles, contraintes de composition ──
  for (let k = 0; k < 20; k++) {
    const g = tirerGrille(CARTES, 30, rng);
    assert.strictEqual(g.length, 30);
    const sigs = new Set(g.map((c) => QIDS.map((q) => profil(c)[q]).join("|")));
    assert.strictEqual(sigs.size, 30, "aucune carte jumelle");
    assert.ok(g.filter((c) => c.type === "spell").length >= 4);
    assert.ok(g.filter((c) => c.type === "building").length >= 2);
    assert.ok(g.filter((c) => c.type === "flying").length >= 3);
  }

  // ── Démarrage : cartes uniques, cercle de cibles (1 chasseur chacun) ──
  {
    const p = partieTest(12);
    const cartes = Object.values(p.joueurs).map((j) => j.carte);
    assert.strictEqual(new Set(cartes).size, 12);
    assert.strictEqual(p.grille.length, 30);
    for (const id of Object.keys(p.joueurs)) {
      assert.notStrictEqual(p.joueurs[id].cible, id);
      assert.strictEqual(chasseurs(p, id).length, 1);
      // pas de paire qui se chasse mutuellement (12 joueurs)
      assert.notStrictEqual(p.joueurs[p.joueurs[id].cible].cible, id);
    }
    // Grille agrandie au-delà de 30 joueurs (une carte par joueur)
    assert.strictEqual(partieTest(32).grille.length, 32);
  }

  // ── Inscriptions : plafond d'effectif, désinscription, fermées au lancement ──
  {
    const p = creerPartie();
    for (let i = 0; i < CONFIG.effectif_max; i++) assert.ok(inscrire(p, `i${i}`, `i${i}`, { config: CONFIG }).nouveau);
    assert.strictEqual(inscrire(p, "trop", "Trop", { config: CONFIG }).erreur, "complet");
    assert.ok(!inscrire(p, "i0", "i0", { config: CONFIG }).erreur, "déjà inscrit : pas d'erreur");
    assert.ok(desinscrire(p, "i3").ok);
    assert.strictEqual(desinscrire(p, "i3").erreur, "pasInscrit");
    assert.deepStrictEqual(Object.values(p.joueurs).map((j) => j.arrivee).sort((a, b) => a - b), [...Array(CONFIG.effectif_max - 1).keys()]);
    assert.ok(inscrire(p, "trop", "Trop", { config: CONFIG }).nouveau, "une place libérée");
    demarrer(p, { config: CONFIG, cartesData: CARTES, rng });
    assert.strictEqual(inscrire(p, "tard", "Tard", { config: CONFIG }).erreur, "inscriptions");
    assert.strictEqual(desinscrire(p, "i0").erreur, "inscriptions");
  }

  // ── Indice de départ : une caractéristique exacte à chaque nouvelle cible ──
  {
    const p = partieTest(8);
    for (const j of Object.values(p.joueurs)) {
      const cible = p.joueurs[j.cible];
      assert.strictEqual(j.enquete.ordre.length, 1);
      const [q] = j.enquete.ordre;
      assert.strictEqual(j.enquete.sources[q], "depart");
      assert.strictEqual(j.enquete.infos[q], p.cartes[cible.carte].profil[q]);
      assert.strictEqual(j.enquete.posees, 0, "l'indice n'est pas une question posée");
    }
    // Choix d'une cible déjà éclairée par un Projecteur : indice sur une autre caractéristique
    const moi = p.joueurs.j0;
    const autre = ciblesDisponibles(p, "j0", { config: CONFIG }).find((id) => id !== moi.cible);
    p.reveles[autre] = { rarete: p.cartes[p.joueurs[autre].carte].profil.rarete };
    moi.cible = null;
    const r = choisirCible(p, "j0", autre, { config: CONFIG, rng });
    assert.notStrictEqual(r.depart.q, "rarete");
    assert.deepStrictEqual(moi.enquete.ordre, ["rarete", r.depart.q]);
  }

  // ── Question : une par jour, parmi le pool du jour, réponse exacte ──
  {
    const p = partieTest(6);
    const id = "j0";
    const moi = p.joueurs[id];
    const cible = p.joueurs[moi.cible];
    // Enquête vidée (sans indice de départ) pour tester le pool seul
    moi.enquete = { infos: {}, ordre: [], sources: {}, posees: 0, eliminees: [] };
    assert.deepStrictEqual(questionsPossibles(p, id, { config: CONFIG }), CONFIG.pool["1"]);
    assert.strictEqual(poser(p, id, "pv", { config: CONFIG }).erreur, "question");
    const r = poser(p, id, "rarete", { config: CONFIG });
    assert.strictEqual(r.valeur, p.cartes[cible.carte].profil.rarete);
    assert.strictEqual(moi.or, CONFIG.or_par_jour, "1 Or au premier geste du jour");
    assert.strictEqual(poser(p, id, "elixir", { config: CONFIG }).erreur, "plafondQuestion");
    // Candidats : compatibles avec la réponse, sans sa propre carte
    const cs = candidats(p, id);
    assert.ok(cs.includes(cible.carte));
    assert.ok(!cs.includes(moi.carte));
    assert.ok(cs.every((k) => p.cartes[k].profil.rarete === r.valeur));
  }

  // ── Choix libre quand les 3 questions du jour sont déjà connues ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    moi.enquete = { infos: {}, ordre: [], sources: {}, posees: 0, eliminees: [] };
    for (const q of CONFIG.pool["1"]) moi.enquete.infos[q] = "x";
    const libres = questionsPossibles(p, "j0", { config: CONFIG });
    assert.deepStrictEqual(libres.sort(), QIDS.filter((q) => !CONFIG.pool["1"].includes(q)).sort());
  }

  // ── Accusation fausse : -1, carte éliminée, une seule par jour ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    const cible = p.joueurs[moi.cible];
    const fausse = candidats(p, "j0").find((k) => k !== cible.carte);
    assert.strictEqual(accuser(p, "j0", fausse, { config: CONFIG }).correct, false);
    assert.strictEqual(moi.score, -CONFIG.penalite_erreur);
    assert.strictEqual(moi.erreurs, 1);
    assert.ok(!candidats(p, "j0").includes(fausse));
    assert.strictEqual(accuser(p, "j0", cible.carte, { config: CONFIG }).erreur, "plafondAccusation");
  }

  // ── Accusation juste : gain, primes, nouvelle cible à choisir ──
  {
    const p = partieTest(6);
    const moi = p.joueurs.j0;
    const cibleId = moi.cible;
    const cible = p.joueurs[cibleId];
    cible.prime = 4;
    p.numeroJour = 3;
    const r = accuser(p, "j0", cible.carte, { config: CONFIG });
    assert.strictEqual(r.correct, true);
    assert.strictEqual(r.gain, CONFIG.gain_base - 3 + 4);
    assert.strictEqual(moi.score, r.gain);
    assert.strictEqual(moi.prime, CONFIG.prime_par_demasquage);
    assert.strictEqual(moi.or, CONFIG.or_par_jour + CONFIG.or_par_demasquage);
    assert.strictEqual(cible.prime, 0);
    assert.strictEqual(moi.cible, null);
    // Jamais un joueur déjà démasqué ; la carte démasquée est exclue ensuite
    assert.ok(!ciblesDisponibles(p, "j0", { config: CONFIG }).includes(cibleId));
    const nouvelle = ciblesDisponibles(p, "j0", { config: CONFIG })[0];
    assert.ok(choisirCible(p, "j0", nouvelle, { config: CONFIG }).cible);
    assert.ok(!candidats(p, "j0").includes(cible.carte));
    assert.strictEqual(choisirCible(p, "j0", nouvelle, { config: CONFIG }).erreur, "dejaCible");
    // Clôture : la victime ne gagne pas de prime ce jour-là
    cloturer(p, { config: CONFIG });
    assert.strictEqual(cible.prime, 0);
    assert.strictEqual(moi.prime, CONFIG.prime_par_demasquage + CONFIG.prime_par_jour);
    assert.strictEqual(p.numeroJour, 4);
    assert.strictEqual(p.veille.demasquages.length, 1);
    assert.strictEqual(texteJournal(p, p.journal.find((e) => e.k === "demasque")), `🎯 **j0** a démasqué **${cible.username}** (prime de 4) !`);
  }

  // ── Limite de chasseurs par cible ──
  {
    const p = partieTest(6);
    const cibleId = "j3";
    p.joueurs.j0.cible = null;
    p.joueurs.j1.cible = null;
    p.joueurs.j2.cible = null;
    // j3 a déjà son chasseur du cercle
    const avant = chasseurs(p, cibleId).length;
    for (const id of ["j0", "j1", "j2"]) {
      if (id === cibleId) continue;
      const r = choisirCible(p, id, cibleId, { config: CONFIG });
      if (chasseurs(p, cibleId).length > CONFIG.chasseurs_max) assert.fail("limite dépassée");
      if (r.erreur) assert.strictEqual(r.erreur, "cible");
    }
    assert.ok(chasseurs(p, cibleId).length <= CONFIG.chasseurs_max);
    assert.ok(avant <= CONFIG.chasseurs_max);
  }

  // ── Objets : Projecteur public, Vol de piste, Double enquête ──
  {
    const p = partieTest(6);
    for (const j of Object.values(p.joueurs)) j.or = 20;
    const leader = "j4";
    p.joueurs[leader].prime = 9;
    assert.strictEqual(leaderPrime(p), leader);
    assert.strictEqual(etatObjet(p, leader, "projecteur", { config: CONFIG }).raison, "leader");
    // Deux chasseurs sur le leader
    const [h1] = chasseurs(p, leader);
    const h2 = Object.keys(p.joueurs).find((id) => id !== leader && id !== h1);
    p.joueurs[h2].cible = null;
    choisirCible(p, h2, leader, { config: CONFIG });
    const lanceur = Object.keys(p.joueurs).find((id) => ![leader, h1, h2].includes(id));
    const r = utiliserObjet(p, lanceur, "projecteur", { config: CONFIG, q: "rarete" });
    assert.strictEqual(r.valeur, p.cartes[p.joueurs[leader].carte].profil.rarete);
    assert.strictEqual(p.joueurs[h1].enquete.infos.rarete, r.valeur);
    assert.strictEqual(p.joueurs[h2].enquete.infos.rarete, r.valeur);
    assert.deepStrictEqual(p.reveles[leader], { rarete: r.valeur });
    // Vol de piste : h1 pose une question, h2 la copie
    poser(p, h1, "elixir", { config: CONFIG });
    const v = utiliserObjet(p, h2, "vol", { config: CONFIG });
    assert.strictEqual(v.q, "elixir");
    assert.strictEqual(p.joueurs[h2].enquete.infos.elixir, p.joueurs[h1].enquete.infos.elixir);
    // Un objet par jour
    assert.strictEqual(utiliserObjet(p, h2, "double", { config: CONFIG }).erreur, "objetJour");
    cloturer(p, { config: CONFIG });
    // Double enquête : 2 questions, une seule fois par partie
    const d = Object.keys(p.joueurs).find((id) => p.joueurs[id].cible);
    assert.ok(!utiliserObjet(p, d, "double", { config: CONFIG }).erreur);
    const qs = questionsPossibles(p, d, { config: CONFIG });
    assert.ok(!poser(p, d, qs[0], { config: CONFIG }).erreur);
    assert.ok(!poser(p, d, questionsPossibles(p, d, { config: CONFIG })[0], { config: CONFIG }).erreur);
    cloturer(p, { config: CONFIG });
    assert.strictEqual(etatObjet(p, d, "double", { config: CONFIG }).raison, "doubleUtilise");
    // Or insuffisant
    p.joueurs.j5.or = 0;
    assert.strictEqual(etatObjet(p, "j5", "double", { config: CONFIG }).raison, "or");
  }

  // ── Nouvelle cible déjà éclairée par un Projecteur ──
  {
    const p = partieTest(6);
    p.reveles.j2 = { type: p.cartes[p.joueurs.j2.carte].profil.type };
    const chasseur = Object.keys(p.joueurs).find((id) => id !== "j2" && p.joueurs[id].cible !== "j2");
    p.joueurs[chasseur].cible = null;
    choisirCible(p, chasseur, "j2", { config: CONFIG });
    assert.strictEqual(p.joueurs[chasseur].enquete.infos.type, p.reveles.j2.type);
  }

  // ── Classement : points, accusations fausses, premier arrivé au score ──
  {
    const p = partieTest(4);
    const [a, b, c, d] = ["j0", "j1", "j2", "j3"].map((id) => p.joueurs[id]);
    a.score = 10; a.erreurs = 1; a.seqScore = 1;
    b.score = 10; b.erreurs = 0; b.seqScore = 5;
    c.score = 10; c.erreurs = 0; c.seqScore = 3;
    d.score = 12;
    const r = classement(p).map((x) => x.discordId);
    assert.deepStrictEqual(r, ["j3", "j2", "j1", "j0"]);
  }

  console.log("quiestceRules.test.js : OK");
}

main();
