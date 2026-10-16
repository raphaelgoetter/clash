import assert from "assert";
import fs from "fs";
import {
  BANDES,
  PIECES,
  VOISINS,
  COINS,
  PANIERS,
  ERRANTS,
  parisParts,
  parisInstant,
  evenementsEntre,
  jourDe,
  creerPartie,
  inscrire,
  desinscrire,
  demarrer,
  tailles,
  rattraper,
  appeler,
  squatsPossibles,
  lancerSquat,
  jouerManche,
  jusquauBout,
  retraite,
  pVictoire,
  totalBande,
  classementBandes,
  classementCaid,
  texteJournal,
  posterMessage,
  messagesBande,
  messagesRestants,
  nouveauxMessages,
  marquerLus,
  estPnj,
  deplacer,
  deplacementsPossibles,
} from "./meowRules.js";

const CONFIG = JSON.parse(fs.readFileSync(new URL("../../data/meow/meow.json", import.meta.url), "utf8"));

// Générateur déterministe
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// Dés imposés : chaque valeur v donne un dé de v (1-6)
function des(...valeurs) {
  let i = 0;
  return () => (valeurs[i++ % valeurs.length] - 1) / 6 + 0.01;
}

// Lundi 19/10/2026 9h30 à Paris (heure d'été, UTC+2)
const LANCEMENT = parisInstant("2026-10-19", 9) + 30 * 60_000;

function partieDe(n, { now = LANCEMENT, seed = 1 } = {}) {
  const partie = creerPartie();
  for (let i = 0; i < n; i++) inscrire(partie, `j${i}`, `Joueur ${i}`, { config: CONFIG });
  demarrer(partie, { config: CONFIG, now, rng: seeded(seed) });
  return partie;
}

function joueurDe(partie, b) {
  return Object.keys(partie.joueurs).find((id) => partie.joueurs[id].bande === b);
}

// ── Carte ─────────────────────────────────────────────────────────────

{
  assert.strictEqual(COINS.length, 20);
  // Symétrie : chaque pièce de départ a 2 sorties sur 2 coins distincts,
  // une vers le Salon, une vers le Grenier, et ne touche aucune autre pièce de départ
  for (const bd of BANDES) {
    const sorties = PIECES[bd.depart].coins.flatMap((c) => VOISINS[c].filter((v) => !PIECES[bd.depart].coins.includes(v)).map((v) => [c, v]));
    assert.strictEqual(sorties.length, 2, bd.depart);
    assert.notStrictEqual(sorties[0][0], sorties[1][0], `${bd.depart} : sorties sur deux coins distincts`);
    const pieces = sorties.map(([, v]) => Object.keys(PIECES).find((p) => PIECES[p].coins.includes(v))).sort();
    assert.deepStrictEqual(pieces, ["grenier", "salon"], bd.depart);
    assert.ok(!PIECES[bd.depart].coins.flatMap((c) => VOISINS[c]).includes(bd.panier) || PIECES[bd.depart].coins.includes(bd.panier));
  }
  // Paniers hors passages
  for (const p of PANIERS) assert.ok(VOISINS[p].every((v) => PIECES[Object.keys(PIECES).find((x) => PIECES[x].coins.includes(p))].coins.includes(v)), p);
}

// ── Heure de Paris ────────────────────────────────────────────────────

