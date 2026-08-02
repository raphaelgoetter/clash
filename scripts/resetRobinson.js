#!/usr/bin/env node
// resetRobinson.js
// Remet à zéro Robinson : plus de jour actif (la prochaine publication
// repart du Jour 1 avec les stocks initiaux de robinson.json), votes,
// économie et historique effacés.
//
// Usage : node scripts/resetRobinson.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { resetRobinson } from "../backend/services/robinson.js";

(async () => {
  try {
    await resetRobinson();
    console.log("Robinson remis à zéro : plus de jour actif, historique effacé.");
  } catch (err) {
    console.error("Échec de la remise à zéro :", err.message);
    process.exit(1);
  }
})();
