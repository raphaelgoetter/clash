// ============================================================
// robinsonImage.js — Plateau du jour de Robinson (message public) :
// - frise des jours (événements passés, du jour et annoncé pour demain,
//   Grosse Houle, appauvrissement de l'île, arrivée des secours) ;
// - stocks avec le besoin de la nuit et les jours à 0 ;
// - Radeau (sections, points du jour sur le plafond) et constructions ;
// - récolte du jour (borne, Explorer, épuisement de chaque action).
// Même technique que potatoImage.js : SVG généré à la volée, rastérisé en
// PNG via @resvg/resvg-js, police Inter embarquée (Vercel Blob).
//
// Rendu sans état : l'état dynamique est passé dans l'URL (encodePlateau),
// le reste vient de la config (robinson.json). L'URL change avec l'état, ce
// qui contourne le cache de Discord à chaque rafraîchissement du message.
// ⚠️ Anti-spoiler : seuls les événements déjà vus et celui de demain sont
// encodés, jamais le reste du programme.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { texteAffichable } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import {
  loadRobinsonConfig,
  computeAppauvrissement,
  harvestMaxForDay,
  computeEpuisementMalus,
  computeExplorerAmount,
  computeRaftSections,
  computeRadeauPlafondJour,
  isConstructionDone,
  isRadeauDisabled,
  harvestCapForEvent,
  constructionHarvestBonus,
} from "./robinson.js";

const FONT_FAMILY = "Inter";
export const PLATEAU_L = 800;
const PLATEAU_H = 628;

const FOND = "#0f3440";
const PANNEAU = "#16495a";
const CRAIE = "#f5efe6";
const GRIS = "#9fbcc4";
const SABLE = "#e9c98b";
const VERT = "#7cc96b";
const ORANGE = "#ffb74d";
const ROUGE = "#ff6b6b";
const BOIS = "#b5814b";
const BOIS_SOMBRE = "#7a5230";
const MER = "#4fc3f7";

