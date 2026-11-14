import assert from "assert";
import { Redis } from "@upstash/redis";
import {
  BOSS_JEUX,
  championsBoss,
  jeuDeSaison,
  classer,
  clotureDe,
  cloturerBoss,
  demarrer,
  INACTIVITE_MS,
  jouer,
  lireJeu,
  ouvrirBoss,
  rngBoss,
  statutJoueur,
} from "./boss.js";
import { BOSS_QUATRE } from "./bossQuatre.js";
import { lireCompteurs, noterManche, noterVictoireDuel } from "./passeport.js";

// ── Hasard commun : même graine et même étape = même suite ──
const tirage = (g, e) => Array.from({ length: 3 }, rngBoss(g, e));
assert.deepStrictEqual(tirage("abc", 4), tirage("abc", 4));
assert.notDeepStrictEqual(tirage("abc", 4), tirage("abc", 5));
assert.ok(tirage("abc", 4).every((x) => x >= 0 && x < 1));

// ── jeuDeSaison : roulement dans l'ordre de BOSS_JEUX ──
const ordre = Object.keys(BOSS_JEUX);
assert.deepStrictEqual(ordre.map((_, i) => jeuDeSaison(138 + i)), ordre);
assert.strictEqual(jeuDeSaison(138 + ordre.length), ordre[0]);

// ── clotureDe : le 8 du mois suivant à minuit, heure de Paris ──
assert.strictEqual(clotureDe(138).toISOString(), "2026-12-07T23:00:00.000Z");

// ── Score de Quatre : victoire rapide > victoire lente > nul > défaite longue ──
const fin = (gagnant, coups) => ({ gagnant, coups, termine: true });
assert.ok(BOSS_QUATRE.score(fin("joueur", 7)) > BOSS_QUATRE.score(fin("joueur", 30)));
assert.ok(BOSS_QUATRE.score(fin("joueur", 41)) > BOSS_QUATRE.score(fin("nul", 42)));
assert.ok(BOSS_QUATRE.score(fin("nul", 42)) > BOSS_QUATRE.score(fin("bot", 40)));
assert.ok(BOSS_QUATRE.score(fin("bot", 30)) > BOSS_QUATRE.score(fin("bot", 10)));
assert.strictEqual(BOSS_QUATRE.score(fin("joueur", 9), { inactif: true }), 9);

// ── classer : score décroissant, puis la plus courte ; rangs partagés ──
const t = (score, minutes) => ({
  statut: "fini",
  score,
  debutAt: "2026-12-01T10:00:00Z",
  finAt: new Date(Date.parse("2026-12-01T10:00:00Z") + minutes * 60_000).toISOString(),
});
const c = classer([t(40, 5), t(120, 9), t(120, 3), { statut: "enCours" }, t(40, 5)]);
assert.deepStrictEqual(c.map((x) => [x.score, x.rang]), [[120, 1], [120, 1], [40, 3], [40, 3]]);
assert.strictEqual(c[0].duree, 3 * 60_000);

