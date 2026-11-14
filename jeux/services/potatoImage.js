// ============================================================
// potatoImage.js — Images de Potato :
// - vue d'un joueur (éphémère) : thermomètre (avec les températures où la
//   patate a commencé à fumer puis à siffler), patate dont le visage suit la
//   chaleur (tiède, fume, siffle), pastille de l'événement de son tour ;
// - vue publique (salon) : les deux joueurs (couleur, manches gagnées,
//   patate chez celui qui la tient) et la barre des chauffes de la manche,
//   explosion au bout quand elle a eu lieu.
// Même technique que penduImage.js : SVG généré à la volée, rastérisé en PNG
// via @resvg/resvg-js, police Inter embarquée (Vercel Blob).
//
// Rendu sans état : l'état est passé dans l'URL (encodeVue, encodePublic).
// ⚠️ Anti-spoiler : l'URL ne contient JAMAIS le seuil ; seule la vue de
// celui qui a tiré le Thermomètre (éphémère) contient sa fourchette.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { texteAffichable, tronquer } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import { GLACON, SEUIL_MAX, SEUIL_MIN, TEMP_DEPART } from "./potatoRules.js";

const FONT_FAMILY = "Inter";

const FOND = "#2b2233";
const PANNEAU = "#3a2f45";
const CRAIE = "#f5efe6";
const GRIS = "#a99bb5";
const ROUGE = "#e53935";
const DANGER = "#ff5252";
// Couleur de chaque siège : joueur (à gauche), bot / 2ᵉ joueur (à droite)
export const COULEURS = ["#4fc3f7", "#f06292"];

const ETATS = {
  froide: { corps: "#d9a65b", ombre: "#a8743a" },
  // Courant d'air : état caché (couleur neutre, ni visage ni vapeur)
  cache: { corps: "#b9a48a", ombre: "#7d6a55" },
  fume: { corps: "#e58e45", ombre: "#b05f22" },
  siffle: { corps: "#e2533a", ombre: "#9e2c1d" },
};
const CODES_ETAT = { froide: "f", fume: "u", siffle: "s", cache: "c" };
const CODES_EVENEMENT = { glacon: "g", piment: "p", thermo: "t", gants: "a", retour: "r", courant: "c", impose: "i" };
const inverse = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// La police embarquée n'a pas d'emoji : retirés des pseudos
const sansEmoji = (nom) => String(nom).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim() || "?";

