import assert from "assert";
import { BOSS_PUNTO } from "./bossPunto.js";
import { casesJouables } from "./puntoRules.js";
import { rngBossDe } from "./bossRng.js";

// Réglages de Kévina du mode normal (duel.json) chargés une fois
const config = await BOSS_PUNTO.chargerConfig();

// Joue une partie complète : le joueur pose sur une case tirée de `rngJoueur`
// (déterministe) parmi les cases permises. Renvoie l'état et les états
// successifs (copies JSON).
function partie(graine, rngJoueur) {
  const d = BOSS_PUNTO.creer({ graine, config });
  const etats = [JSON.stringify(d)];
  let tours = 0;
  while (!d.termine) {
    assert.strictEqual(d.actif, "joueur");
    const cases = casesJouables(d.grille, d.carte);
    const i = cases[Math.floor(rngJoueur() * cases.length)];
    const r = BOSS_PUNTO.jouer(d, { case: i, coup: d.coups }, { graine, config });
    assert.ok(!r.erreur, r.message);
    assert.ok(r.texte);
    if (!d.termine) assert.strictEqual(d.actif, "joueur");
    etats.push(JSON.stringify(d));
    assert.ok(++tours <= 72);
  }
  return { d, etats };
}

function main() {
  // ── Même graine + mêmes actions = mêmes états ──
  {
    const a = partie("graineA", rngBossDe("joueur", 1));
    const b = partie("graineA", rngBossDe("joueur", 1));
    assert.deepStrictEqual(a.etats, b.etats);
    assert.strictEqual(BOSS_PUNTO.score(a.d), BOSS_PUNTO.score(b.d));
  }

  // ── Graines différentes = donnes différentes ──
  {
    const a = BOSS_PUNTO.creer({ graine: "graineA", config });
    const b = BOSS_PUNTO.creer({ graine: "graineB", config });
    assert.notDeepStrictEqual(
      [a.carte, a.pioches.joueur, a.pioches.bot],
      [b.carte, b.pioches.joueur, b.pioches.bot],
    );
    assert.strictEqual(a.actif, "joueur");
    assert.strictEqual(a.pioches.joueur.length + 1, 36);
    assert.strictEqual(a.pioches.bot.length, 36);
  }

  // ── Erreurs : case interdite, vue dépassée, partie finie ──
  {
    const d = BOSS_PUNTO.creer({ graine: "graineC", config });
    const avant = JSON.stringify(d);
    assert.strictEqual(BOSS_PUNTO.jouer(d, { case: 0, coup: 0 }, { graine: "graineC", config }).erreur, "interdite");
    assert.strictEqual(BOSS_PUNTO.jouer(d, { case: 12, coup: 3 }, { graine: "graineC", config }).erreur, "perime");
    assert.strictEqual(JSON.stringify(d), avant);
    const r = BOSS_PUNTO.jouer(d, { case: 12, coup: 0 }, { graine: "graineC", config });
    assert.ok(!r.erreur && r.avantKevina && r.texteKevina);
    assert.strictEqual(r.avantKevina.actif, "bot");
    const { d: fini } = partie("graineC", rngBossDe("joueur", 2));
    assert.strictEqual(BOSS_PUNTO.jouer(fini, { case: 12, coup: fini.coups }, { graine: "graineC", config }).erreur, "termine");
  }

  // ── Parties complètes : scores dans leur tranche ──
  const vus = { victoire: [], nul: [], defaite: [] };
  for (let n = 0; n < 150; n++) {
    const { d } = partie(`g${n}`, rngBossDe("joueur", n));
    const res = BOSS_PUNTO.resultat(d);
    const s = BOSS_PUNTO.score(d);
    vus[res].push(s);
    if (res === "victoire") assert.ok(s >= 100);
    else if (res === "nul") assert.ok(s >= 50 && s <= 99);
    else assert.ok(s >= 0 && s < 50);
    assert.ok(BOSS_PUNTO.score(d, { inactif: true }) < 50);
  }
  assert.ok(vus.defaite.length > 0 && vus.victoire.length > 0);

  // ── Ordre des scores : victoire > nul > défaite (états construits) ──
  {
    const base = BOSS_PUNTO.creer({ graine: "ordre", config });
    const victoireLente = { ...base, termine: true, gagnant: "joueur", coups: 71 };
    const victoireRapide = { ...base, termine: true, gagnant: "joueur", coups: 7 };
    const nul = { ...base, termine: true, gagnant: "nul", coups: 72, grille: base.grille.map(() => ({ s: "joueur", k: 0, v: 9 })) };
    const defaiteLongue = { ...base, termine: true, gagnant: "bot", coups: 72, grille: base.grille.map(() => ({ s: "joueur", k: 0, v: 9 })) };
    const defaiteCourte = { ...base, termine: true, gagnant: "bot", coups: 8 };
    const score = (d) => BOSS_PUNTO.score(d);
    assert.ok(score(victoireRapide) > score(victoireLente));
    assert.ok(score(victoireLente) >= 100);
    assert.ok(score(nul) >= 50 && score(nul) <= 99 && score(nul) < score(victoireLente));
    assert.ok(score(defaiteLongue) < 50 && score(defaiteLongue) > score(defaiteCourte));
    // Inactivité : jamais plus de 49, même sur une partie gagnée
    assert.ok(BOSS_PUNTO.score(victoireRapide, { inactif: true }) < 50);
    assert.ok(BOSS_PUNTO.score(base, { inactif: true }) < 50);
  }

  console.log(`bossPunto : OK (${vus.victoire.length} victoires, ${vus.nul.length} nuls, ${vus.defaite.length} défaites)`);
}

main();
