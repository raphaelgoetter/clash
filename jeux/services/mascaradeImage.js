// ============================================================
// mascaradeImage.js — Image de la table de Mascarade : cartes écartées
// (visibles), Réserve et pioche (dos), cartes jouées par chacun dans
// l'ordre, en noir et blanc (la dernière jouée encadrée) et, dans la vue
// d'un joueur seulement, sa main (et la carte vue par ses Squelettes). Chaque carte montre son illustration officielle et
// son coût en élixir (sa valeur dans le jeu).
// Même technique que quiestceImage.js / bangImage.js : SVG généré à la
// volée, rastérisé en PNG via @resvg/resvg-js ; dessin des cartes partagé
// via cardImage.js.
//
// Rendu sans état : la table est passée dans l'URL (encodeTable) ; l'URL
// change avec l'état, ce qui contourne le cache d'images de Discord.
// Image du résultat final (encodeResultat) : pour chaque manche, les deux
// cartes qui l'ont décidée (celle du perdant en noir et blanc).
// ============================================================

import { cardSvg, loadDataUrls, rasterize, RATIO_CARTE } from "@clash/clash-royale/cardImage.js";
import { CARTES } from "./mascaradeRules.js";

const FONT_FAMILY = "Inter";
const IDS = Object.keys(CARTES);
const PADDING = 22;
const GAP = 12;
const CARTE_W = 104;
const CARTE_H = Math.round(CARTE_W * RATIO_CARTE);
const MAIN_W = 210;
const MAIN_H = Math.round(MAIN_W * RATIO_CARTE);
const GOUTTE = 34;
const LABEL_H = 34;
// Libellés de la main : place pour la goutte d'élixir, plus grande
const LABEL_MAIN = LABEL_H + 14;
// Largeur : 7 cartes ; une rangée plus longue (défausses forcées par la
// Bûche comprises) resserre ses cartes, qui se chevauchent
const COLS = 7;
const LARGEUR = PADDING * 2 + COLS * CARTE_W + (COLS - 1) * GAP;
const COULEUR_DERNIERE = "#f0c040";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const tronquer = (nom, max) => (nom.length > max ? `${nom.slice(0, Math.max(1, max - 1))}…` : nom);

// ── Encodage dans l'URL ─────────────────────────────────────────────
// { e: écartées, r: Réserve présente (0/1), p: cartes dans la pioche,
//   j: [cartes jouées du haut, du bas], n: [nom du haut, nom du bas] (sans
//   emoji : la police embarquée n'en a pas),
//   m: main (vue d'un joueur, sinon absente), s: sommet de la pioche vu
//   par les Squelettes (sinon absent), l: rangée de la dernière carte jouée
//   (0 haut, 1 bas, -1 aucune) } ; cartes par index de CARTES.

export function encodeTable({ ecartees, reserve, pioche, joueesHaut, joueesBas, nomHaut, nomBas, main = null, sommet = null, derniere = -1 }) {
  const idx = (c) => IDS.indexOf(c);
  const d = {
    e: ecartees.map(idx),
    r: reserve ? 1 : 0,
    p: pioche,
    j: [joueesHaut.map(idx), joueesBas.map(idx)],
    n: [tronquer(String(nomHaut), 24), tronquer(String(nomBas), 24)],
    l: derniere,
    ...(main ? { m: main.map(idx) } : {}),
    ...(sommet ? { s: idx(sommet) } : {}),
  };
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

// null si le paramètre est illisible.
export function decodeTable(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    const carte = (i) => IDS[Number(i)];
    const liste = (a, max) => (Array.isArray(a) ? a.slice(0, max).map(carte) : []);
    const t = {
      ecartees: liste(d.e, 2),
      reserve: d.r === 1,
      pioche: Math.max(0, Math.min(99, Number(d.p) || 0)),
      jouees: [liste(d.j?.[0], 12), liste(d.j?.[1], 12)],
      noms: [String(d.n?.[0] ?? "?"), String(d.n?.[1] ?? "?")],
      main: d.m ? liste(d.m, 2) : null,
      sommet: d.s === undefined ? null : carte(d.s),
      derniere: [0, 1].includes(d.l) ? d.l : -1,
    };
    const toutes = [...t.ecartees, ...t.jouees[0], ...t.jouees[1], ...(t.main ?? []), ...(d.s === undefined ? [] : [t.sommet])];
    return toutes.some((c) => !c) ? null : t;
  } catch {
    return null;
  }
}

// ── Dessin ──────────────────────────────────────────────────────────