const texte = (x, y, contenu, { size = 20, fill = CRAIE, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" fill="${fill}">${escapeXml(contenu)}</text>`;

const cadre = (w, h, contenu) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="24" fill="${FOND}"/>${contenu}</svg>`;

// ── Encodage dans l'URL ─────────────────────────────────────────────
// Vue : { t: température, e: état (f, u, s), v: événement ("" ou g, o, t,
//   a), l / h : fourchette du Thermomètre (connue du joueur jusqu'à la fin
//   de la manche), f / s :
//   température à laquelle la patate a commencé à fumer / siffler }.
// Public : { n: [pseudo gauche, pseudo droite], m: [manches], c: chauffes
//   "côté:degrés,…", h: côté qui tient la patate (-1 : personne), x: côté
//   qui l'a fait exploser (-1 : en cours), p: 1 pour la patate qui fume en
//   décoration (message final) }.

const versUrl = (d) => Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
function depuisUrl(param) {
  try {
    return JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const borner = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));

export function encodeVue({ temp, etat, evenement = null, fourchette = null, fume = null, siffle = null }) {
  return versUrl({
    t: temp,
    e: CODES_ETAT[etat],
    v: CODES_EVENEMENT[evenement] ?? "",
    ...(fourchette ? { l: fourchette.lo, h: fourchette.hi } : {}),
    ...(fume != null ? { f: fume } : {}),
    ...(siffle != null ? { s: siffle } : {}),
  });
}

// null si le paramètre est illisible.
export function decodeVue(param) {
  const d = depuisUrl(param);
  const etat = inverse(CODES_ETAT)[d?.e];
  if (!d || !etat) return null;
  const evenement = inverse(CODES_EVENEMENT)[d.v] ?? null;
  return {
    temp: borner(d.t, TEMP_DEPART, 200),
    etat,
    evenement,
    fourchette: d.l != null && d.h != null ? { lo: borner(d.l, SEUIL_MIN, SEUIL_MAX), hi: borner(d.h, SEUIL_MIN, SEUIL_MAX) } : null,
    fume: d.f != null ? borner(d.f, TEMP_DEPART, SEUIL_MAX) : null,
    siffle: d.s != null ? borner(d.s, TEMP_DEPART, SEUIL_MAX) : null,
  };
}

export function encodePublic({ noms, manches, chauffes, tient = -1, explose = -1, deco = false }) {
  return versUrl({
    n: noms.map((n) => tronquer(sansEmoji(n), 16)),
    m: manches,
    c: chauffes.map(([j, v]) => `${j}:${v}`).join(","),
    h: tient,
    x: explose,
    ...(deco ? { p: 1 } : {}),
  });
}

export function decodePublic(param) {
  const d = depuisUrl(param);
  if (!d || !Array.isArray(d.n) || d.n.length !== 2 || !Array.isArray(d.m) || typeof d.c !== "string") return null;
  const chauffes = d.c
    ? d.c.split(",").slice(0, 60).map((s) => s.split(":").map(Number)).filter(([j, v]) => (j === 0 || j === 1) && v > 0 && v <= 30)
    : [];
  const cote = (v) => ([0, 1].includes(v) ? v : -1);
  return {
    noms: d.n.map((n) => tronquer(sansEmoji(n), 16)),
    manches: d.m.map((n) => borner(n, 0, 2)),
    chauffes,
    tient: cote(d.h),
    explose: cote(d.x),
    deco: d.p === 1,
  };
}

// ── Dessins ─────────────────────────────────────────────────────────

const CONTOUR = "M -80 -8 C -86 -52 -24 -68 22 -60 C 66 -54 90 -26 84 12 C 80 50 34 66 -10 60 C -56 56 -76 32 -80 -8 Z";

// Patate : corps, taches, reflet ; visage, vapeur et tremblements selon l'état
function patate(cx, cy, etat, s = 1, { visage = true } = {}) {
  const e = ETATS[etat];
  const yeux = {
    froide: `<circle cx="-22" cy="-8" r="6" fill="#3b2412"/><circle cx="18" cy="-10" r="6" fill="#3b2412"/>
      <path d="M -16 14 Q -2 26 14 13" stroke="#3b2412" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    fume: `<circle cx="-22" cy="-8" r="6" fill="#3b2412"/><circle cx="18" cy="-10" r="6" fill="#3b2412"/>
      <path d="M -14 18 Q -1 10 12 18" stroke="#3b2412" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M 42 -30 q 7 12 0 18 q -7 -6 0 -18 Z" fill="#7fd3ff"/>`,
    siffle: `<circle cx="-22" cy="-10" r="10" fill="#fff"/><circle cx="-22" cy="-10" r="4" fill="#3b2412"/>
      <circle cx="18" cy="-12" r="10" fill="#fff"/><circle cx="18" cy="-12" r="4" fill="#3b2412"/>
      <ellipse cx="-2" cy="20" rx="8" ry="10" fill="#3b2412"/>`,
    // Courant d'air : un « ? » à la place du visage, rafales de vent
    cache: `<text x="0" y="22" font-family="${FONT_FAMILY}" font-size="64" text-anchor="middle" fill="#5d4a36">?</text>
      <path d="M -125 -40 q 22 -12 44 0 t 44 0 M -128 0 q 22 -12 44 0 M -125 40 q 22 -12 44 0 t 44 0" stroke="#cfe8f5" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.8"/>`,
  }[etat];
  const vapeur =
    etat === "froide" || etat === "cache" || !visage
      ? ""
      : [-30, 0, 30]
          .slice(0, etat === "fume" ? 2 : 3)
          .map((dx, i) => `<path d="M ${dx} -68 c -10 -12 10 -18 0 -30 c -10 -12 10 -18 0 -30" stroke="#fff" stroke-opacity="${0.75 - i * 0.15}" stroke-width="6" fill="none" stroke-linecap="round"/>`)
          .join("");
  const secousse =
    etat === "siffle" && visage
      ? `<path d="M -98 -20 l -18 -6 M -100 6 l -22 0 M -96 30 l -18 8 M 98 -24 l 18 -6 M 100 4 l 22 0 M 96 28 l 18 8" stroke="${DANGER}" stroke-width="5" stroke-linecap="round"/>`
      : "";
  return `<g transform="translate(${cx} ${cy}) scale(${s})">
    ${vapeur}${secousse}
    <ellipse cx="4" cy="66" rx="70" ry="10" fill="#000" opacity="0.25"/>
    <path d="${CONTOUR}" fill="${e.corps}" stroke="${e.ombre}" stroke-width="5"/>
    <path d="M -58 -30 C -50 -48 -24 -54 -6 -52" stroke="#fff" stroke-opacity="0.35" stroke-width="8" fill="none" stroke-linecap="round"/>
    <ellipse cx="-50" cy="24" rx="7" ry="5" fill="${e.ombre}"/><ellipse cx="54" cy="-22" rx="6" ry="4" fill="${e.ombre}"/>
    <ellipse cx="44" cy="34" rx="5" ry="4" fill="${e.ombre}"/>
    ${visage ? yeux : ""}
  </g>`;
}