const RESSOURCES = [
  { id: "poisson", label: "Nourriture" },
  { id: "eau", label: "Eau" },
  { id: "bois", label: "Bois" },
];
const RECOLTES = ["peche", "eau", "bois", "explorer"];

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const texte = (x, y, contenu, { size = 20, fill = CRAIE, anchor = "start", opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ""}>${escapeXml(contenu)}</text>`;

// ── Encodage dans l'URL ─────────────────────────────────────────────
// { j: jour, s: [poisson, eau, bois], b: besoin de la nuit [p, e, b],
//   z: jours consécutifs à 0 [p, e, b], r: points de Radeau, rj: points du
//   jour, c: { id: points } des constructions, e: { jour: eventId } des
//   événements vus et de celui annoncé pour demain, k: récoltes du jour par
//   action { peche, eau, bois, explorer }, p: palier d'épuisement,
//   x: 1 si Explorer est bloqué (Gobelins) }.

const versUrl = (d) => Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
function depuisUrl(param) {
  try {
    return JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
const entier = (n, min = 0, max = 9999) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
const triple = (a) => [0, 1, 2].map((i) => entier(a?.[i]));

export function encodePlateau({ jour, stocks, besoin, zeroStreaks, radeauPoints, radeauJour, constructions, evenements, zones, palier, explorerBloque }) {
  return versUrl({
    j: jour,
    s: RESSOURCES.map((r) => stocks?.[r.id] ?? 0),
    b: RESSOURCES.map((r) => besoin?.[r.id] ?? 0),
    z: RESSOURCES.map((r) => zeroStreaks?.[r.id] ?? 0),
    r: radeauPoints ?? 0,
    rj: radeauJour ?? 0,
    c: constructions ?? {},
    e: evenements ?? {},
    k: zones ?? {},
    p: palier ?? null,
    x: explorerBloque ? 1 : 0,
  });
}

export function decodePlateau(param) {
  const d = depuisUrl(param);
  if (!d || typeof d !== "object") return null;
  const objetEntiers = (o, cles) =>
    Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k]) => !cles || cles.includes(k)).map(([k, v]) => [k, entier(v)]));
  const evenements = Object.fromEntries(
    Object.entries(d.e && typeof d.e === "object" ? d.e : {})
      .filter(([k, v]) => /^\d{1,2}$/.test(k) && typeof v === "string" && /^[a-z_]{1,40}$/.test(v))
      .map(([k, v]) => [Number(k), v]),
  );
  return {
    jour: entier(d.j, 1, 30),
    stocks: triple(d.s),
    besoin: triple(d.b),
    zeroStreaks: triple(d.z),
    radeauPoints: entier(d.r),
    radeauJour: entier(d.rj),
    constructions: objetEntiers(d.c),
    evenements,
    zones: objetEntiers(d.k, RECOLTES),
    palier: d.p == null ? null : entier(d.p, 1, 99),
    explorerBloque: d.x === 1,
  };
}

// ── Icônes (vectorielles : la police embarquée n'a pas d'emoji en couleur) ──

const ICONES = {
  poisson: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><path d="M -18 0 C -8 -12 10 -12 18 0 C 10 12 -8 12 -18 0 Z" fill="${MER}"/><path d="M 16 0 L 28 -10 L 28 10 Z" fill="${MER}"/><circle cx="-8" cy="-2" r="2.6" fill="${FOND}"/></g>`,
  eau: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><path d="M 0 -20 C 8 -8 14 0 14 7 C 14 15 7 20 0 20 C -7 20 -14 15 -14 7 C -14 0 -8 -8 0 -20 Z" fill="#81d4fa"/><path d="M -6 6 C -6 11 -3 14 1 14" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.7"/></g>`,
  bois: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-22" y="-9" width="40" height="18" rx="9" fill="${BOIS}"/><ellipse cx="18" cy="0" rx="7" ry="9" fill="${SABLE}"/><ellipse cx="18" cy="0" rx="3" ry="4" fill="${BOIS_SOMBRE}"/></g>`,
  explorer: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><circle cx="-4" cy="-4" r="12" fill="none" stroke="${SABLE}" stroke-width="5"/><path d="M 5 5 L 16 16" stroke="${SABLE}" stroke-width="6" stroke-linecap="round"/></g>`,
  filet: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><path d="M -18 -14 L 18 -14 L 12 16 L -12 16 Z" fill="none" stroke="${SABLE}" stroke-width="3"/><path d="M -6 -14 L -4 16 M 6 -14 L 4 16 M -16 -4 L 16 -4 M -14 6 L 14 6" stroke="${SABLE}" stroke-width="2"/></g>`,
  citerne: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-15" y="-17" width="30" height="34" rx="6" fill="${BOIS}"/><path d="M -15 -7 L 15 -7 M -15 7 L 15 7" stroke="${BOIS_SOMBRE}" stroke-width="3"/><path d="M 0 -3 C 3 1 4 3 4 5 C 4 7 2 8 0 8 C -2 8 -4 7 -4 5 C -4 3 -3 1 0 -3 Z" fill="#81d4fa"/></g>`,
  atelier: (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><path d="M -18 6 L 12 -12 L 18 -2 L -12 16 Z" fill="#cfd8dc"/><path d="M -12 16 L -6 12 M -6 12 L -2 15 M -2 10 L 2 13 M 2 8 L 6 11 M 6 6 L 10 9" stroke="#78909c" stroke-width="2"/><rect x="10" y="-18" width="10" height="16" rx="3" fill="${BOIS}" transform="rotate(-30 15 -10)"/></g>`,
};

// Icône d'événement (frise), centrée en (x, y)
const ICONES_EVENEMENT = {
  poissons_pourris: (x, y) => `${ICONES.poisson(x, y, 0.55)}<path d="M ${x - 10} ${y - 10} L ${x + 10} ${y + 10} M ${x + 10} ${y - 10} L ${x - 10} ${y + 10}" stroke="${ROUGE}" stroke-width="3.5" stroke-linecap="round"/>`,
  canicule: (x, y) =>
    `<circle cx="${x}" cy="${y}" r="7" fill="#ffca28"/>${Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return `<path d="M ${x + Math.cos(a) * 10} ${y + Math.sin(a) * 10} L ${x + Math.cos(a) * 14} ${y + Math.sin(a) * 14}" stroke="#ffca28" stroke-width="3" stroke-linecap="round"/>`;
    }).join("")}`,
  ouragan: (x, y) =>
    `<path d="M ${x + 12} ${y - 6} C ${x + 6} ${y - 14} ${x - 10} ${y - 12} ${x - 12} ${y} C ${x - 13} ${y + 10} ${x - 2} ${y + 14} ${x + 4} ${y + 8} C ${x + 9} ${y + 3} ${x + 5} ${y - 4} ${x} ${y - 3} C ${x - 4} ${y - 2} ${x - 4} ${y + 4} ${x} ${y + 4}" stroke="#b0bec5" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
  gobelins: (x, y) =>
    `<path d="M ${x - 9} ${y - 2} L ${x - 17} ${y - 9} L ${x - 8} ${y - 8} Z M ${x + 9} ${y - 2} L ${x + 17} ${y - 9} L ${x + 8} ${y - 8} Z" fill="#7cb342"/><circle cx="${x}" cy="${y}" r="10" fill="#8bc34a"/><circle cx="${x - 4}" cy="${y - 2}" r="2" fill="${FOND}"/><circle cx="${x + 4}" cy="${y - 2}" r="2" fill="${FOND}"/>`,
  indigestion_royale: (x, y) => `${ICONES.eau(x, y, 0.6)}<path d="M ${x - 10} ${y - 10} L ${x + 10} ${y + 10} M ${x + 10} ${y - 10} L ${x - 10} ${y + 10}" stroke="${ROUGE}" stroke-width="3.5" stroke-linecap="round"/>`,
  epave: (x, y) => `<rect x="${x - 14}" y="${y - 4}" width="28" height="8" rx="3" fill="${BOIS}" transform="rotate(-15 ${x} ${y})"/><rect x="${x - 12}" y="${y + 2}" width="22" height="7" rx="3" fill="${BOIS_SOMBRE}" transform="rotate(10 ${x} ${y})"/>`,
};