const texte = (x, y, contenu, { size = 20, fill = "#f2f3f5", anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" fill="${fill}">${escapeXml(contenu)}</text>`;

// Dos de carte (Réserve, pioche), avec un nombre éventuel
function dosSvg(x, y, w, h, nombre = null) {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#3b2a5c" stroke="#8e6cc9" stroke-width="3"/>
  <rect x="${x + 9}" y="${y + 9}" width="${w - 18}" height="${h - 18}" rx="8" fill="none" stroke="#8e6cc9" stroke-width="2" stroke-dasharray="6 5"/>
  ${texte(x + w / 2, y + h / 2 + 14, nombre == null ? "?" : String(nombre), { size: 40, anchor: "middle", fill: "#e6dcff" })}`;
}

// Filtre noir et blanc des cartes déjà jouées
const FILTRE_GRIS = `<defs><filter id="gris"><feColorMatrix type="saturate" values="0"/></filter></defs>`;

function carteSvg(id, dataUrls, x, y, w, { encadree = false, gris = false } = {}) {
  const h = Math.round(w * RATIO_CARTE);
  const dessin = cardSvg({ key: CARTES[id].cle, minBid: CARTES[id].cout }, dataUrls.get(CARTES[id].cle), x, y, { w, drop: Math.round((GOUTTE * w) / CARTE_W) });
  const art = gris ? `<g filter="url(#gris)">${dessin}</g>` : dessin;
  const cadre = encadree ? `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="12" fill="none" stroke="${COULEUR_DERNIERE}" stroke-width="5"/>` : "";
  return art + cadre;
}

// Rangée de cartes jouées, avec son libellé ; « aucune carte » si vide.
function rangeeSvg(libelle, cartes, dataUrls, y, encadrerDerniere) {
  const parts = [texte(PADDING, y + 22, libelle, { size: 21 })];
  const yc = y + LABEL_H;
  if (!cartes.length) parts.push(texte(PADDING, yc + CARTE_H / 2, "Aucune carte jouée", { size: 18, fill: "#80848e" }));
  const pas = cartes.length > COLS ? (LARGEUR - 2 * PADDING - CARTE_W) / (cartes.length - 1) : CARTE_W + GAP;
  cartes.forEach((c, i) => parts.push(carteSvg(c, dataUrls, PADDING + i * pas, yc, CARTE_W, { encadree: encadrerDerniere && i === cartes.length - 1, gris: true })));
  return parts.join("\n");
}

async function buildTableSvg(t) {
  const cles = [...new Set([...t.ecartees, ...t.jouees[0], ...t.jouees[1], ...(t.main ?? []), ...(t.sommet ? [t.sommet] : [])])];
  const dataUrls = await loadDataUrls(cles.map((c) => ({ key: CARTES[c].cle })));
  const parts = [];
  let y = PADDING;

  // Écartées (visibles), Réserve (dos), pioche (dos + nombre)
  parts.push(texte(PADDING, y + 22, "Écartées", { size: 21 }));
  const xReserve = PADDING + 2 * (CARTE_W + GAP) + 2 * GAP;
  const xPioche = xReserve + CARTE_W + 2 * GAP;
  parts.push(texte(xReserve, y + 22, "Réserve", { size: 21 }));
  parts.push(texte(xPioche, y + 22, "Pioche", { size: 21 }));
  const yc = y + LABEL_H;
  t.ecartees.forEach((c, i) => parts.push(carteSvg(c, dataUrls, PADDING + i * (CARTE_W + GAP), yc, CARTE_W)));
  parts.push(t.reserve ? dosSvg(xReserve, yc, CARTE_W, CARTE_H) : texte(xReserve, yc + CARTE_H / 2, "vide", { size: 18, fill: "#80848e" }));
  parts.push(dosSvg(xPioche, yc, CARTE_W, CARTE_H, t.pioche));
  y = yc + CARTE_H + GAP * 2;

  // Cartes jouées de chacun (adversaire en haut)
  parts.push(rangeeSvg(`Déjà jouées par ${t.noms[0]}`, t.jouees[0], dataUrls, y, t.derniere === 0));
  y += LABEL_H + CARTE_H + GAP * 2;
  parts.push(rangeeSvg(`Déjà jouées par ${t.noms[1]}`, t.jouees[1], dataUrls, y, t.derniere === 1));
  y += LABEL_H + CARTE_H;

  // Main (vue d'un joueur)
  if (t.main) {
    y += GAP * 2;
    parts.push(`<rect x="${PADDING / 2}" y="${y - GAP}" width="${LARGEUR - PADDING}" height="${LABEL_MAIN + MAIN_H + GAP * 2}" rx="14" fill="#2b2d31"/>`);
    parts.push(texte(PADDING, y + 22, "Ta main", { size: 21, fill: COULEUR_DERNIERE }));
    t.main.forEach((c, i) => parts.push(carteSvg(c, dataUrls, PADDING + i * (MAIN_W + GAP * 2), y + LABEL_MAIN, MAIN_W)));
    // Squelettes : la carte vue au sommet, à droite de la main (au-dessus des boutons du choix)
    if (t.sommet) {
      const xs = LARGEUR - PADDING - MAIN_W;
      parts.push(texte(xs, y + 22, "Sommet de la pioche", { size: 21, fill: COULEUR_DERNIERE }));
      parts.push(carteSvg(t.sommet, dataUrls, xs, y + LABEL_MAIN, MAIN_W, { encadree: true }));
    }
    y += LABEL_MAIN + MAIN_H + GAP;
  }
  const hauteur = y + PADDING;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}" xmlns="http://www.w3.org/2000/svg">
  ${FILTRE_GRIS}
  <rect x="0" y="0" width="${LARGEUR}" height="${hauteur}" rx="18" fill="#1e1f22"/>
  ${parts.join("\n")}
</svg>`;
}

export async function getTableImage(t) {
  return { buffer: await rasterize(await buildTableSvg(t), LARGEUR), mimeType: "image/png" };
}

// ── Résultat final ──────────────────────────────────────────────────
// Une ligne par manche : les deux cartes qui l'ont décidée, celle du
// perdant de la manche en noir et blanc. Colonnes fixes : vainqueur de la
// partie à gauche.
// { n: [nom de gauche, nom de droite] (sans emoji), m: [[carte gauche,
//   carte droite, gagnant de la manche (0 gauche, 1 droite), numéro], …] }

const RES_W = 96;
const RES_H = Math.round(RES_W * RATIO_CARTE);
const RES_VS = 70;
const RES_LARGEUR = PADDING * 2 + RES_W * 2 + RES_VS;
const RES_MAX_MANCHES = 5;

export function encodeResultat({ noms, manches }) {
  const idx = (c) => IDS.indexOf(c);
  const d = { n: noms.map((x) => tronquer(String(x), 14)), m: manches.map(({ gauche, droite, gagnant, numero }) => [idx(gauche), idx(droite), gagnant, numero]) };
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

// null si le paramètre est illisible.
export function decodeResultat(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    if (!Array.isArray(d.m) || !d.m.length) return null;
    const manches = d.m.slice(0, RES_MAX_MANCHES).map(([a, b, g, n], k) => ({ gauche: IDS[Number(a)], droite: IDS[Number(b)], gagnant: g === 1 ? 1 : 0, numero: Number(n) || k + 1 }));
    if (manches.some((m) => !m.gauche || !m.droite)) return null;
    return { noms: [String(d.n?.[0] ?? "?"), String(d.n?.[1] ?? "?")], manches };
  } catch {
    return null;
  }
}

async function buildResultatSvg(r) {
  const cles = [...new Set(r.manches.flatMap((m) => [m.gauche, m.droite]))];
  const dataUrls = await loadDataUrls(cles.map((c) => ({ key: CARTES[c].cle })));
  const xs = [PADDING, PADDING + RES_W + RES_VS];
  const parts = xs.map((x, i) => texte(x + RES_W / 2, PADDING + 20, r.noms[i], { size: 17, anchor: "middle", fill: i === 0 ? COULEUR_DERNIERE : "#f2f3f5" }));
  let y = PADDING + 26;
  r.manches.forEach((m) => {
    parts.push(texte(RES_LARGEUR / 2, y + 20, `Manche ${m.numero}`, { size: 15, anchor: "middle", fill: "#80848e" }));
    const yc = y + 32;
    [m.gauche, m.droite].forEach((c, i) => parts.push(carteSvg(c, dataUrls, xs[i], yc, RES_W, { encadree: m.gagnant === i, gris: m.gagnant !== i })));
    parts.push(texte(RES_LARGEUR / 2, yc + RES_H / 2 + 9, "vs", { size: 24, anchor: "middle", fill: "#f2f3f5" }));
    y = yc + RES_H + GAP;
  });
  const hauteur = y + PADDING - GAP;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${RES_LARGEUR}" height="${hauteur}" viewBox="0 0 ${RES_LARGEUR} ${hauteur}" xmlns="http://www.w3.org/2000/svg">
  ${FILTRE_GRIS}
  <rect x="0" y="0" width="${RES_LARGEUR}" height="${hauteur}" rx="18" fill="#1e1f22"/>
  ${parts.join("\n")}
</svg>`;
}

export async function getResultatImage(r) {
  return { buffer: await rasterize(await buildResultatSvg(r), RES_LARGEUR), mimeType: "image/png" };
}
