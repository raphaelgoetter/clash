// ============================================================
// robinsonImage.js — Image du jour de Robinson (message public), 900 × 600 :
// - bandeau : titre, frise des 7 jours (météo passée, du jour entourée,
//   prévision de demain en pointillés, « ? » au-delà), jour ;
// - météo du jour et rendement par joueur, prévision de demain ;
// - trois stocks avec le besoin de la nuit (trait blanc) ;
// - Radeau : une planche par planche posée sur l'objectif, joueurs à bord.
// SVG rastérisé par @resvg/resvg-js (police Inter, Vercel Blob), JPEG.
// Icônes dessinées (pas d'emoji : resvg ne les rend pas en couleur).
//
// Rendu sans état : l'état est passé dans l'URL (encodePlateau), l'URL
// change avec lui (cache CDN sans risque). ⚠️ Anti-spoiler : seule la
// PRÉVISION de demain est encodée, jamais la vraie météo.
// ⚠️ Lisibilité mobile : aucun texte < 36 px (≈ 14 px affiché à 360 px).
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { texteAffichable } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import { loadRobinsonConfig } from "./robinson.js";

const FONT_FAMILY = "Inter";
export const PLATEAU_L = 900;
const PLATEAU_H = 600;
const QUALITE_JPEG = 88;
const METEOS = ["soleil", "nuages", "pluie", "tempete"];
const NOMS = { soleil: "Soleil", nuages: "Nuages", pluie: "Pluie", tempete: "Tempête" };

const C = {
  fond: "#0e2f45",
  panneau: "#174560",
  texte: "#ffffff",
  doux: "#a9c6d8",
  soleil: "#ffc933",
  nuage: "#dfe8ee",
  orage: "#8e9aa6",
  poisson: "#ff9f68",
  eau: "#4fc3f7",
  bois: "#c98b4f",
  boisClair: "#e8b77d",
  vert: "#3ddc84",
  orange: "#ffa53a",
  rouge: "#ff5a4f",
};

// ── Encodage de l'état dans l'URL ──────────────────────────────────

