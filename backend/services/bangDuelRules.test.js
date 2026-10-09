import assert from "assert";
import fs from "fs";
import { creerDuel, piocher, placer, jouer, voler, finirTour, jouerBot } from "./bangDuelRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/bang/duel.json", import.meta.url), "utf8"));

function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// Duel à mains et pioche imposées, au tour du joueur
function duelTest(mainJoueur, mainBot, pioche = []) {
  const d = creerDuel(CONFIG, { rng: seeded() });
  d.joueurs.joueur.main = [...mainJoueur];
  d.joueurs.bot.main = [...mainBot];
  d.pioche = [...pioche];
  return d;
}

function main() {
  const rng = seeded();

  // ── Mise en place : Esprit + main de départ, pioche avec Esprits et bombes ──
  {
    const d = creerDuel(CONFIG, { rng });
    const total = Object.values(CONFIG.paquet).reduce((a, b) => a + b, 0);
    for (const id of ["joueur", "bot"]) {
      assert.strictEqual(d.joueurs[id].main.length, 1 + CONFIG.main_depart);
      assert.strictEqual(d.joueurs[id].main.filter((c) => c === "esprit").length, 1);
    }
    assert.strictEqual(d.pioche.length, total - 2 * CONFIG.main_depart + CONFIG.esprits_pioche + CONFIG.bombes);
    assert.strictEqual(d.pioche.filter((c) => c === "bombe").length, CONFIG.bombes);
    assert.strictEqual(d.actif, "joueur");
  }

  // ── Tour : au moins une pioche, plafond, puis la main passe au Bot ──
  {
    const d = duelTest([], [], ["gobelin", "fut", "moine", "gang"]);
    assert.strictEqual(finirTour(d, "joueur", { config: CONFIG }).erreur, "doitPiocher");
    for (let k = 0; k < CONFIG.pioches_par_tour; k++) assert.ok(!piocher(d, "joueur", { config: CONFIG }).erreur);
    assert.strictEqual(piocher(d, "joueur", { config: CONFIG }).erreur, "plafondPioche");
    assert.strictEqual(piocher(d, "bot", { config: CONFIG }).erreur, "pasTonTour");
    assert.ok(!finirTour(d, "joueur", { config: CONFIG }).erreur);
    assert.strictEqual(d.actif, "bot");
    assert.strictEqual(d.tour, 1);
    finirTour(d, "bot", { config: CONFIG, force: true });
    assert.strictEqual(d.tour, 2, "un tour = joueur puis Bot");
  }

  // ── Gobelin explosif : Esprit sacrifié et bombe cachée, sinon défaite ──
  {
    const d = duelTest(["esprit"], [], ["bombe", "gobelin", "bombe"]);
    assert.strictEqual(piocher(d, "joueur", { config: CONFIG }).bang, "sauve");
    assert.strictEqual(finirTour(d, "joueur", { config: CONFIG }).erreur, "enAttente");
    placer(d, "joueur", "2");
    assert.deepStrictEqual(d.pioche, ["gobelin", "bombe", "bombe"]);
    assert.ok(d.soupcon.bot, "le Bot sait qu'une bombe a été cachée");
    finirTour(d, "joueur", { config: CONFIG });
    piocher(d, "bot", { config: CONFIG });
    assert.strictEqual(piocher(d, "bot", { config: CONFIG }).bang, "elimine");
    assert.ok(d.termine && d.gagnant === "joueur");
  }

  // ── Gang : termine le tour sans piocher, l'adversaire pioche 2 fois (sans cumul) ──
  {
    const d = duelTest(["gang"], ["fut"], ["gobelin", "gobelin", "gobelin"]);
    const r = jouer(d, "joueur", "gang", { config: CONFIG, rng });
    assert.ok(r.finTour && d.actif === "bot");
    assert.strictEqual(d.joueurs.bot.dette, CONFIG.gang_pioches);
    assert.strictEqual(finirTour(d, "bot", { config: CONFIG }).erreur, "dette");
    jouer(d, "bot", "fut", { config: CONFIG, rng });
    assert.strictEqual(d.joueurs.bot.dette, CONFIG.gang_pioches - 1, "le Fût esquive une des pioches dues");
    piocher(d, "bot", { config: CONFIG });
    assert.ok(!finirTour(d, "bot", { config: CONFIG }).erreur);
  }

  // ── Fût : compte comme la pioche du tour ──
  {
    const d = duelTest(["fut"], [], ["gobelin"]);
    jouer(d, "joueur", "fut", { config: CONFIG, rng });
    assert.ok(!finirTour(d, "joueur", { config: CONFIG }).erreur);
  }

  // ── Voleuse : le voleur choisit dans la main adverse ──
  {
    const d = duelTest(["voleuse"], ["esprit", "gobelin"], ["gobelin"]);
    const r = jouer(d, "joueur", "voleuse", { config: CONFIG, rng });
    assert.deepStrictEqual(r.choix, ["esprit", "gobelin"]);
    assert.strictEqual(piocher(d, "joueur", { config: CONFIG }).erreur, "vol", "choix obligatoire avant toute action");
    voler(d, "joueur", "esprit");
    assert.deepStrictEqual(d.joueurs.joueur.main, ["esprit"]);
    assert.deepStrictEqual(d.joueurs.bot.main, ["gobelin"]);
  }

  // ── Moine : renvoie la prochaine attaque, une seule fois ──
  {
    const d = duelTest(["gang", "voleuse", "gobelin"], ["moine", "gobelin"], ["gobelin", "gobelin", "gobelin"]);
    d.actif = "bot";
    jouer(d, "bot", "moine", { config: CONFIG, rng });
    finirTour(d, "bot", { config: CONFIG, force: true });
    const r = jouer(d, "joueur", "gang", { config: CONFIG, rng });
    assert.ok(r.renvoi && !r.finTour, "Gang renvoyé : le tour du joueur continue");
    assert.strictEqual(d.joueurs.joueur.dette, CONFIG.gang_pioches);
    assert.ok(!d.joueurs.bot.moine);
    assert.ok(jouer(d, "joueur", "voleuse", { config: CONFIG, rng }).choix, "2e attaque : plus de Moine");
  }

  // ── Fin : match nul après le dernier tour ──
  {
    const d = duelTest([], [], Array(50).fill("gobelin"));
    for (let t = 0; t < CONFIG.tours_max; t++) {
      piocher(d, "joueur", { config: CONFIG });
      finirTour(d, "joueur", { config: CONFIG });
      piocher(d, "bot", { config: CONFIG });
      finirTour(d, "bot", { config: CONFIG });
    }
    assert.ok(d.termine && d.gagnant === null && d.tour === CONFIG.tours_max);
  }

  // ── Bot : esquive un Gobelin explosif repéré à la Sarbacane ──
  {
    const d = duelTest([], ["sarbacane", "fut"], ["bombe", "gobelin"]);
    d.actif = "bot";
    jouerBot(d, "bot", { config: CONFIG, rng });
    assert.ok(!d.termine, "le Bot ne pioche pas la bombe vue");
    assert.strictEqual(d.actif, "joueur");
    assert.deepStrictEqual(d.pioche, ["bombe", "gobelin"]);
  }

  // ── Bot : parties complètes sans blocage ──
  {
    for (let g = 0; g < 200; g++) {
      const d = creerDuel(CONFIG, { rng });
      for (let k = 0; k < 100 && !d.termine; k++) jouerBot(d, d.actif, { config: CONFIG, rng });
      assert.ok(d.termine, "partie terminée");
    }
  }

  console.log("bangDuelRules.test.js : OK");
}

main();