// ── Déroulé complet (Redis en mémoire) ──
if (Redis.isFake) {
  const novembre = new Date("2026-12-20T12:00:00Z"); // saison 139 (objectifs complets)
  const ouverture = new Date("2027-01-01T09:00:00Z");

  // Passeport complet de novembre pour "1" et "2" (aucun jeu spécial dans
  // le mois : tampon validé d'office), incomplet pour "3"
  for (const id of ["1", "2"]) {
    for (let i = 0; i < 10; i++) await noterManche(id, ["frame", "concept", "zoom2", "trivia"][i % 4], `m${i}`, novembre);
    await noterVictoireDuel(id, "punto", "pvp", novembre); // quête de décembre
    await noterVictoireDuel(id, "frise", "bot", novembre);
    await noterVictoireDuel(id, "quatre", "bot", novembre);
  }
  await noterManche("3", "frame", "m0", novembre);

  await assert.rejects(ouvrirBoss(139, { now: novembre })); // saison pas finie
  await assert.rejects(ouvrirBoss(137, { now: ouverture })); // avant le passeport, pas de Boss
  const ouvert = await ouvrirBoss(139, { now: ouverture, rng: () => 0.5 });
  const { deja } = ouvert;
  // Déroulé testé sur Quatre à la suite (chaque duel a ses propres tests boss<Jeu>.test.js)
  const boss = { ...ouvert.boss, jeu: "quatre" };
  assert.strictEqual(deja, false);
  assert.strictEqual(ouvert.boss.jeu, jeuDeSaison(139));
  assert.deepStrictEqual([...boss.qualifies].sort(), ["1", "2"]);
  assert.strictEqual((await ouvrirBoss(139, { now: ouverture })).boss.graine, boss.graine);

  assert.strictEqual(statutJoueur(boss, null, "3", ouverture), "nonQualifie");
  assert.strictEqual(statutJoueur(boss, null, "1", new Date("2027-01-08T10:00:00Z")), "ferme");
  assert.strictEqual((await demarrer(boss, "3", "trois", { now: ouverture })).erreur, "nonQualifie");

  // Une seule tentative
  assert.ok((await demarrer(boss, "1", "un", { now: ouverture })).etat);
  assert.strictEqual((await demarrer(boss, "1", "un", { now: ouverture })).erreur, "dejaJoue");
  assert.ok((await demarrer(boss, "2", "deux", { now: ouverture })).etat);

  // Même donne : mêmes coups du joueur, mêmes réponses de Kévina
  const colonnesKevina = async (id) => {
    const coups = [];
    for (const colonne of [3, 3, 2]) {
      const r = await jouer(boss, id, { colonne }, { now: ouverture });
      coups.push(r.resultat.coupKevina?.colonne);
    }
    return coups;
  };
  assert.deepStrictEqual(await colonnesKevina("1"), await colonnesKevina("2"));

  // Joueur 1 joue jusqu'au bout (première colonne libre à chaque coup)
  let r;
  do {
    const { etat } = await lireJeu(boss, "1", { now: ouverture });
    const colonne = etat.colonnes.findIndex((col) => col.length < 6);
    r = await jouer(boss, "1", { colonne }, { now: ouverture });
  } while (r.tentative.statut !== "fini");
  assert.strictEqual(r.tentative.score, BOSS_QUATRE.score(r.etat));
  assert.strictEqual((await jouer(boss, "1", { colonne: 0 }, { now: ouverture })).resultat.erreur, "termine");

  // Joueur 2 inactif plus d'une heure : partie perdue avec le score atteint
  const tard = new Date(ouverture.getTime() + INACTIVITE_MS + 1000);
  const j2 = await lireJeu(boss, "2", { now: tard });
  assert.strictEqual(j2.tentative.statut, "fini");
  assert.strictEqual(j2.tentative.inactif, true);
  assert.strictEqual(j2.tentative.resultat, "defaite");

  // Clôture : compteurs permanents, une seule fois
  const cloture = new Date("2027-01-08T08:00:00Z");
  const res = await cloturerBoss(139, { now: cloture });
  assert.strictEqual(res.deja, false);
  assert.strictEqual(res.classement.length, 2);
  assert.strictEqual(res.boss.cloture, true);
  assert.strictEqual((await cloturerBoss(139, { now: cloture })).deja, true);
  const c1 = await lireCompteurs("1");
  assert.strictEqual(c1.passeports, 1);
  assert.strictEqual(c1.boss, r.tentative.resultat === "victoire" ? 1 : 0);
  assert.deepStrictEqual(await lireCompteurs("2"), { passeports: 1, boss: 0 });
  assert.deepStrictEqual(await lireCompteurs("3"), { passeports: 0, boss: 0 });

  // Historique : champion(s) seulement si Kévina est vaincue, rien avant la clôture
  const champions = await championsBoss(139);
  assert.deepStrictEqual(champions.champions, r.tentative.resultat === "victoire" ? ["un"] : []);
  assert.strictEqual(await championsBoss(140), null);
}

console.log("boss.test.js OK");
