import assert from "assert";
import {
  buildWeeklyZeroActivityLists,
  computeWeeklySummary,
  computeMissingDuelsCountFromBattleLog,
  computeClinchedWinInfo,
  computeDay3ClinchProof,
} from "../../scripts/notifyWarSummary.js";
import { computeGroupStandings } from "../../backend/services/warStandings.js";

const FIXTURE = [
  {
    warDay: "thursday",
    realDay: "2026-04-23",
    snapshotCount: 190,
    decks: {},
  },
  {
    warDay: "friday",
    realDay: "2026-04-24",
    snapshotCount: 194,
    decks: {
      "#A": 40,
      "#B": 40,
      "#C": 40,
      "#D": 40,
      "#E": 40,
    },
  },
  {
    warDay: "saturday",
    realDay: "2026-04-25",
    snapshotCount: 194,
    decks: {},
  },
  {
    warDay: "sunday",
    realDay: "2026-04-26",
    snapshotCount: 190,
    decks: {},
  },
];

const result = computeWeeklySummary(FIXTURE);
assert.strictEqual(
  result.totalDecksWeek,
  774,
  "Should use deck totals from the snapshot decks object when present",
);
assert.strictEqual(
  result.avgDecksPerDay,
  193.5,
  "Average should compute with the weekly total and 4 days",
);
console.log("notifyWarSummary.test.js passed");

const zeroActivityFixture = {
  "#A": { name: "Alpha", donations: 0 },
  "#B": { name: "Bravo", donations: 12 },
  "#C": { name: "Charlie", donations: 0 },
};

const zeroActivityWeeks = [
  { decks: { "#B": 4 } },
  { decks: { "#B": 4 } },
  { decks: { "#B": 4 } },
  { decks: { "#B": 4 } },
];

const zeroActivityLists = buildWeeklyZeroActivityLists(
  zeroActivityFixture,
  zeroActivityWeeks,
);

assert.deepStrictEqual(
  zeroActivityLists.zeroDeckPlayers.map((player) => player.tag),
  ["#A", "#C"],
  "La liste zéro GDC doit inclure uniquement les joueurs à 0 deck sur la semaine",
);
assert.deepStrictEqual(
  zeroActivityLists.zeroDonationPlayers.map((player) => player.tag),
  ["#A", "#C"],
  "La liste zéro don doit utiliser donations et non totalDonations",
);
assert.deepStrictEqual(
  zeroActivityLists.zeroBothPlayers.map((player) => player.tag),
  ["#A", "#C"],
  "La liste combinée doit contenir les joueurs avec 0 deck ET 0 don",
);

// #A a donné 50 cartes lundi-mercredi (avant les 4 jours de guerre) puis plus
// rien pendant jeu→dim : totalDonations reste plat (150→150) sur la fenêtre
// de guerre, mais a bien augmenté depuis le baseline du lundi (100→150).
const donationMemberNames = {
  "#A": { name: "Alpha", donations: 0 },
  "#B": { name: "Bravo", donations: 0 },
};
const donationWeekDays = [
  { decks: {}, _totalDonationsByTag: { "#A": 150, "#B": 5000 } },
  { decks: {} },
  { decks: {} },
  { decks: {}, _totalDonationsByTag: { "#A": 150, "#B": 5000 } },
];
const donationBaselineFixture = {
  totalDonationsByTag: { "#A": 100, "#B": 5000 },
};

const withBaseline = buildWeeklyZeroActivityLists(
  donationMemberNames,
  donationWeekDays,
  donationBaselineFixture,
);
assert.deepStrictEqual(
  withBaseline.zeroDonationPlayers.map((player) => player.tag),
  ["#B"],
  "Avec baseline lundi, #A ne doit plus être signalé zéro don (delta lundi→dimanche = 50)",
);

const withoutBaseline = buildWeeklyZeroActivityLists(
  donationMemberNames,
  donationWeekDays,
  null,
);
assert.deepStrictEqual(
  withoutBaseline.zeroDonationPlayers.map((player) => player.tag),
  ["#A", "#B"],
  "Sans baseline (semaines déjà enregistrées), repli sur l'ancien calcul jeu→dim qui rate les dons lundi-mercredi",
);

const WEEK_DAYS = ["2026-05-21", "2026-05-22", "2026-05-23", "2026-05-24"];

const noDuelBattleLog = [
  { type: "riverRacePvP", battleTime: "20260521T120000.000Z" },
  { type: "riverRacePvP", battleTime: "20260522T120000.000Z" },
  { type: "clanWarBattle", battleTime: "20260523T120000.000Z" },
  { type: "riverRaceBoat", battleTime: "20260524T120000.000Z" },
];

assert.strictEqual(
  computeMissingDuelsCountFromBattleLog(noDuelBattleLog, "LRQP20V9", WEEK_DAYS),
  4,
  "Un joueur sans duel sur la semaine doit avoir 4 duels manquants",
);

const mixedDuelBattleLog = [
  { type: "riverRaceDuel", battleTime: "20260521T120000.000Z" },
  { type: "riverRaceDuelsColosseum", battleTime: "20260523T120000.000Z" },
  { type: "riverRacePvP", battleTime: "20260522T120000.000Z" },
  { type: "riverRaceBoat", battleTime: "20260524T120000.000Z" },
];

assert.strictEqual(
  computeMissingDuelsCountFromBattleLog(
    mixedDuelBattleLog,
    "LRQP20V9",
    WEEK_DAYS,
  ),
  2,
  "Le calcul doit retirer uniquement les jours où au moins un duel a été joué",
);

const truncatedBattleLogWithoutDuels = Array.from(
  { length: 25 },
  (_, index) => ({
    type: index % 2 === 0 ? "riverRacePvP" : "riverRaceBoat",
    battleTime: `202605${21 + (index % 4)}T120000.000Z`,
  }),
);

