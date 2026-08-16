#!/usr/bin/env node
// justeCarteOrder.js
// Affiche l'ordre de rotation complet des cartes secrètes de La Juste
// Carte — outil ADMIN uniquement (révèle toutes les cartes à venir, jamais
// exposé aux joueurs). Si aucun ordre n'a encore été généré (avant la toute
// première partie), ce script en génère un et le persiste dans Redis
// (lajustecarte:order), exactement comme le ferait la première publication.
//
// Usage : node scripts/justeCarteOrder.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadCatalog, loadPlayOrder, readState } from "../backend/services/lajustecarte.js";

(async () => {
  const catalog = await loadCatalog();
  const order = await loadPlayOrder(catalog);
  const state = await readState();
  const currentIndex = state?.currentIndex ?? -1;
  const frByCardKey = new Map(catalog.map((c) => [c.cardKey, c.fr]));

  console.log(`Ordre de rotation La Juste Carte (${order.length} cartes) :\n`);

  const rows = order.map((cardKey, index) => {
    const distance = currentIndex === -1 ? null : (index - currentIndex + order.length) % order.length;
    let quand;
    if (currentIndex === -1) quand = "-";
    else if (distance === 0) quand = "◀ manche actuelle";
    else quand = `dans ${distance} semaine${distance > 1 ? "s" : ""}`;
    return { "#": index + 1, Carte: frByCardKey.get(cardKey) ?? cardKey, Quand: quand };
  });

  console.table(rows);

  if (currentIndex === -1) {
    console.log("Aucune partie n'a encore été lancée — cet ordre vient d'être généré et sera utilisé dès la première publication.");
  }
})();
