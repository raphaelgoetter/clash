// Mots contestés par les joueurs du Petit Bac (refusés « pas dans la
// liste », signalés par 🚩 Contester), groupés par thème, les plus signalés
// d'abord. Après vérification : accepter les bons mots (Redis
// `bacduel:ajouts`, valables tout de suite, sans commit ni déploiement ; leur
// contestation est retirée), retirer les autres.
// Usage (Redis de production, lecture seule par défaut) :
//   node --env-file=.env jeux/outils/bac/contestations.mjs
//   node --env-file=.env jeux/outils/bac/contestations.mjs --accepter <thème>:<mot> [...]
//   node --env-file=.env jeux/outils/bac/contestations.mjs --retirer <thème>:<mot> [...]
//   node --env-file=.env jeux/outils/bac/contestations.mjs --tout-retirer
//   node --env-file=.env jeux/outils/bac/contestations.mjs --ajouts
//   node --env-file=.env jeux/outils/bac/contestations.mjs --retirer-ajout <thème>:<mot> [...]
// Personnes (acteurs, musique) : accepter le nom complet (« musique:Rim'K »).
import { accepterMots, chargerAjouts, lireContestations, retirerAjouts, viderContestations } from "../../services/bacDuel.js";
import { THEMES, normaliser } from "../../services/bacRules.js";

const args = process.argv.slice(2);

// « <thème>:<mot> » → { theme, mot }, thème vérifié
const lire = (a) => {
  const [theme, ...mot] = a.split(":");
  if (!THEMES[theme] || !mot.join(":").trim()) throw new Error(`Attendu <thème>:<mot> (thèmes : ${Object.keys(THEMES).join(", ")}) : ${a}`);
  return { theme, mot: mot.join(":").trim() };
};
const champ = ({ theme, mot }) => `${theme}:${normaliser(mot)}`;

if (args[0] === "--accepter") {
  const mots = args.slice(1).map(lire);
  await accepterMots(mots);
  console.log(`${mots.length} mots acceptés : ${mots.map((m) => `${m.mot} (${m.theme})`).join(", ")}`);
} else if (args[0] === "--ajouts") {
  const ajouts = await chargerAjouts();
  if (!Object.keys(ajouts).length) console.log("Aucun mot ajouté.");
  for (const [theme, l] of Object.entries(ajouts)) console.log(`${THEMES[theme] ?? theme} (${theme}) : ${l.join(", ")}`);
} else if (args[0] === "--retirer-ajout") {
  const champs = args.slice(1).map((a) => champ(lire(a)));
  await retirerAjouts(champs);
  console.log(`${champs.length} ajouts retirés.`);
} else if (args[0] === "--tout-retirer") {
  const liste = await lireContestations();
  await viderContestations(liste.map((c) => c.champ));
  console.log(`${liste.length} contestations retirées.`);
} else if (args[0] === "--retirer") {
  const champs = args.slice(1).map((a) => champ(lire(a)));
  await viderContestations(champs);
  console.log(`${champs.length} contestations retirées.`);
} else {
  const liste = await lireContestations();
  if (!liste.length) console.log("Aucun mot contesté.");
  const parTheme = Map.groupBy(liste, (c) => c.theme);
  for (const [theme, l] of parTheme) {
    console.log(`\n== ${THEMES[theme] ?? theme} (${theme})`);
    for (const c of l.sort((a, b) => b.nb - a.nb)) console.log(`${String(c.nb).padStart(3)} × ${c.mot} (lettre ${c.lettres.join(", ")} ; ${c.joueurs.join(", ")})`);
  }
}