const versUrl = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function depuisUrl(param) {
  try {
    return JSON.parse(Buffer.from(String(param ?? ""), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
const entier = (n, min = 0, max = 9999) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
const meteoValide = (id) => (METEOS.includes(id) ? id : null);

// `passees` : météo des jours déjà joués (Jour 1 en premier), `prevision` :
// prévision de demain (null au dernier jour), `besoin` : repas de la nuit
// (joueurs du moment), `planches` : planches du soir (votes du jour compris).
export function encodePlateau({ jour, duree, meteo, prevision, passees, stocks, besoin, planches, objectif, aBord }) {
  return versUrl({
    j: jour,
    d: duree,
    m: meteo,
    p: prevision ?? null,
    h: passees ?? [],
    s: [stocks?.poisson ?? 0, stocks?.eau ?? 0, stocks?.bois ?? 0],
    b: [besoin?.poisson ?? 0, besoin?.eau ?? 0, besoin?.bois ?? 0],
    pl: planches ?? 0,
    o: objectif ?? 0,
    a: aBord ?? 0,
  });
}

export function decodePlateau(param) {
  const d = depuisUrl(param);
  if (!d || typeof d !== "object" || !meteoValide(d.m)) return null;
  const triple = (a) => [0, 1, 2].map((i) => entier(Array.isArray(a) ? a[i] : 0));
  const duree = entier(d.d, 1, 14);
  return {
    jour: entier(d.j, 1, duree),
    duree,
    meteo: d.m,
    prevision: meteoValide(d.p),
    passees: (Array.isArray(d.h) ? d.h : []).slice(0, duree).map(meteoValide),
    stocks: triple(d.s),
    besoin: triple(d.b),
    planches: entier(d.pl),
    objectif: entier(d.o, 0, 200),
    aBord: entier(d.a),
  };
}

// ── Icônes ─────────────────────────────────────────────────────────

function soleil(x, y, r) {
  let rayons = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    rayons += `<line x1="${x + Math.cos(a) * r * 1.3}" y1="${y + Math.sin(a) * r * 1.3}" x2="${x + Math.cos(a) * r * 1.7}" y2="${y + Math.sin(a) * r * 1.7}" stroke="${C.soleil}" stroke-width="${r * 0.22}" stroke-linecap="round"/>`;
  }
  return `${rayons}<circle cx="${x}" cy="${y}" r="${r}" fill="${C.soleil}"/>`;
}
const nuage = (x, y, r, couleur = C.nuage) =>
  `<g fill="${couleur}"><circle cx="${x - r * 0.7}" cy="${y + r * 0.15}" r="${r * 0.65}"/><circle cx="${x + r * 0.1}" cy="${y - r * 0.25}" r="${r * 0.85}"/><circle cx="${x + r * 0.85}" cy="${y + r * 0.2}" r="${r * 0.6}"/><rect x="${x - r * 1.3}" y="${y + r * 0.1}" width="${r * 2.7}" height="${r * 0.7}" rx="${r * 0.35}"/></g>`;
const pluie = (x, y, r) =>
  nuage(x, y - r * 0.2, r) +
  [-0.8, 0, 0.8]
    .map((dx) => `<line x1="${x + dx * r}" y1="${y + r * 0.85}" x2="${x + dx * r - r * 0.25}" y2="${y + r * 1.4}" stroke="${C.eau}" stroke-width="${r * 0.2}" stroke-linecap="round"/>`)
    .join("");
const orage = (x, y, r) =>
  nuage(x, y - r * 0.2, r, C.orage) +
  `<path d="M ${x + r * 0.1} ${y + r * 0.5} L ${x - r * 0.35} ${y + r * 1.15} L ${x + r * 0.05} ${y + r * 1.1} L ${x - r * 0.2} ${y + r * 1.7} L ${x + r * 0.5} ${y + r * 0.9} L ${x + r * 0.1} ${y + r * 0.95} Z" fill="${C.soleil}"/>`;

// `r` : rayon de la place disponible
export function iconeMeteo(id, x, y, r) {
  if (id === "soleil") return soleil(x, y, r * 0.62);
  if (id === "nuages") return nuage(x, y, r * 0.7);
  if (id === "pluie") return pluie(x, y, r * 0.65);
  if (id === "tempete") return orage(x, y, r * 0.65);
  return "";
}

const poisson = (x, y, s) =>
  `<g fill="${C.poisson}"><ellipse cx="${x}" cy="${y}" rx="${s * 0.55}" ry="${s * 0.32}"/><path d="M ${x + s * 0.45} ${y} L ${x + s * 0.85} ${y - s * 0.3} L ${x + s * 0.85} ${y + s * 0.3} Z"/></g><circle cx="${x - s * 0.28}" cy="${y - s * 0.06}" r="${s * 0.07}" fill="${C.fond}"/>`;
const goutte = (x, y, s) =>
  `<path d="M ${x} ${y - s * 0.5} C ${x + s * 0.45} ${y}, ${x + s * 0.4} ${y + s * 0.45}, ${x} ${y + s * 0.45} C ${x - s * 0.4} ${y + s * 0.45}, ${x - s * 0.45} ${y}, ${x} ${y - s * 0.5} Z" fill="${C.eau}"/>`;
const buche = (x, y, s) =>
  `<rect x="${x - s * 0.55}" y="${y - s * 0.22}" width="${s * 1.0}" height="${s * 0.44}" rx="${s * 0.1}" fill="${C.bois}"/><ellipse cx="${x + s * 0.45}" cy="${y}" rx="${s * 0.16}" ry="${s * 0.22}" fill="${C.boisClair}"/>`;

// Icône de ressource et ses bords (fraction de sa taille), pour un écart
// constant entre l'icône et le chiffre qui la suit
const RESSOURCES = [
  { icone: poisson, gauche: 0.55, droite: 0.85 },
  { icone: goutte, gauche: 0.45, droite: 0.45 },
  { icone: buche, gauche: 0.55, droite: 0.61 },
];

const texte = (x, y, txt, taille, { fill = C.texte, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${taille}" font-family="${FONT_FAMILY}" font-weight="700" fill="${fill}" text-anchor="${anchor}">${txt}</text>`;

// ── Blocs ──────────────────────────────────────────────────────────

function bandeau(p) {
  let s = texte(28, 58, "ROBINSON", 40);
  const pas = Math.min(62, 420 / Math.max(1, p.duree - 1));
  for (let j = 1; j <= p.duree; j++) {
    const x = 330 + (j - 1) * pas;
    const y = 42;
    const courant = j === p.jour;
    const demain = j === p.jour + 1;
    s += `<circle cx="${x}" cy="${y}" r="26" fill="${courant ? C.panneau : "none"}" stroke="${courant ? C.soleil : C.panneau}" stroke-width="${courant ? 4 : 2}"${demain ? ' stroke-dasharray="6 5"' : ""}/>`;
    const m = j < p.jour ? p.passees[j - 1] : courant ? p.meteo : demain ? p.prevision : null;
    s += m ? iconeMeteo(m, x, y, 21) : texte(x, y + 13, "?", 36, { anchor: "middle", fill: C.doux });
  }
  return s + texte(872, 58, `J${p.jour}/${p.duree}`, 40, { anchor: "end" });
}

// Rendement par joueur selon la météo du jour (config passée par l'appelant)
function aujourdhui(p, rendements) {
  let s = `<rect x="20" y="92" width="560" height="190" rx="22" fill="${C.panneau}"/>`;
  s += iconeMeteo(p.meteo, 112, 187, 78);
  s += texte(200, 160, NOMS[p.meteo], 52);
  let curseur = 196;
  RESSOURCES.forEach((r, i) => {
    const x = curseur + r.gauche * 52;
    const xt = x + r.droite * 52 + 12;
    s += r.icone(x, 230, 52) + texte(xt, 246, `${rendements[i]}`, 44);
    curseur = xt + 28 + 30;
  });
  return s;
}

function demain(p) {
  let s = `<rect x="596" y="92" width="284" height="190" rx="22" fill="none" stroke="${C.panneau}" stroke-width="4" stroke-dasharray="12 8"/>`;
  if (!p.prevision) return s + texte(738, 200, "Dernier jour", 36, { anchor: "middle", fill: C.doux });
  return s + texte(738, 138, "Demain ?", 36, { anchor: "middle", fill: C.doux }) + iconeMeteo(p.prevision, 738, 210, 66);
}

function stocks(p) {
  return RESSOURCES.map((r, i) => {
    const v = p.stocks[i];
    const b = p.besoin[i];
    const x0 = 20 + i * 293;
    const w = 274;
    let s = `<rect x="${x0}" y="298" width="${w}" height="150" rx="22" fill="${C.panneau}"/>`;
    s += r.icone(x0 + 48, 345, 58);
    s += texte(x0 + 48 + r.droite * 58 + 14, 362, `${v}`, 48, { fill: v === 0 ? C.rouge : C.texte });
    if (b > 0) s += texte(x0 + w - 18, 362, `−${b}`, 36, { anchor: "end", fill: C.doux });
    const couleur = v === 0 ? C.rouge : v < b ? C.orange : C.vert;
    const max = Math.max(v, b) * 1.25 || 1;
    const bw = w - 40;
    s += `<rect x="${x0 + 20}" y="390" width="${bw}" height="22" rx="11" fill="${C.fond}"/>`;
    s += `<rect x="${x0 + 20}" y="390" width="${Math.max(0, (bw * v) / max)}" height="22" rx="11" fill="${couleur}"/>`;
    if (b > 0) {
      const bx = x0 + 20 + (bw * b) / max;
      s += `<line x1="${bx}" y1="382" x2="${bx}" y2="420" stroke="${C.texte}" stroke-width="5"/>`;
    }
    return s;
  }).join("");
}

function radeau(p) {
  let s = `<rect x="20" y="464" width="860" height="118" rx="22" fill="${C.panneau}"/>`;
  const objectif = Math.max(p.objectif, 1);
  const pret = p.objectif > 0 && p.planches >= p.objectif;
  s += texte(42, 538, `${p.planches}/${p.objectif}`, 48, { fill: pret ? C.vert : C.texte });
  // Au-delà de 40 planches, une case représente plusieurs planches
  const cases = Math.min(objectif, 40);
  const parCase = objectif / cases;
  const x0 = 230;
  const largeur = pret ? 470 : 630;
  const pw = largeur / cases;
  for (let i = 0; i < cases; i++) {
    const pleine = p.planches >= (i + 1) * parCase - 1e-9;
    s += `<rect x="${x0 + i * pw + 1}" y="490" width="${Math.max(1, pw - 3)}" height="68" rx="3" fill="${pleine ? C.bois : C.fond}"/>`;
  }
  if (pret) s += texte(860, 538, `${p.aBord} à bord`, 40, { anchor: "end", fill: C.vert });
  return s;
}

export function buildPlateauSvg(p, config) {
  const rendements = ["poisson", "eau", "bois"].map((r) => config.meteos[p.meteo]?.rendements?.[r] ?? 0);
  const contenu = [bandeau(p), aujourdhui(p, rendements), demain(p), stocks(p), radeau(p)].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PLATEAU_L}" height="${PLATEAU_H}" viewBox="0 0 ${PLATEAU_L} ${PLATEAU_H}"><rect width="${PLATEAU_L}" height="${PLATEAU_H}" fill="${C.fond}"/>${contenu}</svg>`;
}

export async function getPlateauImage(plateau) {
  const config = await loadRobinsonConfig();
  const fontPaths = await readGameFontPaths();
  const rendu = new Resvg(texteAffichable(buildPlateauSvg(plateau, config)), {
    fitTo: { mode: "width", value: PLATEAU_L },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  }).render();
  const buffer = Buffer.from(jpeg.encode({ data: rendu.pixels, width: rendu.width, height: rendu.height }, QUALITE_JPEG).data);
  return { buffer, mimeType: "image/jpeg" };
}