// Feuille d'automne (appauvrissement), centrée en (x, y)
const feuille = (x, y) =>
  `<path d="M ${x} ${y - 7} C ${x + 7} ${y - 5} ${x + 7} ${y + 4} ${x} ${y + 7} C ${x - 7} ${y + 4} ${x - 7} ${y - 5} ${x} ${y - 7} Z" fill="${ORANGE}"/><path d="M ${x} ${y - 5} L ${x} ${y + 9}" stroke="#a1662f" stroke-width="1.5"/>`;

// Bateau des secours (dernier nœud de la frise)
const bateau = (x, y) =>
  `<path d="M ${x - 16} ${y + 2} L ${x + 16} ${y + 2} L ${x + 10} ${y + 11} L ${x - 10} ${y + 11} Z" fill="${CRAIE}"/><path d="M ${x} ${y - 14} L ${x} ${y + 2} M ${x} ${y - 14} L ${x + 11} ${y - 1} L ${x} ${y - 1}" stroke="${CRAIE}" stroke-width="2.5" fill="none"/>`;

// ── Blocs du plateau ───────────────────────────────────────────────
// ⚠️ Lisibilité mobile : Discord réduit l'image à la largeur du message
// (≈ 360 px sur téléphone, soit ÷ 2,2 pour 800 px). Texte ≥ 26 px dans
// l'image, peu d'éléments, pas de libellé que l'icône suffit à porter.
// Vérifier tout changement sur un rendu réduit à 360 px de large.

