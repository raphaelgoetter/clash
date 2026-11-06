// ============================================================
// penduImage.js — Images du Pendu : vue d'un joueur (sa potence, les
// lettres fausses, le mot avec les seules lettres trouvées) et résultat
// final (les deux potences côte à côte et le mot dévoilé).
// Même technique que mascaradeImage.js / pelemeleImage.js : SVG généré à la
// volée, rastérisé en PNG via @resvg/resvg-js, police Inter embarquée
// (servie depuis Vercel Blob, aucune police système sur Vercel).
//
// Rendu sans état : l'état est passé dans l'URL (encodeVue, encodeFinal) ;
// l'URL change avec l'état, ce qui contourne le cache d'images de Discord.
// ⚠️ L'URL d'une vue ne contient JAMAIS le mot : seulement le motif
// (« EL_PH_NT »), sinon il se lirait dans l'adresse de l'image.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { readBlobFontPath } from "@clash/commun/blobAssets.js";
import { ERREURS_MAX } from "./penduRules.js";

const FONT_PATH = "fonts/Inter-Bold.ttf";
const FONT_FAMILY = "Inter";

const LARGEUR = 700;
const PADDING = 24;
const FOND = "#263238";
const BORD = "#455a64";
const BOIS = "#a1714a";
const BOIS_SOMBRE = "#6d4c33";
const CORDE = "#d7c49e";
const CRAIE = "#f2f3f5";
const ROUGE = "#ef5350";
const VERT = "#66bb6a";
const GRIS = "#90a4ae";
const TUILE = "#f4e4bc";
const TUILE_BORD = "#a9803f";
const LETTRE = "#3b2a1a";
const CASE_VIDE = "#37474f";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const tronquer = (nom, max) => (nom.length > max ? `${nom.slice(0, Math.max(1, max - 1))}…` : nom);

