// Mots contestés par les joueurs du Petit Bac (refusés « pas dans la
// liste », signalés par 🚩 Contester), groupés par thème, les plus signalés
// d'abord. Après vérification : ajouter les bons dans
// jeux/outils/bac/ajouts/<thème>.txt, régénérer (genererListes.mjs), puis
// retirer les mots traités.
// Usage (Redis de production, lecture seule par défaut) :
//   node --env-file=.env jeux/outils/bac/contestations.mjs
//   node --env-file=.env jeux/outils/bac/contestations.mjs --retirer <thème>:<mot> [...]
//   node --env-file=.env jeux/outils/bac/contestations.mjs --tout-retirer
import { lireContestations, viderContestations } from "../../services/bacDuel.js";
import { THEMES, normaliser } from "../../services/bacRules.js";

const args = process.argv.slice(2);
const liste = await lireContestations();

if (args[0] === "--tout-retirer") {
  await viderContestations(liste.map((c) => c.champ));
  console.log(`${liste.length} contestations retirées.`);
} else if (args[0] === "--retirer") {
  const champs = args.slice(1).map((a) => {
    const [theme, ...mot] = a.split(":");
    return `${theme}:${normaliser(mot.join(":"))}`;
  });
  await viderContestations(champs);
  console.log(`${champs.length} contestations retirées.`);
} else {
  if (!liste.length) console.log("Aucun mot contesté.");
  const parTheme = Map.groupBy(liste, (c) => c.theme);
  for (const [theme, l] of parTheme) {
    console.log(`\n== ${THEMES[theme] ?? theme} (${theme})`);
    for (const c of l.sort((a, b) => b.nb - a.nb)) console.log(`${String(c.nb).padStart(3)} × ${c.mot} (lettre ${c.lettres.join(", ")} ; ${c.joueurs.join(", ")})`);
  }
}