{
  // Heure d'été (UTC+2) puis heure d'hiver (UTC+1, après le 25/10/2026)
  assert.strictEqual(new Date(parisInstant("2026-10-19", 8)).toISOString(), "2026-10-19T06:00:00.000Z");
  assert.strictEqual(new Date(parisInstant("2026-10-26", 8)).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.deepStrictEqual(parisParts(parisInstant("2026-10-25", 23)), { date: "2026-10-25", h: 23, min: 0 });
  // Événements d'une journée complète, dans l'ordre
  const ev = evenementsEntre(parisInstant("2026-10-19", 9), parisInstant("2026-10-20", 9), CONFIG);
  assert.deepStrictEqual(
    ev.map((e) => `${e.date} ${parisParts(e.t).h} ${e.type}`),
    ["2026-10-19 13 distribution", "2026-10-19 18 distribution", "2026-10-19 23 decompte", "2026-10-20 0 sieste", "2026-10-20 8 distribution"],
  );
}

// ── Inscription et lancement ──────────────────────────────────────────

{
  const partie = creerPartie();
  for (let i = 0; i < CONFIG.effectif_max; i++) assert.ok(inscrire(partie, `j${i}`, `J${i}`, { config: CONFIG }).ok);
  assert.strictEqual(inscrire(partie, "x", "X", { config: CONFIG }).erreur, "complet");
  assert.ok(desinscrire(partie, "j0").ok);
  assert.strictEqual(desinscrire(partie, "j0").erreur, "pasInscrit");
}

{
  const partie = partieDe(13);
  const t = tailles(partie).sort();
  assert.deepStrictEqual(t, [4, 4, 5], "bandes équilibrées à un joueur près");
  for (const bd of BANDES) {
    const b = BANDES.indexOf(bd);
    for (const c of PIECES[bd.depart].coins) assert.strictEqual(partie.coins[c].b, b);
  }
  for (const c of [...PIECES.salon.coins, ...PIECES.grenier.coins]) assert.deepStrictEqual(partie.coins[c], { b: ERRANTS, n: CONFIG.chats_errants });
  // Première distribution immédiate : 1 chat chacun (2 pour une part des
  // bandes de 4 : recharge équilibrée), croquettes de la pièce de départ
  for (const j of Object.values(partie.joueurs)) assert.ok(j.stock >= 1 && j.stock <= 2);
  for (let b = 0; b < 3; b++) assert.strictEqual(totalBande(partie, b, CONFIG), 4 + CONFIG.points_piece);
  assert.strictEqual(partie.jourDebut, "2026-10-19");
}

// ── Répartition : les derniers inscrits complètent les bandes ─────────

for (const [n, attendu] of [[14, [4, 5, 5]], [13, [4, 4, 5]], [12, [4, 4, 4]], [20, [6, 7, 7]]]) {
  for (let seed = 1; seed <= 20; seed++) {
    const partie = partieDe(n, { seed });
    const t = tailles(partie);
    assert.deepStrictEqual([...t].sort(), attendu, `${n} joueurs`);
    const derniers = Object.keys(partie.joueurs).sort((a, b) => partie.joueurs[a].arrivee - partie.joueurs[b].arrivee).slice(n - (n % 3));
    const bandes = derniers.map((id) => partie.joueurs[id].bande);
    assert.strictEqual(new Set(bandes).size, bandes.length, "derniers inscrits dans des bandes différentes");
    for (const b of bandes) assert.strictEqual(t[b], Math.max(...t), "derniers inscrits dans les bandes les plus nombreuses");
  }
}

{
  // Numéro d'arrivée unique même après une désinscription
  const partie = creerPartie();
  for (const id of ["a", "b", "c"]) inscrire(partie, id, id, { config: CONFIG });
  desinscrire(partie, "a");
  inscrire(partie, "d", "d", { config: CONFIG });
  assert.ok(partie.joueurs.d.arrivee > partie.joueurs.c.arrivee);
}

// ── Recharge équilibrée ───────────────────────────────────────────────

{
  // 13 joueurs (5/4/4) : sur 7 jours, chaque bande reçoit autant de chats à un chat près
  const partie = partieDe(13);
  const recus = [0, 0, 0];
  const avant = Object.fromEntries(Object.entries(partie.joueurs).map(([id, j]) => [id, j.stock]));
  for (const [id, j] of Object.entries(partie.joueurs)) recus[j.bande] += avant[id];
  let t = LANCEMENT;
  for (let k = 0; k < 20; k++) {
    for (const j of Object.values(partie.joueurs)) j.stock = 0;
    const suivant = evenementsEntre(t, t + 7 * 86_400_000, CONFIG).find((e) => e.type === "distribution");
    rattraper(partie, { config: CONFIG, now: suivant.t });
    for (const j of Object.values(partie.joueurs)) recus[j.bande] += j.stock;
    t = suivant.t;
    if (partie.termine) break;
  }
  assert.ok(Math.max(...recus) - Math.min(...recus) <= 2, `recharge équilibrée : ${recus}`);
}

// ── Stock plafonné, squats remis à zéro ───────────────────────────────

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.joueurs[id].squats = 2;
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-20", 19) });
  // 13h, 18h, (sieste : stock posé), 8h, 13h, 18h → 3 en stock, plafond 4
  assert.strictEqual(partie.joueurs[id].stock, 3);
  assert.strictEqual(partie.joueurs[id].squats, 0);
  assert.ok(partie.journal.some((e) => e.k === "sieste"));
}

