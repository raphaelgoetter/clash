#!/usr/bin/env node
// bangStatus.js
// Affiche l'état courant de Bang! (phase, jour, pioche, mains, Élixir,
// effets en cours) sans ouvrir Discord — vue organisateur, les mains et
// l'ordre de la pioche y sont donc visibles.
//
// Usage : node scripts/bangStatus.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadBangConfig, readState, readPartie } from "../backend/services/bang.js";
import { CARTES, nbBombes, texteJournal } from "../backend/services/bangRules.js";

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie de Bang! active pour le moment.");
    return;
  }
  if (state.phase === "annonce") {
    console.log("Phase : présentation (la partie commence au prochain post).");
    return;
  }
  const [config, partie] = await Promise.all([loadBangConfig(), readPartie()]);
  const nom = (c) => CARTES[c]?.nom || c;
  console.log(`Jour ${state.jour}/${config.duree_jours}${state.termine ? " (terminée)" : ""}`);
  console.log(`Pioche (${partie.pioche.length} cartes, ${nbBombes(partie)} Gobelins explosifs) : ${partie.pioche.slice(0, 10).map(nom).join(", ")}${partie.pioche.length > 10 ? ", …" : ""}\n`);

  const joueurs = Object.values(partie.joueurs).sort((a, b) => Number(b.vivant) - Number(a.vivant) || a.username.localeCompare(b.username));
  if (!joueurs.length) {
    console.log("Aucun joueur n'a encore rejoint la partie.");
    return;
  }
  console.log("Joueurs :");
  for (const j of joueurs) {
    if (!j.vivant) {
      console.log(`  - ${j.username} — 💀 éliminé (${j.rangElimination}e)`);
      continue;
    }
    const effets = [j.moine && "Moine", j.maudit && `maudit ×${j.maudit}`, j.dette && `${j.dette} pioche(s) due(s)`, j.enAttente && "bombe à cacher", !j.tourFait && "pas encore pioché"].filter(Boolean);
    console.log(`  - ${j.username} — ${j.elixir} Élixir · ${j.main.map(nom).join(", ") || "main vide"}${effets.length ? ` · ${effets.join(", ")}` : ""}`);
  }
  console.log("\nDerniers événements :");
  for (const e of partie.journal.filter((x) => !x.p).slice(-10)) console.log(`  J${e.j} ${texteJournal(partie, e).replace(/\*\*/g, "")}`);
})();
