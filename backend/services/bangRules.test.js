import assert from "assert";
import fs from "fs";
import { creerPartie, ajouterJoueur, piocher, piocherClic, placer, jouer, cloturer, classement, nbBombes, vivants, texteJournal } from "./bangRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/bang/bang.json", import.meta.url), "utf8"));

// Générateur déterministe
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// Partie à joueurs donnés, pioche et mains imposées
function partieTest(mains, pioche = []) {
  const p = creerPartie();
  Object.entries(mains).forEach(([id, main], i) => {
    p.joueurs[id] = { username: id, main: [...main], elixir: 2, vivant: true, moine: false, maudit: 0, dette: 0, tourFait: false, enAttente: false, arrivee: i, rangElimination: null };
  });
  p.pioche = [...pioche];
  return p;
}

function main() {
  const rng = seeded();

  // ── Arrivées : Esprit + main de départ, une bombe par joueur dès le 2e ──
  {
    const p = creerPartie();
    for (let i = 0; i < 4; i++) ajouterJoueur(p, `j${i}`, `j${i}`, { config: CONFIG, rng });
    for (const [, j] of vivants(p)) {
      assert.strictEqual(j.main[0], "esprit");
      assert.strictEqual(j.main.length, 1 + CONFIG.main_depart);
      assert.ok(!j.main.includes("bombe"));
    }
    // 1,5 bombe par joueur à partir du 2e : 1 + 2 + 1 (j1, j2, j3)
    assert.strictEqual(nbBombes(p), Math.floor(3 * CONFIG.bombes_par_joueur));
    // Arrivée idempotente
    const avant = p.pioche.length;
    ajouterJoueur(p, "j0", "j0", { config: CONFIG, rng });
    assert.strictEqual(p.pioche.length, avant);
  }

  // ── Pioche : coûte 1 Élixir, refusée sans Élixir ni dette ──
  {
    const p = partieTest({ a: [] }, ["gobelin", "moine", "fut"]);
    p.joueurs.a.elixir = 1;
    assert.strictEqual(piocher(p, "a").carte, "gobelin");
    assert.strictEqual(p.joueurs.a.elixir, 0);
    assert.strictEqual(piocher(p, "a").erreur, "elixir");
    p.joueurs.a.dette = 1;
    assert.strictEqual(piocher(p, "a").carte, "moine");
    assert.strictEqual(p.joueurs.a.dette, 0);
  }

  // ── Gobelin explosif : Esprit sacrifié puis bombe cachée, sinon élimination ──
  {
    const p = partieTest({ a: ["esprit"], b: [], c: ["gobelin"] }, ["bombe", "gang", "voleuse", "bombe"]);
    const r = piocher(p, "a");
    assert.strictEqual(r.bang, "sauve");
    assert.ok(p.joueurs.a.enAttente && !p.joueurs.a.main.includes("esprit"));
    assert.strictEqual(piocher(p, "a").erreur, "enAttente");
    placer(p, "a", "1");
    assert.deepStrictEqual(p.pioche, ["bombe", "gang", "voleuse", "bombe"]);
    assert.strictEqual(piocher(p, "b").bang, "elimine");
    assert.ok(!p.joueurs.b.vivant && p.joueurs.b.rangElimination === 1);
    assert.strictEqual(nbBombes(p), 1, "la bombe de l'éliminé quitte le jeu");
    assert.ok(p.journal.at(-1).c && p.journal.at(-1).j === 1, "explosion : entrée cruciale du jour 1");
    assert.ok(!p.journal[0].c, "Gobelin désamorcé : entrée non cruciale");
    assert.ok(!p.termine);
    p.joueurs.c.elixir = 4;
    piocher(p, "c");
    piocher(p, "c");
    assert.strictEqual(piocher(p, "c").bang, "elimine");
    assert.ok(p.termine, "dernier Roi debout");
    assert.strictEqual(piocher(p, "a").erreur, "termine");
  }

  // ── Placement : positions ──
  {
    const p = partieTest({ a: [] }, ["x", "y", "z", "w"]);
    for (const [pos, attendu] of [["3", 2], ["milieu", 2], ["fond", 4]]) {
      const q = structuredClone(p);
      q.joueurs.a.enAttente = true;
      assert.strictEqual(placer(q, "a", pos).index, attendu);
      assert.strictEqual(q.pioche[attendu], "bombe");
    }
  }

  // ── Malédiction : la prochaine carte piochée devient un Gobelin ──
  {
    const p = partieTest({ a: ["malediction"], b: [] }, ["voleuse", "fut"]);
    jouer(p, "a", "malediction", "b", { config: CONFIG, rng });
    const r = piocher(p, "b");
    assert.strictEqual(r.carte, "gobelin");
    assert.strictEqual(r.transformee, "voleuse");
    assert.strictEqual(piocher(p, "b").carte, "fut");
  }

  // ── Gang : 2 pioches dues ; Fût : annule une pioche due ──
  {
    const p = partieTest({ a: ["gang"], b: ["fut"] });
    jouer(p, "a", "gang", "b", { config: CONFIG, rng });
    assert.strictEqual(p.joueurs.b.dette, CONFIG.gang_pioches);
    jouer(p, "b", "fut", "pioche", { config: CONFIG, rng });
    assert.strictEqual(p.joueurs.b.dette, CONFIG.gang_pioches - 1);
    assert.strictEqual(p.joueurs.b.elixir, 3);
  }

  // ── Gang : un seul clic pioche les cartes dues, arrêt sur un Gobelin explosif ──
  {
    const p = partieTest({ a: ["esprit"] }, ["gobelin", "fut", "voleuse", "bombe", "moine"]);
    p.joueurs.a.dette = 2;
    p.joueurs.a.elixir = 1;
    assert.deepStrictEqual(piocherClic(p, "a").tirages.map((r) => r.carte), ["gobelin", "fut"]);
    assert.strictEqual(p.joueurs.a.elixir, 0, "1 Élixir payé, la 2e pioche due est gratuite");
    assert.strictEqual(piocherClic(p, "a").erreur, "elixir", "plus de dette : un clic normal coûte 1 Élixir");
    p.joueurs.a.dette = 3;
    const r = piocherClic(p, "a");
    assert.deepStrictEqual(r.tirages.map((t) => t.carte), ["voleuse", "bombe"]);
    assert.ok(p.joueurs.a.enAttente && p.joueurs.a.dette === 1, "arrêt sur la bombe, une pioche encore due");
  }

  // ── Moine : renvoie l'attaque à l'envoyeur, une seule fois, en secret ──
  {
    const p = partieTest({ thomas: ["voleuse", "voleuse", "esprit"], pierre: ["moine", "gobelin"] });
    jouer(p, "pierre", "moine", null, { config: CONFIG, rng });
    assert.ok(p.joueurs.pierre.moine);
    assert.ok(p.journal.every((e) => e.p === "pierre"), "Moine : seulement une note privée pour son joueur");
    const r = jouer(p, "thomas", "voleuse", "pierre", { config: CONFIG, rng });
    assert.ok(r.renvoi);
    assert.strictEqual(p.joueurs.thomas.main.length, 1, "Pierre a volé une carte à Thomas");
    assert.strictEqual(p.joueurs.pierre.main.length, 2);
    assert.ok(!p.joueurs.pierre.moine);
    assert.ok(!jouer(p, "thomas", "voleuse", "pierre", { config: CONFIG, rng }).renvoi);
    assert.strictEqual(p.jour.attaques, 2);
    // Journal rédigé selon le lecteur : « tu » quand l'action le concerne
    const renvoi = p.journal.find((e) => e.k === "renvoi");
    assert.match(texteJournal(p, renvoi, "pierre"), /^🙏 Ton Moine renvoie l'attaque \(Voleuse\) de \*\*thomas\*\*/);
    assert.match(texteJournal(p, renvoi, "thomas"), /renvoie ton attaque \(Voleuse\) contre toi/);
    assert.match(texteJournal(p, renvoi), /^🙏 Le Moine de \*\*pierre\*\* renvoie l'attaque \(Voleuse\) de \*\*thomas\*\*/);
    const vole = p.journal.find((e) => e.k === "voleuse");
    assert.strictEqual(texteJournal(p, vole, vole.s), `🦹 Ta Voleuse dérobe une carte à **${vole.v}** !`);
    assert.strictEqual(texteJournal(p, vole, vole.v), `🦹 La Voleuse de **${vole.s}** te dérobe une carte !`);
    const vol = p.journal.filter((e) => e.p === "thomas" && e.t.includes("t'a volé"));
    assert.strictEqual(vol.length, 1, "la victime du renvoi apprend quelle carte lui a été volée");
    assert.ok(p.journal.some((e) => e.ids?.includes("pierre") && e.ids.includes("thomas")), "événement public lié aux deux joueurs");
    assert.strictEqual(p.jour.renvois, 1);
    assert.strictEqual(p.joueurs.thomas.main.length, 1);
  }

  // ── Cibles et cartes invalides ──
  {
    const p = partieTest({ a: ["gang", "esprit", "moine"], b: [] });
    assert.strictEqual(jouer(p, "a", "gang", "a", { config: CONFIG, rng }).erreur, "cible");
    assert.strictEqual(jouer(p, "a", "esprit", null, { config: CONFIG, rng }).erreur, "injouable");
    assert.strictEqual(jouer(p, "a", "voleuse", "b", { config: CONFIG, rng }).erreur, "pasEnMain");
    jouer(p, "a", "moine", null, { config: CONFIG, rng });
    p.joueurs.a.main.push("moine");
    assert.strictEqual(jouer(p, "a", "moine", null, { config: CONFIG, rng }).erreur, "moineActif");
  }

  // ── Sarbacane : révèle les 3 premières cartes ──
  {
    const p = partieTest({ a: ["sarbacane"] }, ["gobelin", "bombe", "esprit", "fut"]);
    assert.deepStrictEqual(jouer(p, "a", "sarbacane", null, { config: CONFIG, rng }).revelation, ["gobelin", "bombe", "esprit"]);
  }

  // ── Clôture : pioche automatique, dettes soldées, Élixir plafonné ──
  {
    const p = partieTest({ a: [], b: [], c: ["esprit"] }, ["gobelin", "moine", "fut", "gang", "voleuse", "bombe"]);
    p.joueurs.a.tourFait = true;
    p.joueurs.a.elixir = 4;
    p.joueurs.b.dette = 2;
    p.joueurs.c.elixir = 0;
    p.joueurs.a.moine = true;
    cloturer(p, { config: CONFIG, rng });
    assert.ok(!p.joueurs.a.moine, "le Moine ne protège que le jour où il est joué");
    assert.strictEqual(p.joueurs.a.main.length, 0, "a avait déjà pioché");
    assert.strictEqual(p.joueurs.a.elixir, CONFIG.elixir.max);
    assert.strictEqual(p.joueurs.b.main.length, 2);
    assert.strictEqual(p.joueurs.c.main.length, 2, "pioche auto même sans Élixir");
    assert.strictEqual(p.joueurs.c.elixir, CONFIG.elixir.par_jour);
    assert.ok(vivants(p).every(([, j]) => !j.tourFait && j.dette === 0));
    assert.strictEqual(p.veille.automatiques.length, 2, "bilan de la veille : b et c ont pioché automatiquement");
    assert.deepStrictEqual(p.jour.explosions, []);
    assert.strictEqual(p.numeroJour, 2);
  }

  // ── Clôture du dernier jour : pas d'Élixir distribué ──
  {
    const p = partieTest({ a: [] }, ["gobelin"]);
    p.joueurs.a.tourFait = true;
    cloturer(p, { config: CONFIG, rng, dernier: true });
    assert.strictEqual(p.joueurs.a.elixir, 2);
  }

  // ── Clôture : bombe en attente cachée au hasard ──
  {
    const p = partieTest({ a: [] }, ["gobelin"]);
    p.joueurs.a.enAttente = true;
    p.joueurs.a.tourFait = true;
    cloturer(p, { config: CONFIG, rng });
    assert.strictEqual(nbBombes(p), 1);
    assert.ok(!p.joueurs.a.enAttente);
  }

  // ── Secousse : à l'ouverture du J6, cartes ordinaires retirées jusqu'à 1/3 de bombes ──
  {
    const p = partieTest({ a: [] }, [...Array(20).fill("gobelin"), "bombe", "bombe"]);
    p.joueurs.a.tourFait = true;
    p.numeroJour = 5;
    const config = { ...CONFIG, secousses: [{ jour: 6, proportion: 0.5 }] };
    cloturer(p, { config, rng });
    assert.strictEqual(p.pioche.length, 4);
    assert.strictEqual(nbBombes(p), 2, "les Gobelins explosifs restent");
    const e = p.journal.find((x) => x.k === "secousse");
    assert.ok(e.c && e.j === 6 && e.retirees === 18);
    assert.match(texteJournal(p, e), /^🌋 \*\*L'Arène tremble !\*\* 18 cartes disparaissent/);
    // Proportion déjà atteinte : rien ne bouge
    p.numeroJour = 5;
    p.joueurs.a.tourFait = true;
    const avant = p.pioche.length;
    cloturer(p, { config, rng });
    assert.ok(p.pioche.length <= avant);
  }

  // ── Classement : survivants (Élixir, Esprits, cartes), puis éliminés du dernier au premier ──
  {
    const p = partieTest({ a: ["gobelin", "gobelin"], b: ["esprit"], c: [], d: [], e: [] });
    p.joueurs.e.elixir = 3;
    Object.assign(p.joueurs.e, { vivant: false, rangElimination: 3 });
    p.joueurs.a.elixir = 1;
    p.joueurs.b.elixir = 1;
    Object.assign(p.joueurs.c, { vivant: false, rangElimination: 1 });
    Object.assign(p.joueurs.d, { vivant: false, rangElimination: 2 });
    const r = classement(p);
    assert.deepStrictEqual(r.map((x) => x.discordId), ["b", "a", "e", "d", "c"]);
    assert.deepStrictEqual(r.map((x) => x.score), [4, 3, 2, 1, 0]);
    p.joueurs.a.elixir = 2;
    assert.strictEqual(classement(p)[0].discordId, "a", "l'Élixir prime");
  }

  console.log("bangRules.test.js : OK");
}

main();