function frise(p, config) {
  const n = config.duree_jours + 1;
  const x0 = 56;
  const x1 = PLATEAU_L - 56;
  const y = 58;
  const xJ = (j) => x0 + ((j - 1) * (x1 - x0)) / (n - 1);
  let svg = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${GRIS}" stroke-width="4" opacity="0.5"/>`;
  for (let j = 1; j <= n; j++) {
    const x = xJ(j);
    const secours = j === n;
    const courant = j === p.jour;
    const passe = j < p.jour;
    const connu = j <= p.jour + 1;
    const fill = courant ? SABLE : passe ? PANNEAU : FOND;
    svg += `<circle cx="${x}" cy="${y}" r="34" fill="${fill}" stroke="${courant ? SABLE : GRIS}" stroke-width="4"${!passe && !courant ? ' stroke-dasharray="7 5"' : ""}/>`;
    svg += secours
      ? `<g transform="translate(${x} ${y}) scale(1.5) translate(${-x} ${-y})">${bateau(x, y)}</g>`
      : texte(x, y + 10, `${j}`, { size: 30, fill: courant ? FOND : passe ? GRIS : CRAIE, anchor: "middle" });
    if (secours) continue;
    // Sous le nœud : événement (connu jusqu'à demain), feuilles d'appauvrissement
    const id = p.evenements[j];
    if (id && ICONES_EVENEMENT[id]) svg += `<g transform="translate(${x} ${y + 66}) scale(1.5) translate(${-x} ${-(y + 66)})">${ICONES_EVENEMENT[id](x, y + 66)}</g>`;
    else if (!connu) svg += texte(x, y + 78, "?", { size: 30, fill: GRIS, anchor: "middle", opacity: 0.7 });
    // Grosse Houle : vagues au-dessus du nœud
    if (connu && isRadeauDisabled(j, config.radeau_verrouille)) {
      svg += `<path d="M ${x - 30} ${y - 46} q 7.5 -9 15 0 t 15 0 t 15 0 t 15 0" stroke="${MER}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    }
    const malus = connu ? computeAppauvrissement(j, config) : 0;
    for (let i = 0; i < malus; i++) {
      const fx = x + 30 + i * 14;
      svg += `<g transform="translate(${fx} ${y + 66}) scale(1.3) translate(${-fx} ${-(y + 66)})">${feuille(fx, y + 66)}</g>`;
    }
  }
  return svg;
}

function stocks(p) {
  const x = 24;
  const y0 = 160;
  const largeur = 440;
  let svg = `<rect x="${x}" y="${y0}" width="${largeur}" height="330" rx="22" fill="${PANNEAU}"/>`;
  RESSOURCES.forEach((res, i) => {
    const y = y0 + 20 + i * 104;
    const stock = p.stocks[i];
    const besoin = p.besoin[i];
    const streak = p.zeroStreaks[i];
    const echelle = Math.max(10, besoin * 2, stock);
    const bx = x + 96;
    const bl = 210;
    const couleur = stock <= 0 ? ROUGE : besoin > 0 && stock < besoin ? ORANGE : VERT;
    svg += ICONES[res.id](x + 46, y + 33, 1.3);
    svg += texte(x + largeur - 22, y + 50, String(stock), { size: 52, fill: couleur, anchor: "end" });
    svg += `<rect x="${bx}" y="${y + 16}" width="${bl}" height="34" rx="17" fill="${FOND}"/>`;
    if (stock > 0) svg += `<rect x="${bx}" y="${y + 16}" width="${Math.max(34, (Math.min(stock, echelle) / echelle) * bl)}" height="34" rx="17" fill="${couleur}"/>`;
    if (besoin > 0) {
      const tx = bx + (Math.min(besoin, echelle) / echelle) * bl;
      svg += `<line x1="${tx}" y1="${y + 8}" x2="${tx}" y2="${y + 58}" stroke="${CRAIE}" stroke-width="5" stroke-linecap="round"/>`;
    }
    // Sous la barre : à 0 (prioritaire) ou besoin de la nuit
    if (streak > 0) svg += texte(bx, y + 86, `à 0 : ${streak} / 2 jours`, { size: 26, fill: ROUGE });
    else if (besoin > 0) svg += texte(bx, y + 86, `nuit −${besoin}`, { size: 26, fill: GRIS });
  });
  return svg;
}

function radeau(p, config) {
  const x = 484;
  const y = 160;
  const l = PLATEAU_L - x - 24;
  const total = config.points_par_section * config.radeau_sections_max;
  const sections = computeRaftSections(p.radeauPoints, config.points_par_section);
  const reste = p.radeauPoints - sections * config.points_par_section;
  const plafond = computeRadeauPlafondJour(config);
  const ferme = isRadeauDisabled(p.jour, config.radeau_verrouille);
  let svg = `<rect x="${x}" y="${y}" width="${l}" height="170" rx="22" fill="${PANNEAU}"/>`;
  svg += texte(x + 20, y + 48, `${Math.min(p.radeauPoints, total)}/${total}`, { size: 38, fill: SABLE });
  const ligne = ferme ? ["Houle", MER] : Number.isFinite(plafond) ? [`auj. ${Math.min(p.radeauJour, plafond)}/${plafond}`, p.radeauJour >= plafond ? ORANGE : GRIS] : null;
  if (ligne) svg += texte(x + l - 20, y + 46, ligne[0], { size: 26, fill: ligne[1], anchor: "end" });
  // Une planche par section : pleine, partielle ou vide
  const gap = 8;
  const pw = (l - 40 - (config.radeau_sections_max - 1) * gap) / config.radeau_sections_max;
  for (let s = 0; s < config.radeau_sections_max; s++) {
    const px = x + 20 + s * (pw + gap);
    const remplissage = s < sections ? 1 : s === sections ? reste / config.points_par_section : 0;
    svg += `<rect x="${px}" y="${y + 74}" width="${pw}" height="74" rx="10" fill="${FOND}" stroke="${BOIS_SOMBRE}" stroke-width="3"/>`;
    if (remplissage > 0) svg += `<rect x="${px}" y="${y + 74}" width="${Math.max(12, pw * remplissage)}" height="74" rx="10" fill="${BOIS}"/>`;
    if (s < sections) svg += `<path d="M ${px + 8} ${y + 98} L ${px + pw - 8} ${y + 98} M ${px + 8} ${y + 124} L ${px + pw - 8} ${y + 124}" stroke="${BOIS_SOMBRE}" stroke-width="3" opacity="0.6"/>`;
  }
  return svg;
}

function constructions(p, config) {
  const x = 484;
  const y = 346;
  const l = PLATEAU_L - x - 24;
  const entrees = Object.entries(config.constructions ?? {});
  let svg = `<rect x="${x}" y="${y}" width="${l}" height="144" rx="22" fill="${PANNEAU}"/>`;
  if (!entrees.length) return svg;
  const tw = l / entrees.length;
  entrees.forEach(([id, c], i) => {
    const cx = x + tw * i + tw / 2;
    const pts = p.constructions[id] ?? 0;
    const fini = isConstructionDone(pts, c);
    svg += (ICONES[id] ?? ICONES.atelier)(cx, y + 48, 1.6);
    svg += fini
      ? `<path d="M ${cx - 16} ${y + 106} l 11 11 l 22 -22" stroke="${VERT}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : texte(cx, y + 122, `${pts}/${c.cout}`, { size: 28, fill: pts > 0 ? SABLE : GRIS, anchor: "middle" });
  });
  return svg;
}