assert.strictEqual(
  computeMissingDuelsCountFromBattleLog(
    truncatedBattleLogWithoutDuels,
    "LRQP20V9",
    WEEK_DAYS,
  ),
  0,
  "Un battle log complet mais sans duel visible ne doit pas être traité comme une absence certaine",
);

// ── Classement / clinch GDC — warStandings.js (computeGroupStandings) ──
// GDC normale : classement par progression du bateau (raceProgress), jamais
// de prédiction anticipée avant que la ligne d'arrivée (10000) ne soit atteinte.
const warDayClans = [
  { tag: "#OWN", fame: 8822 },
  { tag: "#RIVAL1", fame: 9500 },
  { tag: "#RIVAL2", fame: 3000 },
];
const warDayStandings = computeGroupStandings(warDayClans, {
  isColosseum: false,
});
assert.strictEqual(
  warDayStandings.find((c) => c.tag === "#OWN").isClinchedWin,
  false,
  "Sous la ligne d'arrivée (8822/10000), le clan n'est jamais clinché même si en tête",
);
assert.strictEqual(
  warDayStandings[0].tag,
  "#RIVAL1",
  "Le tri en GDC normale doit suivre raceProgress décroissant, pas l'ordre d'entrée",
);

const finishedWarDayClans = [
  { tag: "#OWN", fame: 10000 },
  { tag: "#RIVAL1", fame: 9999 },
];
const finishedStandings = computeGroupStandings(finishedWarDayClans, {
  isColosseum: false,
});
assert.strictEqual(
  finishedStandings.find((c) => c.tag === "#OWN").isClinchedWin,
  true,
  "Atteindre exactement 10000 (ligne d'arrivée) doit déclencher isClinchedWin",
);

// Colisée : cumul de fame de bataille vs meilleur maximum atteignable des rivaux
// (comportement historique, non régressé par l'introduction de warStandings.js).
const colosseumNotClinchedClans = [
  { tag: "#OWN", participants: [{ fame: 60000, decksUsed: 400 }] },
  { tag: "#RIVAL1", participants: [{ fame: 30000, decksUsed: 400 }] },
];
const colosseumNotClinchedStandings = computeGroupStandings(
  colosseumNotClinchedClans,
  { isColosseum: true },
);
assert.strictEqual(
  colosseumNotClinchedStandings.find((c) => c.tag === "#OWN").isClinchedWin,
  false,
  "En Colisée, un rival avec assez de decks restants doit empêcher le clinch",
);

const colosseumClinchedClans = [
  { tag: "#OWN", participants: [{ fame: 120000, decksUsed: 800 }] },
  { tag: "#RIVAL1", participants: [{ fame: 50000, decksUsed: 800 }] },
];
const colosseumClinchedStandings = computeGroupStandings(
  colosseumClinchedClans,
  { isColosseum: true },
);
assert.strictEqual(
  colosseumClinchedStandings.find((c) => c.tag === "#OWN").isClinchedWin,
  true,
  "En Colisée, dépasser le max atteignable du rival (plus aucun deck restant) doit clincher",
);
console.log("warStandings.js (computeGroupStandings) passed");

// ── computeClinchedWinInfo / computeDay3ClinchProof — branchement par periodType ──
const warDayRace = { periodType: "warDay", clans: warDayClans };
const warDayClinchInfo = computeClinchedWinInfo(warDayRace, "#OWN");
assert.strictEqual(
  warDayClinchInfo.isClinchedWin,
  false,
  "computeClinchedWinInfo doit déléguer à warStandings.js pour le warDay",
);
assert.strictEqual(
  warDayClinchInfo.raceProgress,
  8822,
  "computeClinchedWinInfo doit exposer raceProgress en GDC normale",
);

const colosseumRace = {
  periodType: "colosseum",
  clans: colosseumClinchedClans,
};
const colosseumClinchInfo = computeClinchedWinInfo(colosseumRace, "#OWN");
assert.strictEqual(
  colosseumClinchInfo.isClinchedWin,
  true,
  "computeClinchedWinInfo doit garder le comportement Colisée existant",
);

const warDayDay3Proof = computeDay3ClinchProof(warDayRace, "#OWN");
assert.strictEqual(
  warDayDay3Proof.known,
  true,
  "En GDC normale, la preuve J3 est un simple constat direct (pas besoin d'instantané propre)",
);
assert.strictEqual(warDayDay3Proof.isClinched, false);

const colosseumCleanRace = {
  periodType: "colosseum",
  clans: colosseumClinchedClans.map((c) => ({
    ...c,
    participants: c.participants.map((p) => ({ ...p, decksUsedToday: 0 })),
  })),
};
const colosseumCleanProof = computeDay3ClinchProof(colosseumCleanRace, "#OWN");
assert.strictEqual(
  colosseumCleanProof.known,
  true,
  "En Colisée, un instantané propre (0 deck J4) doit produire une preuve exploitable",
);

const colosseumDirtyRace = {
  periodType: "colosseum",
  clans: colosseumClinchedClans.map((c, i) => ({
    ...c,
    participants: c.participants.map((p) => ({
      ...p,
      decksUsedToday: i === 0 ? 1 : 0,
    })),
  })),
};
const colosseumDirtyProof = computeDay3ClinchProof(colosseumDirtyRace, "#OWN");
assert.strictEqual(
  colosseumDirtyProof.known,
  false,
  "En Colisée, un deck déjà joué en J4 doit invalider la preuve (instantané non propre)",
);
console.log("computeClinchedWinInfo / computeDay3ClinchProof passed");

console.log("notifyWarSummary.duels.test.js passed");