// Étoile d'explosion (et éclats de patate) centrée en (cx, cy), à l'échelle s
function explosion(cx, cy, s = 1) {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 62 : 118;
    const a = (i / 24) * Math.PI * 2;
    pts.push([r * Math.cos(a), r * Math.sin(a) * 0.85]);
  }
  const poly = (k) => pts.map(([x, y]) => `${(x * k).toFixed(1)},${(y * k).toFixed(1)}`).join(" ");
  const eclats = [[-120, -60], [125, -50], [-110, 70], [118, 66], [0, -120], [-20, 110]]
    .map(([dx, dy], i) => `<ellipse cx="${dx}" cy="${dy}" rx="${10 + (i % 3) * 3}" ry="${7 + (i % 2) * 3}" fill="#e2b265" stroke="#a8743a" stroke-width="3" transform="rotate(${i * 37} ${dx} ${dy})"/>`)
    .join("");
  return `<g transform="translate(${cx} ${cy}) scale(${s})"><polygon points="${poly(1)}" fill="#ff7043"/><polygon points="${poly(0.6)}" fill="#ffd54f"/>${eclats}</g>`;
}

// Thermomètre vertical (TEMP_DEPART à 140 °C), zone d'explosion possible
// en rouge ; à gauche, repères de la température à laquelle la patate a
// commencé à fumer (orange), puis à siffler (rouge).
const T_HAUT = 140;
const Y_BAS = 300;
const Y_HAUT = 70;
const yTemp = (t) => Y_BAS - ((Math.min(t, T_HAUT) - TEMP_DEPART) / (T_HAUT - TEMP_DEPART)) * (Y_BAS - Y_HAUT);
const FUMEE = "#ffb74d";

// Petite fumée (n volutes) dont le bas est en (x, y)
const volutes = (x, y, n, couleur) =>
  Array.from({ length: n }, (_, i) => `<path d="M ${x + i * 7} ${y} c -4 -4 4 -6 0 -10 c -4 -4 4 -6 0 -10" stroke="${couleur}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`).join("");

function repere(x, t, dy, couleur, n) {
  const y = yTemp(t);
  return `<line x1="${x - 40}" y1="${y}" x2="${x - 14}" y2="${y}" stroke="${couleur}" stroke-width="4" stroke-linecap="round"/>
    ${texte(x - 46, y + 6 + dy, `${t}°`, { size: 16, fill: couleur, anchor: "end" })}${volutes(x - 104, y + 9 + dy, n, couleur)}`;
}

// Fourchette du Thermomètre : bande jaune sur le tube, du bas au haut
function bandeFourchette(x, { lo, hi }) {
  const [y1, y2] = [yTemp(hi), yTemp(lo)];
  return `<rect x="${x - 21}" y="${y1 - 3}" width="42" height="${y2 - y1 + 6}" rx="8" fill="none" stroke="#ffd54f" stroke-width="4"/>`;
}