// ── Appeler ───────────────────────────────────────────────────────────

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.joueurs[id].stock = 3;
  assert.strictEqual(appeler(partie, id, "malle", 1).erreur, "pasTonCoin");
  assert.deepStrictEqual(appeler(partie, id, "carton", 2, { now: LANCEMENT }), { ok: true, n: 2 });
  assert.strictEqual(partie.coins.carton.n, CONFIG.chats_depart + 2);
  assert.strictEqual(partie.joueurs[id].stock, 1);
  assert.deepStrictEqual(appeler(partie, id, "carton", 9, { now: LANCEMENT }), { ok: true, n: 1 });
  assert.strictEqual(appeler(partie, id, "carton", 1).erreur, "stockVide");
}

// ── Déplacer ──────────────────────────────────────────────────────────

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 1); // Chats noirs, Jardin
  partie.coins.arbre.n = 3;
  assert.ok(deplacementsPossibles(partie, 1).some((o) => o.s === "arbre" && o.t === "perron"));
  assert.ok(!deplacementsPossibles(partie, 1).some((o) => o.t === "tapis"), "jamais vers un autre camp");
  const nuit = parisInstant("2026-10-20", 2);
  rattraper(partie, { config: CONFIG, now: nuit });
  const avant = partie.coins.perron.n;
  assert.ok(deplacer(partie, id, "arbre", "perron", { config: CONFIG, now: nuit }).ok, "permis pendant la sieste");
  assert.strictEqual(partie.coins.arbre.n, 2);
  assert.strictEqual(partie.coins.perron.n, avant + 1);
  assert.strictEqual(deplacer(partie, id, "arbre", "perron", { config: CONFIG, now: nuit }).erreur, "plafondDeplacements");
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-20", 9) });
  partie.coins.arbre.n = 1;
  assert.strictEqual(deplacer(partie, id, "arbre", "perron", { config: CONFIG }).erreur, "deplacementImpossible", "1 chat reste sur place");
}

// ── Squatter ──────────────────────────────────────────────────────────

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 0); // Roux, Chambre
  const opts = squatsPossibles(partie, 0);
  // Depuis la Chambre : Carton → Canapé et Armoire → Malle seulement
  assert.deepStrictEqual(opts.map((o) => `${o.s}>${o.t}`).sort(), ["armoire>malle", "carton>canape"]);
  // Victoire : 6-6-6 contre 1-1 à chaque manche
  partie.coins.carton.n = 5;
  const r = lancerSquat(partie, id, "carton", "canape", { config: CONFIG, now: LANCEMENT, rng: des(6, 6, 6, 1, 1) });
  assert.ok(r.ok);
  assert.strictEqual(r.fin.issue, "victoire");
  assert.deepStrictEqual(partie.coins.canape, { b: 0, n: 4 });
  assert.strictEqual(partie.coins.carton.n, 1);
  assert.strictEqual(partie.joueurs[id].coinsPris, 1);
  assert.strictEqual(partie.joueurs[id].chatsDeloges, 2);
  assert.ok(texteJournal(partie, partie.journal.at(-1)).includes("ont délogé les chats errants de Canapé"));
}

{
  // Défaite : égalités au défenseur
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.coins.armoire.n = 3;
  // 2 Roux engagés contre 2 errants, deux égalités : défaite dès la 1re manche
  const r = lancerSquat(partie, id, "armoire", "malle", { config: CONFIG, now: LANCEMENT, rng: des(3, 3, 3, 3) });
  assert.strictEqual(r.fin.issue, "defaite");
  assert.strictEqual(partie.coins.armoire.n, 1);
  assert.strictEqual(partie.coins.malle.n, 2);
}

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.coins.armoire.n = 4; // 3 engagés contre 2 errants
  let r = lancerSquat(partie, id, "armoire", "malle", { config: CONFIG, now: LANCEMENT, rng: des(4, 4, 4, 4, 4) });
  assert.deepStrictEqual(r.manche.pa, 2); // égalités : 2 Roux perdus
  assert.strictEqual(partie.combats[id].a, 1);
  // Coins verrouillés pendant le combat
  partie.joueurs[id].stock = 1;
  assert.strictEqual(appeler(partie, id, "armoire", 1).erreur, "verrouille");
  r = jouerManche(partie, id, { now: LANCEMENT, rng: des(2, 5) });
  assert.strictEqual(r.fin.issue, "defaite");
  assert.strictEqual(partie.coins.armoire.n, 1);
  assert.deepStrictEqual(partie.coins.malle, { b: ERRANTS, n: 2 });
}

