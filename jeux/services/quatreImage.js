// ============================================================
// quatreImage.js — Images de Quatre à la suite (`/quatre` et Boss), deux
// images empilées dans le message (Components V2, une galerie chacune) :
// - le bandeau : pion à jouer (bleu, numéro de colonne) au-dessus de la
//   colonne visée, flèche vers la grille. Sept images seulement, toujours
//   les mêmes (cache immuable) : déplacer le pion (◀️ ▶️) ne change que
//   l'URL du bandeau, sans nouveau rendu de la grille ;
// - la grille : pions du siège `moi` en bleu, de l'adversaire en rouge,
//   dernier pion joué cerclé de blanc, alignement gagnant cerclé d'or,
//   numéros de colonne et légende (noms des deux camps) dessous. L'URL ne
//   change que quand un pion tombe.
// Même technique que blackjackImage.js : SVG généré à la volée, rastérisé
// en PNG via @resvg/resvg-js, police Inter embarquée (Vercel Blob). Rendu
// sans état : la grille est passée dans l'URL (encodeGrille).
//
// ⚠️ Alignement du bandeau sur la grille : Discord ne permet pas
// d'imposer la taille d'affichage d'une image. Sur ordinateur, il la
// réduit pour tenir dans 550 × 350 px (non documenté : relevé sur les
// captures, mêmes bornes que le client modifié Vencord) sans jamais
// l'agrandir. La grille (600 × GRILLE_H, presque carrée) bute sur la
// hauteur et s'affiche à 600 × 350 / GRILLE_H ≈ 341 px de large : le
// bandeau est rendu à cette largeur (LARGEUR_BANDEAU), affiché tel quel,
// donc aligné. Sur mobile, les deux sont réduites à la largeur de
// l'écran, ensemble. La grille reste nette (600 px), seul le pion du
// bandeau est un peu flou sur écran haute densité.
// Lisibilité mobile : aucun texte sous 24 px sur LARGEUR (~13 px affichés).
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { texteAffichable, tronquer } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import { HAUTEUR, NB_COLONNES } from "./quatreRules.js";

const FONT_FAMILY = "Inter";

const LARGEUR = 600;
const CASE = 76;
const MARGE_GRILLE = 12;
const LARGEUR_GRILLE = NB_COLONNES * CASE + 2 * MARGE_GRILLE;
const HAUTEUR_GRILLE = HAUTEUR * CASE + 2 * MARGE_GRILLE;
const X_GRILLE = (LARGEUR - LARGEUR_GRILLE) / 2;
const Y_GRILLE = 14;
const RAYON = 30;
const HAUTEUR_BANDEAU = 104;
// Hauteur de l'image de la grille : grille, numéros, légende
const Y_NUMEROS = Y_GRILLE + HAUTEUR_GRILLE + 40;
const Y_LEGENDE = Y_NUMEROS + 54;
export const GRILLE_H = Y_LEGENDE + 28;
// Bornes d'affichage de Discord sur ordinateur (voir l'en-tête)
const AFFICHAGE_MAX_H = 350;
export const LARGEUR_BANDEAU = Math.round((LARGEUR * AFFICHAGE_MAX_H) / GRILLE_H);
// Fond commun aux deux images : le bandeau et la grille se raccordent
const FOND = "#18202f";
const OR = "#f0c040";
const BLANC = "#ffffff";
// Dégradés des pions : clair, base, sombre
const TEINTES = {
  bleu: ["#5aa2ff", "#1f6fe0", "#0f4fb0"],
  rouge: ["#ff7a70", "#e0352b", "#a8201a"],
};
// Longueur des noms de la légende (deux noms sur la largeur)
const NOM_MAX = 14;

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// La police embarquée n'a pas d'emoji : retirés des pseudos
const sansEmoji = (nom) => String(nom).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim() || "?";

const borner = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
const encoder = (d) => Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
const decoder = (param) => JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));