// Fourchette réelle du prochain récolteur sur `id` : tirage du jour (normal
// ou plafonné par l'événement), moins l'épuisement, plus Filet/Citerne.
function fourchette(id, malus, p, config, max) {
  const event = p.evenements[p.jour] ? { id: p.evenements[p.jour] } : null;
  const [lo, hi] = harvestCapForEvent(event, id) ? (event.id === "canicule" ? [0, 2] : [1, 2]) : [0, max];
  const bonus = constructionHarvestBonus(id, p.constructions, config.constructions);
  const a = Math.max(0, lo - malus) + bonus;
  const b = Math.max(0, hi - malus) + bonus;
  return a === b ? String(a) : `${a}-${b}`;
}

// Récolte du prochain votant sur chaque action (orange = zone épuisée)
function recolte(p, config) {
  const x = 24;
  const y = 508;
  const l = PLATEAU_L - 48;
  const max = harvestMaxForDay(p.jour, config);
  const appauv = computeAppauvrissement(p.jour, config);
  let svg = "";
  const gap = 14;
  const cw = (l - gap * (RECOLTES.length - 1)) / RECOLTES.length;
  RECOLTES.forEach((id, i) => {
    const cx0 = x + i * (cw + gap);
    const bloque = id === "explorer" && p.explorerBloque;
    const malus = computeEpuisementMalus((p.zones[id] ?? 0) + 1, p.palier);
    const icone = id === "peche" ? "poisson" : id;
    svg += `<rect x="${cx0}" y="${y}" width="${cw}" height="96" rx="20" fill="${PANNEAU}"${bloque ? ' opacity="0.45"' : ""}/>`;
    svg += ICONES[icone](cx0 + 46, y + 48, 1.4);
    const valeur = bloque
      ? "×"
      : id === "explorer"
        ? `${computeExplorerAmount(malus + appauv, config.epuisement?.explorer_min ?? 1)}`
        : fourchette(id, malus, p, config, max);
    const couleur = bloque ? ROUGE : malus > 0 ? ORANGE : VERT;
    svg += texte(cx0 + cw - 18, y + 62, valeur, { size: 38, fill: couleur, anchor: "end" });
  });
  return svg;
}

export function buildPlateauSvg(p, config) {
  const contenu = [frise(p, config), stocks(p), radeau(p, config), constructions(p, config), recolte(p, config)].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PLATEAU_L}" height="${PLATEAU_H}" viewBox="0 0 ${PLATEAU_L} ${PLATEAU_H}"><rect width="${PLATEAU_L}" height="${PLATEAU_H}" rx="24" fill="${FOND}"/>${contenu}</svg>`;
}

export async function getPlateauImage(plateau) {
  const config = await loadRobinsonConfig();
  const fontPaths = await readGameFontPaths();
  const resvg = new Resvg(Buffer.from(texteAffichable(buildPlateauSvg(plateau, config)), "utf8"), {
    fitTo: { mode: "width", value: PLATEAU_L },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}