function thermometre(temp, { fume = null, siffle = null, fourchette = null } = {}) {
  const x = 120;
  const grads = [40, 60, 80, 100, 120, 140]
    .map((t) => `<line x1="${x + 18}" y1="${yTemp(t)}" x2="${x + 28}" y2="${yTemp(t)}" stroke="${GRIS}" stroke-width="3"/>${texte(x + 34, yTemp(t) + 6, `${t}°`, { size: 16, fill: GRIS })}`)
    .join("");
  // Repères trop proches : celui du sifflement remonte d'un cran
  const ecart = fume != null && siffle != null && siffle !== fume && yTemp(fume) - yTemp(siffle) < 20 ? -(20 - (yTemp(fume) - yTemp(siffle))) : 0;
  const reperes = [
    fume != null && fume !== siffle ? repere(x, fume, 0, FUMEE, 2) : "",
    siffle != null ? repere(x, siffle, ecart, DANGER, 3) : "",
  ].join("");
  return `
    <rect x="${x - 30}" y="${yTemp(SEUIL_MAX)}" width="60" height="${yTemp(SEUIL_MIN) - yTemp(SEUIL_MAX)}" rx="8" fill="${DANGER}" opacity="0.28"/>
    <rect x="${x - 14}" y="${Y_HAUT - 10}" width="28" height="${Y_BAS - Y_HAUT + 30}" rx="14" fill="#ece3f0"/>
    <rect x="${x - 7}" y="${yTemp(temp)}" width="14" height="${Y_BAS + 20 - yTemp(temp)}" rx="7" fill="${ROUGE}"/>
    <circle cx="${x}" cy="${Y_BAS + 34}" r="24" fill="#ece3f0"/><circle cx="${x}" cy="${Y_BAS + 34}" r="17" fill="${ROUGE}"/>
    ${grads}${reperes}${fourchette ? bandeFourchette(x, fourchette) : ""}`;
}

const ICONES = {
  glacon: (x, y) => `<rect x="${x - 13}" y="${y - 13}" width="26" height="26" rx="6" fill="#b3e5fc" stroke="#4fc3f7" stroke-width="3" transform="rotate(12 ${x} ${y})"/>`,
  // Piment : gousse rouge courbée, queue verte
  piment: (x, y) =>
    `<path d="M ${x - 9} ${y - 9} C ${x + 4} ${y - 12} ${x + 13} ${y - 4} ${x + 11} ${y + 6} C ${x + 9} ${y + 13} ${x + 2} ${y + 17} ${x - 6} ${y + 16} C ${x + 2} ${y + 11} ${x + 3} ${y + 4} ${x - 1} ${y - 1} C ${x - 4} ${y - 4} ${x - 8} ${y - 4} ${x - 9} ${y - 9} Z" fill="#e53935"/><path d="M ${x - 9} ${y - 9} q -2 -6 3 -9" stroke="#66bb6a" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
  thermo: (x, y) => `<rect x="${x - 4}" y="${y - 16}" width="8" height="24" rx="4" fill="#ece3f0"/><circle cx="${x}" cy="${y + 10}" r="7" fill="${ROUGE}"/>`,
  retour: (x, y) =>
    `<path d="M ${x + 11} ${y - 4} A 12 12 0 1 0 ${x + 8} ${y + 9}" stroke="#ffd54f" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M ${x + 4} ${y - 9} L ${x + 13} ${y - 6} L ${x + 15} ${y - 15} Z" fill="#ffd54f"/>`,
  courant: (x, y) =>
    `<path d="M ${x - 14} ${y - 7} q 10 -6 20 0 q 6 4 10 -2 M ${x - 14} ${y + 1} h 24 M ${x - 14} ${y + 9} q 10 6 20 0" stroke="#cfe8f5" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
  impose: (x, y) =>
    `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="${DANGER}" stroke-width="3.5"/><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${DANGER}" stroke-width="3.5"/><circle cx="${x}" cy="${y}" r="2.5" fill="${DANGER}"/>`,
  gants: (x, y) =>
    `<path d="M ${x - 10} ${y + 15} L ${x - 10} ${y - 4} Q ${x - 10} ${y - 15} ${x - 4} ${y - 15} L ${x + 6} ${y - 15} Q ${x + 11} ${y - 15} ${x + 11} ${y - 8} L ${x + 11} ${y + 15} Z" fill="#81c784" stroke="#388e3c" stroke-width="3"/>`,
};

function libelleEvenement(evenement, fourchette) {
  if (evenement === "glacon") return `Glaçon : −${GLACON} °C`;
  if (evenement === "piment") return "Piment : double chauffe";
  if (evenement === "thermo") return `Explosion : ${fourchette?.lo} à ${fourchette?.hi} °C`;
  if (evenement === "retour") return "Retour : tu rejoues après";
  if (evenement === "courant") return "Courant d'air : état caché";
  if (evenement === "impose") return "Chauffe imposée : +10 °C";
  return "Gants : renvoi brûlant";
}

// ── Vue d'un joueur ─────────────────────────────────────────────────

const VUE_L = 500;
const VUE_H = 380;

