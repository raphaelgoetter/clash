// Lecture seule : chats sur la carte, en réserve, et bilan entrées/sorties
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { readPartie } = await import("../../services/meow.js");
const { COINS } = await import("../../services/meowRules.js");
const p = await readPartie();
const surCarte = COINS.reduce((t, c) => t + p.coins[c].n, 0);
const errants = COINS.filter((c) => p.coins[c].b === -1).reduce((t, c) => t + p.coins[c].n, 0);
const reserve = Object.values(p.joueurs).reduce((t, j) => t + (j.stock ?? 0), 0);
const deloges = Object.values(p.joueurs).reduce((t, j) => t + (j.chatsDeloges ?? 0), 0);
const croq = p.journal.filter((e) => e.k === "croquettes").reduce((t, e) => t + e.n, 0);
console.log(`Sur la carte : ${surCarte} chats (dont ${errants} errants) sur 20 territoires, soit ${(surCarte / 20).toFixed(1)} par territoire`);
console.log(`En réserve : ${reserve} · départ : 40 (24 dans les pièces de départ + 16 errants)`);
console.log(`Chats délogés (défenseurs perdus) sur la partie : ${deloges} · croquettes vues dans le journal : ${croq}`);
