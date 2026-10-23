// ============================================================
// meowImage.js — Images de Meow : la carte de la maison (fond illustré,
// pastilles de chats aux couleurs des bandes, paniers imprenables,
// passages entre pièces) et l'illustration de présentation.
// Même technique que quiestceImage.js : SVG généré à la volée, rastérisé
// via @resvg/resvg-js, puis encodé en JPEG (jpeg-js, pur JS : ~180 Ko au
// lieu de 1,2 Mo en PNG, décision du 16/10).
//
// Rendu sans état : la carte est passée dans l'URL (encodeCarte) ; l'URL
// change avec l'état, ce qui contourne le cache d'images de Discord.
//
// Assets servis depuis Vercel Blob (voir blobAssets.js), data/ n'est pas lu
// au runtime : relancer `npm run assets:upload-blob -- meow` après
// modification. Fond en JPEG, jamais en WebP (resvg ne décode pas le WebP
// embarqué, voir marioclashImage.js).
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { readBlobAsset, readBlobFontPath } from "@clash/commun/blobAssets.js";
import { COINS, PANIERS, ERRANTS, nomCoin } from "./meowRules.js";

const MAP_IMAGE_PATH = "meow/images/meow-map.jpg";
const ILLUSTRATION_IMAGE_PATH = "meow/images/meow-launch.webp";
const FONT_PATH = "fonts/Inter-Bold.ttf";
const FONT_FAMILY = "Inter";

// Dimensions natives de meow-map.jpg
const W = 1000;
const H = 667;
const QUALITE_JPEG = 80;

const COULEURS = ["#e8812a", "#2b2b35", "#4f7fc4"];
const COULEUR_ERRANTS = "#9a8c7a";

// Position de chaque pastille sur le fond (calée à la main le 16/10, à
// recalibrer si l'asset change)
const POSITIONS = {
  fenetre: [78, 112],
  couette: [190, 120],
  armoire: [380, 62],
  carton: [440, 132],
  malle: [607, 102],
  chapeaux: [727, 60],
  poutre: [797, 92],
  lucarne: [893, 110],
  radiateur: [108, 288],
  canape: [297, 262],
  tapis: [305, 362],
  biblio: [533, 275],
  evier: [742, 240],
  frigo: [866, 244],
  corbeille: [852, 316],
  gamelle: [800, 392],
  arbre: [137, 498],
  perron: [460, 478],
  potager: [648, 532],
  cabane: [875, 492],
};

// Tracé des passages (pointillés) et position de leur pictogramme
const TRACES = [
  { a: "carton", b: "canape", picto: [367, 190] },
  { a: "armoire", b: "malle", picto: [497, 70] },
  { a: "evier", b: "chapeaux", picto: [643, 188] },
  { a: "gamelle", b: "biblio", picto: [590, 378] },
  { a: "tapis", b: "perron", picto: [460, 432] },
  // Gouttière le long du mur extérieur droit
  { a: "cabane", b: "lucarne", via: [[946, 470], [946, 130]], picto: [946, 300] },
];

const CODES = ["r", "n", "c"];

// Carte → « r03n12… » : par coin (ordre de COINS), bande (r/n/c, e pour
// errants) et nombre de chats sur 2 chiffres.
export function encodeCarte(partie) {
  return COINS.map((c) => {
    const { b, n } = partie.coins[c];
    return `${b === ERRANTS ? "e" : CODES[b]}${String(Math.min(99, n)).padStart(2, "0")}`;
  }).join("");
}

