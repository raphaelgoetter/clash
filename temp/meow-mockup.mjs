// Maquette Meow : pastilles de chats, paniers imprenables et passages sur le fond de carte.
// Usage : node temp/meow-mockup.mjs <sortie.jpg> [chemin node_modules contenant jpeg-js]
import fs from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const W = 1000;
const H = 667;
const fond = fs.readFileSync("data/meow/images/meow-map.jpg").toString("base64");

const BANDES = {
  roux: { couleur: "#e8812a" },
  noirs: { couleur: "#2b2b35" },
  chartreux: { couleur: "#4f7fc4" },
};

// État fictif au jour 3 (Roux partis de la Chambre, Noirs du Jardin, Chartreux de la Cuisine)
const COINS = [
  { id: "fenetre", nom: "Fenêtre", x: 78, y: 112, bande: "roux", chats: 3, panier: true },
  { id: "couette", nom: "Couette", x: 190, y: 120, bande: "roux", chats: 2 },
  { id: "armoire", nom: "Armoire", x: 380, y: 62, bande: "roux", chats: 3 },
  { id: "carton", nom: "Carton", x: 440, y: 132, bande: "roux", chats: 4 },
  { id: "malle", nom: "Malle", x: 607, y: 102, bande: "roux", chats: 2 },
  { id: "chapeaux", nom: "Chapeaux", x: 727, y: 60, bande: "chartreux", chats: 2 },
  { id: "poutre", nom: "Poutre", x: 797, y: 92, bande: "chartreux", chats: 1 },
  { id: "lucarne", nom: "Lucarne", x: 893, y: 110, bande: "noirs", chats: 2 },
  { id: "radiateur", nom: "Radiateur", x: 108, y: 288, bande: "noirs", chats: 1 },
  { id: "canape", nom: "Canapé", x: 297, y: 262, bande: "roux", chats: 2 },
  { id: "tapis", nom: "Tapis", x: 305, y: 362, bande: "noirs", chats: 3 },
  { id: "biblio", nom: "Bibliothèque", x: 533, y: 275, bande: "chartreux", chats: 2 },
  { id: "evier", nom: "Évier", x: 742, y: 240, bande: "chartreux", chats: 3 },
  { id: "frigo", nom: "Frigo", x: 866, y: 244, bande: "chartreux", chats: 3, panier: true },
  { id: "corbeille", nom: "Corbeille", x: 852, y: 316, bande: "chartreux", chats: 1 },
  { id: "gamelle", nom: "Gamelle", x: 800, y: 392, bande: "chartreux", chats: 3 },
  { id: "arbre", nom: "Arbre", x: 137, y: 498, bande: "noirs", chats: 2 },
  { id: "perron", nom: "Perron", x: 460, y: 478, bande: "noirs", chats: 3 },
  { id: "potager", nom: "Potager", x: 648, y: 532, bande: "noirs", chats: 3, panier: true },
  { id: "cabane", nom: "Cabane", x: 875, y: 492, bande: "noirs", chats: 2 },
];

// Passages entre pièces : [coin A, coin B, points intermédiaires du tracé..., position du pictogramme]
const PASSAGES = [
  { a: "carton", b: "canape", picto: [367, 190] },
  { a: "armoire", b: "malle", picto: [497, 70] },
  { a: "evier", b: "chapeaux", picto: [643, 188] },
  { a: "gamelle", b: "biblio", picto: [590, 378] },
  { a: "tapis", b: "perron", picto: [460, 432] },
  // Gouttière le long du mur extérieur droit
  { a: "cabane", b: "lucarne", via: [[946, 470], [946, 130]], picto: [946, 300] },
];

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Patte de chat dans un rond crème
function patte(x, y) {
  return `
  <g>
    <circle cx="${x}" cy="${y}" r="13" fill="#fffaf0" stroke="#7a4a1e" stroke-width="2"/>
    <ellipse cx="${x}" cy="${y + 3}" rx="4.6" ry="3.8" fill="#7a4a1e"/>
    <circle cx="${x - 5.5}" cy="${y - 2.5}" r="2" fill="#7a4a1e"/>
    <circle cx="${x - 2}" cy="${y - 6}" r="2" fill="#7a4a1e"/>
    <circle cx="${x + 2}" cy="${y - 6}" r="2" fill="#7a4a1e"/>
    <circle cx="${x + 5.5}" cy="${y - 2.5}" r="2" fill="#7a4a1e"/>
  </g>`;
}

function pastille(c) {
  const b = BANDES[c.bande];
  const r = 19;
  const largeur = c.nom.length * 7.2 + 14;
  // Panier imprenable : anneau doré + petit cadenas
  const anneau = c.panier
    ? `<circle cx="${c.x}" cy="${c.y}" r="${r + 7}" fill="none" stroke="#f2c230" stroke-width="4"/>
       <circle cx="${c.x}" cy="${c.y}" r="${r + 9.5}" fill="none" stroke="#7a4a1e" stroke-width="1.2"/>
       <g transform="translate(${c.x + 17}, ${c.y - 25})">
         <path d="M-4 0 v-3 a4 4 0 0 1 8 0 v3" fill="none" stroke="#7a4a1e" stroke-width="2"/>
         <rect x="-6" y="0" width="12" height="9" rx="2" fill="#f2c230" stroke="#7a4a1e" stroke-width="1.5"/>
       </g>`
    : "";
  return `
  <g>
    ${anneau}
    <circle cx="${c.x}" cy="${c.y}" r="${r + 3}" fill="#fff" opacity="0.92"/>
    <circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${b.couleur}"/>
    <text x="${c.x}" y="${c.y + 7}" font-family="Helvetica" font-weight="bold" font-size="20" text-anchor="middle" fill="#fff">${c.chats}</text>
    <rect x="${c.x - largeur / 2}" y="${c.y + r + 6}" width="${largeur}" height="18" rx="9" fill="#fffaf0" opacity="0.94" stroke="${b.couleur}" stroke-width="1.5"/>
    <text x="${c.x}" y="${c.y + r + 19}" font-family="Helvetica" font-size="12" text-anchor="middle" fill="#3a2a1a">${esc(c.nom)}</text>
  </g>`;
}

const parId = Object.fromEntries(COINS.map((c) => [c.id, c]));
const traits = PASSAGES.map(({ a, b, via, picto }) => {
  const p = parId[a];
  const q = parId[b];
  const milieu = via || [picto];
  const points = [[p.x, p.y], ...milieu, [q.x, q.y]].map((pt) => pt.join(",")).join(" ");
  return `<polyline points="${points}" fill="none" stroke="#fffaf0" stroke-width="3" stroke-dasharray="2 7" stroke-linecap="round" opacity="0.9"/>`;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image href="data:image/jpeg;base64,${fond}" x="0" y="0" width="${W}" height="${H}"/>
  ${traits}
  ${PASSAGES.map(({ picto }) => patte(...picto)).join("")}
  ${COINS.map(pastille).join("")}
</svg>`;

const rendu = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true } }).render();
const sortie = process.argv[2] || "meow-mockup.jpg";
if (sortie.endsWith(".jpg")) {
  // jpeg-js : pas encore dans les dépendances du projet, chemin passé en argument
  const require = createRequire(`${process.argv[3] || "."}/`);
  const jpeg = require("jpeg-js");
  const out = jpeg.encode({ data: rendu.pixels, width: rendu.width, height: rendu.height }, 80).data;
  fs.writeFileSync(sortie, out);
  console.log("OK", Math.round(out.length / 1024), "Ko");
} else {
  fs.writeFileSync(sortie, rendu.asPng());
  console.log("OK (PNG)");
}
