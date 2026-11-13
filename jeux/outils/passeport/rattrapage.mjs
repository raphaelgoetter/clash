// Rattrapage du passeport d'une saison (jeux/services/passeport.js) à partir
// des données déjà tenues par les jeux : à lancer quand le registre a manqué
// des parties (déploiement en cours de mois, incident Redis). Idempotent :
// le registre ne compte qu'une fois chaque manche et chaque jeu spécial.
//
// Sources :
// - manches hebdomadaires archivées (réponses trouvées, et toutes les
//   réponses pour le moteur Trivia), datées : retenues si jouées dans la
//   saison visée ;
// - manche en cours de chaque jeu : tous ceux qui ont interagi (hashes
//   `<jeu>:usernames:<gameId>` et `<jeu>:participants:<gameId>`), datés
//   de maintenant ;
// - jeux spéciaux : classements des parties terminées dans la saison, et
//   inscrits de Qui est-ce ? / Meow en cours.
// Non récupérables : les victoires en duel (aucun historique).
//
// Usage :
//   node jeux/outils/passeport/rattrapage.mjs                 — aperçu, n'écrit rien
//   node jeux/outils/passeport/rattrapage.mjs --ecrire        — écrit dans le registre
//   node jeux/outils/passeport/rattrapage.mjs --saison 138    — saison visée (défaut : en cours)

import "../../env.js";

import { Redis } from "@upstash/redis";
import { SPECIAL_GAMES, WEEKLY_GAMES } from "../../services/miniJeuxStats.js";
import { noterJeuSpecial, noterManche } from "../../services/passeport.js";
import { getSeasonBoundsById, seasonIdForDate } from "../../services/saison.js";
import * as frames from "../../services/frames.js";
import * as trivia from "../../services/trivia.js";
import * as triviageek from "../../services/triviageek.js";
import * as intrus from "../../services/intrus.js";
import * as anagrams from "../../services/anagrams.js";
import * as pelemele from "../../services/pelemele.js";
import * as concept from "../../services/concept.js";
import * as synopsis from "../../services/synopsis.js";
import * as zoom from "../../services/zoom.js";
import * as zoom2 from "../../services/zoom2.js";
import * as platpays from "../../services/platpays.js";
import * as palette from "../../services/palette.js";
import * as blindroyale from "../../services/blindroyale.js";
import * as lajustecarte from "../../services/lajustecarte.js";
import { readPartie as readQuiEstCe } from "../../services/quiestce.js";
import { readPartie as readMeow } from "../../services/meow.js";

const ECRIRE = process.argv.includes("--ecrire");
const iSaison = process.argv.indexOf("--saison");
const now = new Date();
const seasonId = iSaison > 0 ? Number(process.argv[iSaison + 1]) : seasonIdForDate(now);
const { start, end } = getSeasonBoundsById(seasonId);
// Date retenue pour les entrées de la manche en cours : maintenant, ou la
// fin de la saison visée si elle est passée.
const dateCourante = now < end ? now : new Date(end.getTime() - 1000);

// Clé de jeu (préfixe Redis) → service
const SERVICES = { frame: frames, trivia, triviageek, intrus, anagram: anagrams, pelemele, concept, synopsis, zoom, zoom2, platpays, palette, blindroyale, lajustecarte };

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, automaticDeserialization: false });
const dansSaison = (date) => date && seasonIdForDate(new Date(date)) === seasonId;

const manches = new Map(); // discordId → Set("<jeu>:<gameId>")
const speciaux = new Map(); // discordId → Set(jeu)
const ajouter = (map, id, valeur, date) => {
  if (!id) return;
  if (!map.has(id)) map.set(id, new Map());
  if (!map.get(id).has(valeur)) map.get(id).set(valeur, date);
};

// Manches archivées
const archives = await Promise.all(WEEKLY_GAMES.map((g) => g.fetch()));
WEEKLY_GAMES.forEach((g, i) => {
  for (const r of archives[i]) {
    const date = r.solvedAt || r.postedAt;
    if (r.gameId && dansSaison(date)) ajouter(manches, r.discordId, `${g.key}:${r.gameId}`, new Date(date));
  }
});

// Manches en cours (seulement si la saison visée est en cours)
if (seasonIdForDate(now) === seasonId) {
  for (const [jeu, svc] of Object.entries(SERVICES)) {
    const state = await svc.readState();
    if (!state?.gameId) continue;
    const ids = new Set([
      ...((await redis.hkeys(`${jeu}:usernames:${state.gameId}`)) ?? []),
      ...((await redis.hkeys(`${jeu}:participants:${state.gameId}`)) ?? []),
    ]);
    for (const id of ids) ajouter(manches, id, `${jeu}:${state.gameId}`, dateCourante);
  }
  for (const [jeu, lire] of [["quiestce", readQuiEstCe], ["meow", readMeow]]) {
    const partie = await lire().catch(() => null);
    if (partie?.joueurs && !partie.termine) {
      for (const id of Object.keys(partie.joueurs)) if (!id.startsWith("pnj")) ajouter(speciaux, id, jeu, dateCourante);
    }
  }
}

// Jeux spéciaux terminés dans la saison
for (const g of SPECIAL_GAMES) {
  for (const m of await g.fetch({ limit: 50 })) {
    if (!dansSaison(m.resolvedAt) || !Array.isArray(m.ranking)) continue;
    for (const r of m.ranking) ajouter(speciaux, r.discordId, g.key, new Date(m.resolvedAt));
  }
}

console.log(`Saison ${seasonId} (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})${ECRIRE ? "" : " [aperçu]"}`);
const joueurs = new Set([...manches.keys(), ...speciaux.keys()]);
for (const id of joueurs) {
  const m = manches.get(id) ?? new Map();
  const s = speciaux.get(id) ?? new Map();
  const jeux = new Set([...m.keys()].map((k) => k.split(":")[0]));
  console.log(`${id} : ${m.size} manche(s), ${jeux.size} jeu(x) [${[...jeux].join(", ")}]${s.size ? `, spéciaux [${[...s.keys()].join(", ")}]` : ""}`);
  if (!ECRIRE) continue;
  for (const [cle, date] of m) {
    const [jeu, ...reste] = cle.split(":");
    await noterManche(id, jeu, reste.join(":"), date);
  }
  for (const [jeu, date] of s) await noterJeuSpecial(id, jeu, date);
}
console.log(`${joueurs.size} joueur(s)${ECRIRE ? " rattrapés." : ". Relancer avec --ecrire pour écrire."}`);
