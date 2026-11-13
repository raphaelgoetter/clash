import assert from "assert";
import { BOSS_GRILLE } from "./bossGrille.js";
import { colonnesLibres, scoreGrille } from "./grilleRules.js";

const config = {};

// Joue une partie complète : `strategie(d, i)` choisit la colonne du joueur.
function partie(graine, strategie) {
  const d = BOSS_GRILLE.creer({ graine, config });
  const etats = [structuredClone(d)];
  const des = [d.de];
  for (let i = 0; !d.termine; i++) {
    const r = BOSS_GRILLE.jouer(d, { colonne: strategie(d, i) }, { graine, config });
    assert.ok(!r.erreur, r.message);
    assert.ok(r.texte.startsWith("Tu poses"));
    if (!d.termine || r.avantKevina) assert.ok(r.texteKevina.startsWith("Kévina pose"));
    if (r.avantKevina) des.push(r.avantKevina.de);
    if (d.de) des.push(d.de);
    etats.push(structuredClone(d));
  }
  return { d, etats, des };
}

const premiereLibre = (d) => colonnesLibres(d.grilles.joueur)[0];
const derniereLibre = (d) => colonnesLibres(d.grilles.joueur).at(-1);

function main() {
  // ── Même graine + mêmes actions = mêmes états ──
  const a = partie("abc", premiereLibre);
  const b = partie("abc", premiereLibre);
  assert.deepStrictEqual(a.etats, b.etats);
  assert.ok(a.d.termine && ["joueur", "bot", "nul"].includes(a.d.gagnant));
  assert.strictEqual(a.d.actif === "joueur" || a.d.termine, true);

  // ── Dés indépendants du déroulé : le n-ième dé est le même pour tous ──
  const c = partie("abc", derniereLibre);
  const n = Math.min(a.des.length, c.des.length);
  assert.deepStrictEqual(a.des.slice(0, n), c.des.slice(0, n));

  // ── Graines différentes = dés différents ──
  const autre = partie("xyz", premiereLibre);
  assert.notDeepStrictEqual(a.des.slice(0, 6), autre.des.slice(0, 6));

  // ── Erreurs : colonne pleine, colonne inconnue, partie finie ──
  {
    const d = BOSS_GRILLE.creer({ graine: "err", config });
    for (let i = 0; i < 3; i++) BOSS_GRILLE.jouer(d, { colonne: 0 }, { graine: "err", config });
    // La colonne 0 peut avoir perdu des dés (destructions) : on la remplit
    while (d.grilles.joueur[0].length < 3 && !d.termine) BOSS_GRILLE.jouer(d, { colonne: 0 }, { graine: "err", config });
    if (!d.termine) {
      const avant = structuredClone(d);
      assert.strictEqual(BOSS_GRILLE.jouer(d, { colonne: 0 }, { graine: "err", config }).erreur, "pleine");
      assert.strictEqual(BOSS_GRILLE.jouer(d, { colonne: NaN }, { graine: "err", config }).erreur, "impossible");
      assert.deepStrictEqual(d, avant);
    }
    assert.strictEqual(BOSS_GRILLE.jouer(a.d, { colonne: 0 }, { graine: "abc", config }).erreur, "termine");
  }

  // ── Scores : victoire > nul > défaite > inactivité ──
  const fin = (joueur, bot, dernier = "joueur") => {
    const d = BOSS_GRILLE.creer({ graine: "s", config });
    d.grilles.joueur = joueur;
    d.grilles.bot = bot;
    d.termine = true;
    d.coups = 17;
    d.dernier = { id: dernier };
    const s = { j: scoreGrille(joueur), b: scoreGrille(bot) };
    d.gagnant = s.j === s.b ? "nul" : s.j > s.b ? "joueur" : "bot";
    return d;
  };
  const plein = (v) => [[v, v, v], [v, v, v], [v, v, v]];
  const victoire = fin(plein(6), [[1], [], []]);
  const petiteVictoire = fin(plein(2), [[5], [5], [5, 1, 3]]);
  const nul = fin(plein(3), plein(3));
  const petitNul = fin(plein(1), plein(1));
  const defaiteSerree = fin([[5], [5], [5, 1, 3]], plein(2), "bot");
  const lourdeDefaite = fin([[1], [], []], plein(6), "bot");
  const sc = (d, o) => BOSS_GRILLE.score(d, o);
  assert.strictEqual(BOSS_GRILLE.resultat(victoire), "victoire");
  assert.strictEqual(BOSS_GRILLE.resultat(nul), "nul");
  assert.strictEqual(BOSS_GRILLE.resultat(lourdeDefaite), "defaite");
  assert.ok(sc(victoire) > sc(petiteVictoire) && sc(petiteVictoire) >= 100);
  assert.ok(sc(nul) > sc(petitNul) && sc(nul) <= 99 && sc(petitNul) >= 50);
  assert.ok(sc(defaiteSerree) > sc(lourdeDefaite) && sc(defaiteSerree) <= 49 && sc(lourdeDefaite) >= 25);
  // Inactivité : partie en cours, sous toute défaite jouée, < 50
  const enCours = BOSS_GRILLE.creer({ graine: "s", config });
  BOSS_GRILLE.jouer(enCours, { colonne: 1 }, { graine: "s", config });
  assert.ok(sc(enCours, { inactif: true }) < sc(lourdeDefaite));
  assert.ok(sc(victoire, { inactif: true }) < 50);
  assert.ok(sc(a.d) >= 0);

  console.log("bossGrille OK");
}

main();