{
  // Retraite : les survivants rentrent ; squat compté
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.coins.armoire.n = 6; // 5 engagés
  lancerSquat(partie, id, "armoire", "malle", { config: CONFIG, now: LANCEMENT, rng: des(1, 1, 1, 6, 6) });
  assert.strictEqual(partie.combats[id].a, 3);
  const r = retraite(partie, id, { now: LANCEMENT });
  assert.strictEqual(r.fin.issue, "retraite");
  assert.strictEqual(partie.coins.armoire.n, 4);
  assert.strictEqual(partie.joueurs[id].squats, 1);
}

{
  // Restrictions : panier imprenable, sieste, plafond de squats, combat abandonné
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  // Les Roux tiennent le Tapis (voisin du Perron, mais le Potager, panier des Noirs, est imprenable)
  partie.coins.tapis = { b: 0, n: 5 };
  partie.coins.perron = { b: 0, n: 5 };
  assert.ok(!squatsPossibles(partie, 0).some((o) => o.t === "potager"));
  partie.coins.carton.n = 6;
  const nuit = parisInstant("2026-10-20", 3);
  rattraper(partie, { config: CONFIG, now: nuit });
  assert.strictEqual(lancerSquat(partie, id, "carton", "canape", { config: CONFIG, now: nuit }).erreur, "sieste");
  const matin = parisInstant("2026-10-20", 9);
  rattraper(partie, { config: CONFIG, now: matin });
  partie.joueurs[id].squats = CONFIG.squats_par_distribution;
  assert.strictEqual(lancerSquat(partie, id, "carton", "canape", { config: CONFIG, now: matin }).erreur, "plafondSquats");
  partie.joueurs[id].squats = 0;
  partie.coins.carton.n = 6;
  lancerSquat(partie, id, "carton", "canape", { config: CONFIG, now: matin, rng: des(1, 1, 1, 6, 6) });
  assert.ok(partie.combats[id]);
  rattraper(partie, { config: CONFIG, now: matin + 6 * 60_000 });
  assert.ok(!partie.combats[id], "retraite automatique après 5 minutes");
  assert.strictEqual(partie.journal.filter((e) => e.k === "squat").at(-1).issue, "retraiteAuto");
}

{
  const partie = partieDe(12);
  const id = joueurDe(partie, 0);
  partie.coins.carton.n = 30;
  const r = lancerSquat(partie, id, "carton", "canape", { config: CONFIG, now: LANCEMENT, rng: seeded(3) });
  const fin = r.fin ?? jusquauBout(partie, id, { now: LANCEMENT, rng: seeded(4) }).fin;
  assert.strictEqual(fin.issue, "victoire");
}

// ── Décompte, points de rang, fin ─────────────────────────────────────

{
  const partie = partieDe(12);
  // Roux : Chambre + Salon complets ; Noirs : Jardin ; Chartreux : Cuisine moins la Gamelle
  for (const c of PIECES.salon.coins) partie.coins[c] = { b: 0, n: 2 };
  partie.coins.gamelle = { b: 1, n: 2 };
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-19", 23) + 60_000 });
  const d = partie.decomptes.at(-1);
  assert.deepStrictEqual(d.totaux, [8 + 2 * CONFIG.points_piece, 5 + CONFIG.points_piece, 3]);
  assert.deepStrictEqual(d.gains, [3, 2, 1]);
  assert.deepStrictEqual(partie.points, [3, 2, 1]);
}

{
  // Ex aequo : même place, mêmes points
  const partie = partieDe(12);
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-19", 23) + 60_000 });
  assert.deepStrictEqual(partie.decomptes.at(-1).gains, [3, 3, 3]);
}

