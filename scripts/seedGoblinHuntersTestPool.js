#!/usr/bin/env node
// seedGoblinHuntersTestPool.js
// TESTS UNIQUEMENT — inscrit un faux pool de joueurs (8 par défaut = tout
// l'effectif minimum, pour pouvoir tester entièrement seul sans avoir besoin
// d'un second testeur) sous des IDs Discord factices. Les DM de rôle
// échoueront proprement pour ces faux comptes au lancement (sendGoblinHuntersDM
// catch déjà l'erreur, voir api/discord/_handlers/goblinhunters.js) — sans
// incidence sur le reste du déroulement.
//
// Usage :
//   node scripts/seedGoblinHuntersTestPool.js          — inscrit 8 faux joueurs
//   node scripts/seedGoblinHuntersTestPool.js 4        — inscrit un nombre différent

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { registerPlayer, loadGoblinHuntersConfig } from "../backend/services/goblinhunters.js";

const COUNT = Number(process.argv[2]) || 8;

(async () => {
  try {
    const config = await loadGoblinHuntersConfig();
    let registered = 0;
    for (let i = 1; i <= COUNT; i++) {
      const result = await registerPlayer(`test_fake_${i}`, `TestJoueur${i}`, config.effectif_max);
      if (result.status === "registered") registered++;
      else console.log(`  test_fake_${i} : ${result.status}`);
    }
    console.log(`${registered}/${COUNT} faux joueur(s) inscrit(s) (goblinhunters:inscriptions).`);
  } catch (err) {
    console.error("Échec du seed du pool de test :", err.message);
    process.exit(1);
  }
})();