// null si le paramètre est illisible.
export function decodeCarte(param) {
  const s = String(param ?? "");
  if (!/^([rnce]\d{2}){20}$/.test(s)) return null;
  return Object.fromEntries(
    COINS.map((c, i) => {
      const code = s[i * 3];
      return [c, { b: code === "e" ? ERRANTS : CODES.indexOf(code), n: Number(s.slice(i * 3 + 1, i * 3 + 3)) }];
    }),
  );
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Patte de chat dans un rond crème
function patte(x, y) {
  return `<g>
    <circle cx="${x}" cy="${y}" r="13" fill="#fffaf0" stroke="#7a4a1e" stroke-width="2"/>
    <ellipse cx="${x}" cy="${y + 3}" rx="4.6" ry="3.8" fill="#7a4a1e"/>
    <circle cx="${x - 5.5}" cy="${y - 2.5}" r="2" fill="#7a4a1e"/>
    <circle cx="${x - 2}" cy="${y - 6}" r="2" fill="#7a4a1e"/>
    <circle cx="${x + 2}" cy="${y - 6}" r="2" fill="#7a4a1e"/>
    <circle cx="${x + 5.5}" cy="${y - 2.5}" r="2" fill="#7a4a1e"/>
  </g>`;
}

function pastille(id, { b, n }) {
  const [x, y] = POSITIONS[id];
  const couleur = b === ERRANTS ? COULEUR_ERRANTS : COULEURS[b];
  const nom = nomCoin(id);
  const r = 19;
  const largeur = nom.length * 7.2 + 14;
  // Panier imprenable : anneau doré + petit cadenas
  const anneau = PANIERS.includes(id)
    ? `<circle cx="${x}" cy="${y}" r="${r + 7}" fill="none" stroke="#f2c230" stroke-width="4"/>
       <circle cx="${x}" cy="${y}" r="${r + 9.5}" fill="none" stroke="#7a4a1e" stroke-width="1.2"/>
       <g transform="translate(${x + 17}, ${y - 25})">
         <path d="M-4 0 v-3 a4 4 0 0 1 8 0 v3" fill="none" stroke="#7a4a1e" stroke-width="2"/>
         <rect x="-6" y="0" width="12" height="9" rx="2" fill="#f2c230" stroke="#7a4a1e" stroke-width="1.5"/>
       </g>`
    : "";
  return `<g>
    ${anneau}
    <circle cx="${x}" cy="${y}" r="${r + 3}" fill="#fff" opacity="0.92"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${couleur}"/>
    <text x="${x}" y="${y + 7}" font-family="${FONT_FAMILY}" font-size="${n > 9 ? 17 : 20}" text-anchor="middle" fill="#fff">${n}</text>
    <rect x="${x - largeur / 2}" y="${y + r + 6}" width="${largeur}" height="18" rx="9" fill="#fffaf0" opacity="0.94" stroke="${couleur}" stroke-width="1.5"/>
    <text x="${x}" y="${y + r + 19}" font-family="${FONT_FAMILY}" font-size="11" text-anchor="middle" fill="#3a2a1a">${escapeXml(nom)}</text>
  </g>`;
}

async function buildCarteSvg(coins) {
  const fond = (await readBlobAsset(MAP_IMAGE_PATH)).toString("base64");
  const traits = TRACES.map(({ a, b, via, picto }) => {
    const points = [POSITIONS[a], ...(via || [picto]), POSITIONS[b]].map((p) => p.join(",")).join(" ");
    return `<polyline points="${points}" fill="none" stroke="#fffaf0" stroke-width="3" stroke-dasharray="2 7" stroke-linecap="round" opacity="0.9"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image href="data:image/jpeg;base64,${fond}" x="0" y="0" width="${W}" height="${H}"/>
  ${traits}
  ${TRACES.map(({ picto }) => patte(...picto)).join("")}
  ${COINS.map((c) => pastille(c, coins[c])).join("")}
</svg>`;
}

export async function getCarteImage(coins) {
  const fontPath = await readBlobFontPath(FONT_PATH);
  const rendu = new Resvg(await buildCarteSvg(coins), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  }).render();
  const buffer = Buffer.from(jpeg.encode({ data: rendu.pixels, width: rendu.width, height: rendu.height }, QUALITE_JPEG).data);
  return { buffer, mimeType: "image/jpeg" };
}

let illustrationCache = null;

export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