{
  // Fin après le décompte du jour 7, plus aucune action
  const partie = partieDe(12);
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-26", 9) });
  assert.strictEqual(partie.decomptes.length, 7);
  assert.ok(partie.termine);
  assert.strictEqual(jourDe(partie, parisInstant("2026-10-25", 23)), 7);
  const id = joueurDe(partie, 0);
  assert.strictEqual(appeler(partie, id, "carton", 1).erreur, "termine");
  assert.strictEqual(classementBandes(partie).length, 3);
  assert.strictEqual(classementCaid(partie, CONFIG).length, 12);
}

// ── Messagerie de bande ───────────────────────────────────────────────

{
  const partie = partieDe(12);
  const roux = Object.keys(partie.joueurs).filter((id) => partie.joueurs[id].bande === 0);
  const noir = joueurDe(partie, 1);
  assert.strictEqual(posterMessage(partie, roux[0], "   ", { config: CONFIG, now: LANCEMENT }).erreur, "messageVide");
  assert.ok(posterMessage(partie, roux[0], "On  prend\nle Canapé ?", { config: CONFIG, now: LANCEMENT }).ok);
  assert.deepStrictEqual(messagesBande(partie, 0).map((m) => m.txt), ["On prend le Canapé ?"]);
  assert.strictEqual(messagesBande(partie, 1).length, 0, "invisible pour les autres bandes");
  assert.strictEqual(nouveauxMessages(partie, roux[1]), 1);
  assert.strictEqual(nouveauxMessages(partie, roux[0]), 0, "pas ses propres messages");
  assert.strictEqual(nouveauxMessages(partie, noir), 0);
  marquerLus(partie, roux[1], { now: LANCEMENT + 1 });
  assert.strictEqual(nouveauxMessages(partie, roux[1]), 0);
  assert.strictEqual(posterMessage(partie, roux[0], "x".repeat(500), { config: CONFIG, now: LANCEMENT }).ok, true);
  assert.strictEqual(messagesBande(partie, 0).at(-1).txt.length, CONFIG.message_max);
  for (let i = 2; i < CONFIG.messages_par_jour; i++) posterMessage(partie, roux[0], `m${i}`, { config: CONFIG, now: LANCEMENT });
  assert.strictEqual(messagesRestants(partie, roux[0], { config: CONFIG, now: LANCEMENT }), 0);
  assert.strictEqual(posterMessage(partie, roux[0], "encore", { config: CONFIG, now: LANCEMENT }).erreur, "plafondMessages");
  // Quota remis à zéro le lendemain
  const demain = parisInstant("2026-10-20", 10);
  assert.strictEqual(messagesRestants(partie, roux[0], { config: CONFIG, now: demain }), CONFIG.messages_par_jour);
  assert.ok(posterMessage(partie, roux[0], "nouveau jour", { config: CONFIG, now: demain }).ok);
}

// ── PNJ du salon de test ──────────────────────────────────────────────

{
  const partie = creerPartie();
  for (let i = 0; i < 12; i++) inscrire(partie, `pnj-${i + 1}`, `PNJ ${i}`, { config: CONFIG });
  demarrer(partie, { config: CONFIG, now: LANCEMENT, rng: seeded(7) });
  partie.pnjActifs = true;
  assert.ok(estPnj("pnj-3") && !estPnj("u1"));
  rattraper(partie, { config: CONFIG, now: parisInstant("2026-10-21", 20), rng: seeded(8) });
  const squats = partie.journal.filter((e) => e.k === "squat");
  assert.ok(squats.length > 10, `les PNJ squattent (${squats.length})`);
  assert.ok(squats.every((e) => estPnj(e.p)));
  assert.ok(Object.values(partie.combats).length === 0, "aucun combat laissé en cours");
}

// ── Probabilités ──────────────────────────────────────────────────────

{
  assert.strictEqual(Math.round(pVictoire(4, 4) * 100), 48);
  assert.strictEqual(Math.round(pVictoire(4, 2) * 100), 79);
  assert.strictEqual(Math.round(pVictoire(8, 4) * 100), 89);
}

console.log("✅ meowRules : tous les tests passent");