const xColonne = (c) => X_GRILLE + MARGE_GRILLE + c * CASE + CASE / 2;
const yRangee = (r) => Y_GRILLE + MARGE_GRILLE + (HAUTEUR - 1 - r) * CASE + CASE / 2;

const degrades = () =>
  Object.entries(TEINTES)
    .map(
      ([id, [clair, base, sombre]]) =>
        `<radialGradient id="${id}" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="${clair}"/><stop offset="0.55" stop-color="${base}"/><stop offset="1" stop-color="${sombre}"/></radialGradient>`,
    )
    .join("");

// Pion en (cx, cy) ; `contour` : "gagnant" (or), "dernier" (blanc) ou rien
function pion(cx, cy, couleur, { contour = null, numero = null } = {}) {
  const bord =
    contour === "gagnant"
      ? `stroke="${OR}" stroke-width="7"`
      : contour === "dernier"
        ? `stroke="${BLANC}" stroke-width="5"`
        : `stroke="rgba(0,0,0,0.35)" stroke-width="2"`;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${RAYON}" fill="url(#${couleur})" ${bord}/>`,
    `<circle cx="${cx}" cy="${cy}" r="${RAYON - 9}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>`,
    numero
      ? `<text x="${cx}" y="${cy + 11}" font-family="${FONT_FAMILY}" font-size="32" font-weight="800" text-anchor="middle" fill="${BLANC}">${numero}</text>`
      : "",
  ].join("");
}

const svg = (hauteur, contenu, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}"><defs>${degrades()}${defs}</defs><rect width="${LARGEUR}" height="${hauteur}" fill="${FOND}"/>${contenu}</svg>`;

// ── Bandeau ──────────────────────────────────────────────────────────

/** Bandeau du pion à jouer au-dessus de la colonne `colonne` (0 à 6). */
export function buildBandeauSvg(colonne) {
  const c = borner(colonne, 0, NB_COLONNES - 1);
  const x = xColonne(c);
  const y = 44;
  const pointe = y + RAYON + 12;
  return svg(
    HAUTEUR_BANDEAU,
    `${pion(x, y, "bleu", { numero: c + 1 })}<path d="M ${x - 13} ${pointe} L ${x + 13} ${pointe} L ${x} ${pointe + 15} Z" fill="${BLANC}" opacity="0.9"/>`,
  );
}

// ── Grille ───────────────────────────────────────────────────────────

/**
 * Paramètre d'URL de la grille vue par le siège `moi` (ses pions en bleu).
 * `noms` : { moi, adv } (légende) ; `d` : duel (colonnes, dernier,
 * alignement).
 */
export function encodeGrille(d, moi, noms) {
  const g = {
    // Une chaîne par colonne, du bas vers le haut : b (moi), r (adversaire)
    g: d.colonnes.map((col) => col.map((id) => (id === moi ? "b" : "r")).join("")).join("-"),
    n: [tronquer(sansEmoji(noms.moi), NOM_MAX), tronquer(sansEmoji(noms.adv), NOM_MAX)],
  };
  if (d.dernier) g.l = `${d.dernier.colonne}${d.dernier.rangee}`;
  if (d.alignement?.length) g.a = d.alignement.map(([c, r]) => `${c}${r}`).join("");
  return encoder(g);
}

const depuisCases = (s) =>
  (String(s ?? "").match(/\d\d/g) ?? []).map(([c, r]) => [borner(c, 0, NB_COLONNES - 1), borner(r, 0, HAUTEUR - 1)]);

export function decodeGrille(param) {
  try {
    const g = decoder(param);
    const colonnes = String(g?.g ?? "").split("-");
    if (colonnes.length !== NB_COLONNES) return null;
    return {
      colonnes: colonnes.map((col) =>
        col
          .slice(0, HAUTEUR)
          .split("")
          .map((p) => (p === "b" ? "bleu" : "rouge")),
      ),
      noms: { moi: String(g.n?.[0] ?? "?"), adv: String(g.n?.[1] ?? "?") },
      dernier: g.l ? depuisCases(g.l)[0] ?? null : null,
      alignement: depuisCases(g.a),
    };
  } catch {
    return null;
  }
}