export function buildVueSvg({ temp, etat, evenement = null, fourchette = null, fume = null, siffle = null }) {
  const pastille = evenement
    ? `<rect x="196" y="306" width="270" height="52" rx="26" fill="${PANNEAU}"/>${ICONES[evenement](224, 332)}${texte(248, 339, libelleEvenement(evenement, fourchette), { size: 17 })}`
    : "";
  return cadre(VUE_L, VUE_H, `${thermometre(temp, { fume, siffle, fourchette })}${patate(335, evenement ? 180 : 200, etat, 1.0)}${pastille}`);
}

// ── Vue publique ────────────────────────────────────────────────────

const PUB_L = 760;
const PUB_H = 230;
const BAR_MAX = 150;

const jeton = (x, y, plein) =>
  `<g transform="translate(${x} ${y}) scale(0.16)"><path d="${CONTOUR}" ${plein ? 'fill="#d9a65b" stroke="#a8743a"' : `fill="none" stroke="${GRIS}" stroke-dasharray="20 14"`} stroke-width="10"/></g>`;

export function buildPublicSvg({ noms, manches, chauffes, tient = -1, explose = -1, deco = false }) {
  const x0 = 60;
  const x1 = 700;
  const yb = 155;
  const xT = (t) => x0 + ((Math.min(t, BAR_MAX) - TEMP_DEPART) / (BAR_MAX - TEMP_DEPART)) * (x1 - x0);
  let t = TEMP_DEPART;
  const segments = chauffes
    .map(([j, v]) => {
      const a = xT(t);
      const b = xT(t + v);
      t += v;
      if (b - a < 4) return "";
      const etroit = b - a <= 34;
      return `<rect x="${(a + 1.5).toFixed(1)}" y="${yb - 18}" width="${(b - a - 3).toFixed(1)}" height="36" rx="6" fill="${COULEURS[j]}"/>${
        b - a > 20 ? texte((a + b) / 2, yb + 6, `+${v}`, { size: etroit ? 13 : 15, fill: "#1b1320", anchor: "middle" }) : ""
      }`;
    })
    .join("");
  const grads = [40, 60, 80, 100, 120, 140].map((g) => texte(xT(g), yb + 46, `${g}°`, { size: 14, fill: GRIS, anchor: "middle" })).join("");
  const boum = explose >= 0 ? explosion(xT(t), yb, 0.32) : "";
  const cote = (j) => {
    const gauche = j === 0;
    const x = gauche ? 40 : PUB_L - 40;
    const anchor = gauche ? "start" : "end";
    const mot = explose === j ? ["se brûle", "#ff8a80"] : explose >= 0 ? ["gagne la manche", "#9ccc65"] : null;
    return `${texte(x, 50, noms[j], { size: 22, fill: COULEURS[j], anchor })}
      ${jeton(gauche ? x + 14 : x - 50, 84, manches[j] >= 1)}${jeton(gauche ? x + 48 : x - 16, 84, manches[j] >= 2)}
      ${tient === j && explose < 0 ? patate(gauche ? x + 110 : x - 110, 74, "froide", 0.3) : ""}
      ${mot ? texte(gauche ? x + 84 : x - 84, 90, mot[0], { size: 15, fill: mot[1], anchor }) : ""}`;
  };
  return cadre(
    PUB_L,
    PUB_H,
    `${deco ? patate(PUB_L / 2, 74, "fume", 0.5) : ""}${cote(0)}${cote(1)}
    <rect x="${xT(SEUIL_MIN)}" y="${yb - 26}" width="${xT(SEUIL_MAX) - xT(SEUIL_MIN)}" height="52" rx="8" fill="${DANGER}" opacity="0.16" stroke="${DANGER}" stroke-opacity="0.5" stroke-dasharray="6 5"/>
    <rect x="${x0}" y="${yb - 18}" width="${x1 - x0}" height="36" rx="8" fill="#ffffff" opacity="0.06"/>
    ${segments}${boum}${grads}`,
  );
}

async function rasterize(svg, largeur) {
  const fontPaths = await readGameFontPaths();
  const resvg = new Resvg(Buffer.from(texteAffichable(svg), "utf8"), {
    fitTo: { mode: "width", value: largeur },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

export const getVueImage = (vue) => rasterize(buildVueSvg(vue), VUE_L);
export const getPublicImage = (pub) => rasterize(buildPublicSvg(pub), PUB_L);