const texte = (x, y, contenu, { size = 22, fill = CRAIE, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" fill="${fill}">${escapeXml(contenu)}</text>`;

// ── Encodage dans l'URL ─────────────────────────────────────────────
// Vue : { m: motif (A-Z et « _ »), f: lettres fausses, e: erreurs,
//   s: fin ("" en jeu, "t" trouvé, "p" pendu, "d" délai dépassé) }.
// Final : { w: mot (accents compris), j: [{ n: pseudo (sans emoji : la
//   police embarquée n'en a pas), e: erreurs, l: lettres découvertes,
//   s: fin }] × 2 (× 1 en solo), g: index du gagnant (-1 : nul, solo) }.

const FINS = { trouve: "t", pendu: "p", temps: "d" };
const FINS_INV = { t: "trouve", p: "pendu", d: "temps" };

const versUrl = (d) => Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
function depuisUrl(param) {
  try {
    return JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const borner = (n, max) => Math.max(0, Math.min(max, Number(n) || 0));

export function encodeVue({ motif, fausses, erreurs, fin = null }) {
  return versUrl({ m: motif, f: fausses.join(""), e: erreurs, s: FINS[fin] ?? "" });
}

// null si le paramètre est illisible.
export function decodeVue(param) {
  const d = depuisUrl(param);
  if (!d || !/^[A-Z_]{1,15}$/.test(d.m ?? "") || !/^[A-Z]{0,26}$/.test(d.f ?? "")) return null;
  return { motif: d.m, fausses: [...d.f], erreurs: borner(d.e, ERREURS_MAX), fin: FINS_INV[d.s] ?? null };
}

export function encodeFinal({ mot, joueurs, gagnant }) {
  return versUrl({
    w: mot,
    j: joueurs.map((j) => ({ n: tronquer(String(j.nom).replace(/\p{Extended_Pictographic}/gu, "").trim() || "?", 18), e: j.erreurs, l: j.decouvertes, s: FINS[j.fin] ?? "" })),
    g: gagnant,
  });
}

export function decodeFinal(param) {
  const d = depuisUrl(param);
  if (!d || typeof d.w !== "string" || d.w.length < 1 || [...d.w].length > MOT_FINAL_MAX || !Array.isArray(d.j) || ![1, 2].includes(d.j.length)) return null;
  return {
    mot: d.w,
    joueurs: d.j.map((j) => ({ nom: String(j.n ?? "?"), erreurs: borner(j.e, ERREURS_MAX), decouvertes: borner(j.l, 15), fin: FINS_INV[j.s] ?? null })),
    gagnant: [0, 1].includes(d.g) ? d.g : -1,
  };
}

// ── Générateur (`/pendu-generator`) ─────────────────────────────────
// Image finale solo d'une partie fictive : mot choisi, gagné ou perdu.
// 20 lettres au plus (au-delà de 11, les tuiles rapetissent : tailleTuiles()).
export const MOT_FINAL_MAX = 20;
export const GENERATEUR_LETTRES_MAX = MOT_FINAL_MAX;

// { erreur } si le mot est invalide, sinon les données de encodeFinal().
// Non précisés : erreurs (gagné, 0 à 5) et lettres trouvées (perdu, 0 à
// longueur - 1) tirées au hasard.
export function finalGenerateur({ mot, resultat, erreurs = null, lettres = null, nom }, rand = Math.random) {
  const m = String(mot ?? "").trim();
  if (!/^\p{L}+$/u.test(m)) return { erreur: "Le mot ne doit contenir que des lettres (sans espace ni tiret)." };
  const n = [...m].length;
  if (n > GENERATEUR_LETTRES_MAX) return { erreur: `Le mot doit faire ${GENERATEUR_LETTRES_MAX} lettres au plus.` };
  const hasard = (max) => Math.floor(rand() * (max + 1));
  const gagne = resultat === "gagne";
  const joueur = gagne
    ? { nom, erreurs: erreurs === null ? hasard(ERREURS_MAX - 1) : borner(erreurs, ERREURS_MAX - 1), decouvertes: n, fin: "trouve" }
    : { nom, erreurs: ERREURS_MAX, decouvertes: lettres === null ? hasard(n - 1) : borner(lettres, n - 1), fin: resultat === "temps" ? "temps" : "pendu" };
  return { mot: m.toLowerCase(), joueurs: [joueur], gagnant: -1 };
}

// ── Dessin ──────────────────────────────────────────────────────────

// Potence dans une boîte de 220 × 250 (origine x, y, échelle k) : bois
// toujours dessiné, bonhomme en 6 parties (tête, corps, bras, jambes), les
// parties restantes en fantôme pour montrer ce qu'il reste. Pendu : yeux
// en croix.
function potenceSvg(x, y, k, erreurs, { couleur = CRAIE } = {}) {
  const ligne = (a, b, c, d, stroke, w) =>
    `<line x1="${x + a * k}" y1="${y + b * k}" x2="${x + c * k}" y2="${y + d * k}" stroke="${stroke}" stroke-width="${w * k}" stroke-linecap="round"/>`;
  const bois = [
    ligne(10, 240, 150, 240, BOIS_SOMBRE, 12),
    ligne(45, 240, 45, 12, BOIS, 12),
    ligne(36, 12, 170, 12, BOIS, 12),
    ligne(45, 55, 85, 14, BOIS_SOMBRE, 8),
    ligne(160, 12, 160, 48, CORDE, 4),
  ];
  const parties = [
    `<circle cx="${x + 160 * k}" cy="${y + 72 * k}" r="${24 * k}" fill="none" stroke="COUL" stroke-width="${6 * k}"/>`,
    ligne(160, 96, 160, 165, "COUL", 6),
    ligne(160, 115, 130, 148, "COUL", 6),
    ligne(160, 115, 190, 148, "COUL", 6),
    ligne(160, 165, 135, 212, "COUL", 6),
    ligne(160, 165, 185, 212, "COUL", 6),
  ];
  const dessin = parties.map((p, i) => (i < erreurs ? p.replaceAll("COUL", couleur) : `<g opacity="0.13">${p.replaceAll("COUL", CRAIE)}</g>`));
  const yeux =
    erreurs >= ERREURS_MAX
      ? [
          [150, 66],
          [170, 66],
        ]
          .flatMap(([cx, cy]) => [ligne(cx - 5, cy - 5, cx + 5, cy + 5, couleur, 3), ligne(cx - 5, cy + 5, cx + 5, cy - 5, couleur, 3)])
          .join("")
      : "";
  return [...bois, ...dessin, yeux].join("\n");
}

// Rangée de tuiles centrée sur `cx` : lettre trouvée sur tuile crème, case
// vide soulignée sinon ; `manquees` (index) : lettres dévoilées à la fin,
// non trouvées, en gris.
function tuilesSvg(lettres, cx, y, { taille = 52, ecart = 8, manquees = new Set() } = {}) {
  const total = lettres.length * taille + (lettres.length - 1) * ecart;
  const x0 = cx - total / 2;
  return lettres
    .map((c, i) => {
      const x = x0 + i * (taille + ecart);
      if (c === "_")
        return `<rect x="${x}" y="${y}" width="${taille}" height="${taille}" rx="8" fill="${CASE_VIDE}"/>
  <line x1="${x + 10}" y1="${y + taille - 10}" x2="${x + taille - 10}" y2="${y + taille - 10}" stroke="${GRIS}" stroke-width="3" stroke-linecap="round"/>`;
      const grise = manquees.has(i);
      return `<rect x="${x}" y="${y}" width="${taille}" height="${taille}" rx="8" fill="${grise ? CASE_VIDE : TUILE}" stroke="${grise ? GRIS : TUILE_BORD}" stroke-width="2"/>
  ${texte(x + taille / 2, y + taille * 0.72, c, { size: Math.round(taille * 0.62), fill: grise ? GRIS : LETTRE, anchor: "middle" })}`;
    })
    .join("\n");
}

const cadre = (largeur, hauteur, contenu) => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${largeur}" height="${hauteur}" viewBox="0 0 ${largeur} ${hauteur}" xmlns="http://www.w3.org/2000/svg">
<rect x="1" y="1" width="${largeur - 2}" height="${hauteur - 2}" rx="18" fill="${FOND}" stroke="${BORD}" stroke-width="2"/>
${contenu}
</svg>`;

const LIBELLE_FIN = { trouve: ["Trouvé !", VERT], pendu: ["Pendu !", ROUGE], temps: ["Temps écoulé", ROUGE] };

export function buildVueSvg({ motif, fausses, erreurs, fin }) {
  const hauteur = 400;
  const potence = potenceSvg(PADDING + 20, PADDING, 1.1, erreurs, { couleur: fin === "pendu" || fin === "temps" ? ROUGE : CRAIE });
  // Colonne de droite : erreurs et lettres fausses (6 au plus par ligne)
  const xd = 330;
  const fauxSvg = fausses
    .map((l, i) => {
      const x = xd + (i % 6) * 54;
      const y = PADDING + 70 + Math.floor(i / 6) * 54;
      return `<rect x="${x}" y="${y}" width="46" height="46" rx="8" fill="none" stroke="${ROUGE}" stroke-width="2"/>
  ${texte(x + 23, y + 33, l, { size: 28, fill: ROUGE, anchor: "middle" })}
  <line x1="${x + 8}" y1="${y + 38}" x2="${x + 38}" y2="${y + 8}" stroke="${ROUGE}" stroke-width="3" stroke-linecap="round"/>`;
    })
    .join("\n");
  const [libelle, couleur] = LIBELLE_FIN[fin] ?? [`Erreurs : ${erreurs}/${ERREURS_MAX}`, CRAIE];
  const contenu = [
    potence,
    texte(xd, PADDING + 40, libelle, { size: 30, fill: couleur }),
    fausses.length ? fauxSvg : texte(xd, PADDING + 100, "Aucune lettre fausse", { size: 20, fill: GRIS }),
    tuilesSvg([...motif], LARGEUR / 2, 310),
  ].join("\n");
  return cadre(LARGEUR, hauteur, contenu);
}

// Tuiles du mot final : 54 px (50 au-delà de 10 lettres), réduites (écart
// compris, police proportionnelle) pour que le mot tienne dans la largeur
// utile de l'image (marges PADDING).
export function tailleTuiles(n) {
  const utile = LARGEUR - 2 * PADDING;
  let taille = n > 10 ? 50 : 54;
  let ecart = 8;
  if (n * taille + (n - 1) * ecart > utile) {
    ecart = n > 16 ? 4 : 6;
    taille = Math.floor((utile - (n - 1) * ecart) / n);
  }
  return { taille, ecart };
}

// Deux potences côte à côte (1v1), une seule au centre (solo)
export function buildFinalSvg({ mot, joueurs, gagnant }) {
  const hauteur = 470;
  const moitie = LARGEUR / joueurs.length;
  const panneaux = joueurs.map((j, i) => {
    const x0 = i * moitie;
    const perdu = j.fin === "pendu" || j.fin === "temps";
    const [libelle, couleur] = LIBELLE_FIN[j.fin] ?? ["Abandon", GRIS];
    const detail = j.fin === "trouve" ? `${j.erreurs} erreur${j.erreurs > 1 ? "s" : ""}` : `${j.decouvertes} lettre${j.decouvertes > 1 ? "s" : ""} trouvée${j.decouvertes > 1 ? "s" : ""}`;
    return [
      texte(x0 + moitie / 2, PADDING + 26, `${gagnant === i ? "★ " : ""}${j.nom}`, { size: 26, fill: gagnant === i ? "#f0c040" : CRAIE, anchor: "middle" }),
      potenceSvg(x0 + moitie / 2 - 105, PADDING + 44, 0.9, j.erreurs, { couleur: perdu ? ROUGE : CRAIE }),
      texte(x0 + moitie / 2, PADDING + 298, libelle, { size: 24, fill: couleur, anchor: "middle" }),
      texte(x0 + moitie / 2, PADDING + 326, detail, { size: 18, fill: GRIS, anchor: "middle" }),
    ].join("\n");
  });
  const separateur = joueurs.length > 1 ? `<line x1="${moitie}" y1="${PADDING}" x2="${moitie}" y2="${PADDING + 330}" stroke="${BORD}" stroke-width="2"/>` : "";
  const lettres = [...mot.toUpperCase()];
  const { taille, ecart } = tailleTuiles(lettres.length);
  // Tuiles plus petites : centrées sur la même ligne que les grandes
  const y = 380 + (54 - taille) / 2;
  return cadre(LARGEUR, hauteur, [...panneaux, separateur, tuilesSvg(lettres, LARGEUR / 2, y, { taille, ecart })].join("\n"));
}

async function rasterize(svg) {
  const fontPath = await readBlobFontPath(FONT_PATH);
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: LARGEUR },
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

export const getVueImage = (vue) => rasterize(buildVueSvg(vue));
export const getFinalImage = (final) => rasterize(buildFinalSvg(final));