/** Grille décodée par decodeGrille. */
export function buildGrilleSvg({ colonnes, noms, dernier = null, alignement = [] }) {
  const gagnantes = new Set(alignement.map(([c, r]) => `${c},${r}`));
  const yNumeros = Y_NUMEROS;
  const yLegende = Y_LEGENDE;
  const hauteur = GRILLE_H;
  let trous = "";
  let pions = "";
  for (let c = 0; c < NB_COLONNES; c++) {
    for (let r = 0; r < HAUTEUR; r++) {
      trous += `<circle cx="${xColonne(c)}" cy="${yRangee(r)}" r="${RAYON + 1}" fill="#000"/>`;
      const couleur = colonnes[c]?.[r];
      if (!couleur) continue;
      const contour = gagnantes.has(`${c},${r}`) ? "gagnant" : dernier?.[0] === c && dernier?.[1] === r ? "dernier" : null;
      pions += pion(xColonne(c), yRangee(r), couleur, { contour });
    }
  }
  const texte = (x, y, contenu, { anchor = "middle", fill = BLANC } = {}) =>
    `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="28" font-weight="700" text-anchor="${anchor}" fill="${fill}">${escapeXml(contenu)}</text>`;
  const numeros = Array.from({ length: NB_COLONNES }, (_, c) => texte(xColonne(c), yNumeros, c + 1, { fill: "#9fb0c8" })).join("");
  const legende = [
    `<circle cx="${X_GRILLE + 22}" cy="${yLegende - 9}" r="15" fill="url(#bleu)"/>`,
    texte(X_GRILLE + 48, yLegende, noms.moi, { anchor: "start" }),
    texte(LARGEUR - X_GRILLE - 48, yLegende, noms.adv, { anchor: "end" }),
    `<circle cx="${LARGEUR - X_GRILLE - 22}" cy="${yLegende - 9}" r="15" fill="url(#rouge)"/>`,
  ].join("");
  const cadre = `x="${X_GRILLE}" y="${Y_GRILLE}" width="${LARGEUR_GRILLE}" height="${HAUTEUR_GRILLE}" rx="18"`;
  return svg(
    hauteur,
    [
      // Fond des trous, pions, puis façade de la grille percée de trous
      `<rect ${cadre} fill="#0b1018"/>`,
      pions,
      `<rect ${cadre} fill="url(#facade)" mask="url(#trous)" stroke="#5c7396" stroke-width="3"/>`,
      numeros,
      legende,
    ].join(""),
    `<linearGradient id="facade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d5170"/><stop offset="1" stop-color="#2a3a55"/></linearGradient><mask id="trous"><rect width="${LARGEUR}" height="${hauteur}" fill="#fff"/>${trous}</mask>`,
  );
}

// ── Rendu PNG ────────────────────────────────────────────────────────

async function rasterize(contenu, largeur = LARGEUR) {
  const fontPaths = await readGameFontPaths();
  const resvg = new Resvg(Buffer.from(texteAffichable(contenu), "utf8"), {
    fitTo: { mode: "width", value: largeur },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

// Bandeaux gardés en mémoire de l'instance (7 images au plus)
const bandeaux = new Map();

export function getBandeauImage(colonne) {
  const c = borner(colonne, 0, NB_COLONNES - 1);
  if (!bandeaux.has(c)) {
    const rendu = rasterize(buildBandeauSvg(c), LARGEUR_BANDEAU);
    bandeaux.set(c, rendu);
    rendu.catch(() => bandeaux.delete(c));
  }
  return bandeaux.get(c);
}

export const getGrilleImage = (grille) => rasterize(buildGrilleSvg(grille));
