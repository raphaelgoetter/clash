// ============================================================
// friseImage.js — Image de la frise de Frise (`/frise`) : ligne du temps
// verticale, années dans des pastilles sur la ligne, cartes en zigzag
// (alternativement à gauche et à droite), fond bleu ou rouge selon le
// joueur qui l'a posée (gris : carte de départ). La carte du dernier coup a
// une bordure dorée et un badge ✓ (bien placée) ou ✗ (rangée après une
// erreur) : le sens est porté par la forme, jamais par le rouge (couleur
// d'un joueur). Fonds sombres, texte blanc : contraste ≈ 7,5:1 (AAA).
// Même technique que penduImage.js : SVG généré à la volée, rastérisé en
// PNG via @resvg/resvg-js, police Inter embarquée (servie depuis Vercel
// Blob, aucune police système sur Vercel).
//
// Rendu sans état : la frise est passée dans l'URL sous forme d'ids de
// cartes (index dans jeux/data/frise/cartes.json), l'URL change avec
// l'état, ce qui contourne le cache d'images de Discord.
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { texteAffichable } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARTES_JSON_PATH = path.resolve(__dirname, "..", "data", "frise", "cartes.json");

const FONT_FAMILY = "Inter";

const LARGEUR = 800;
const MARGE_HAUT = 28;
const MARGE_BAS = 40;
// Écart vertical entre deux cartes (les boîtes alternent de côté : elles
// peuvent être plus hautes que ce pas sans se chevaucher)
const PAS = 62;
const BOITE_H = 58;
const BOITE_L = 300;
const CENTRE = LARGEUR / 2;
const ECART_LIGNE = 70;

const FOND = "#1f2a30";
const LIGNE = "#c9a86a";
const PASTILLE = "#e0b25c";
const PASTILLE_TEXTE = "#2b1d0e";
const TEXTE = "#ffffff";
// Fond et bordure de chaque carte selon son auteur
const FONDS = {
  n: { fond: "#3a4a53", bord: "#5c707b" },
  b: { fond: "#1f4e8c", bord: "#5b8fd6" },
  r: { fond: "#9b2c2c", bord: "#e07070" },
};
const SURLIGNE = "#f5c242";
const BADGE_JUSTE = "#2e7d32";
const BADGE_FAUX = "#ef8f00";

// Limite de cartes dans une URL (une frise ne dépasse pas le paquet)
const CARTES_MAX = 200;

let _cartes = null;
function cartes() {
  if (!_cartes) _cartes = JSON.parse(fs.readFileSync(CARTES_JSON_PATH, "utf8"));
  return _cartes;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const formatAnnee = (a) => (a < 0 ? `${-a} av. J.-C.` : String(a));

// ── Encodage dans l'URL ─────────────────────────────────────────────
// Paramètres : c (ids de la frise dans l'ordre, séparés par « - »),
// p (auteur de chaque carte : b bleu, r rouge, n départ), d (id de la carte
// du dernier coup, facultatif), j (1 bien placée, 0 non). `bleu` : siège
// affiché en bleu (le joueur de la vue, ou le premier joueur en public).

export function encodeFrise(d, bleu = "joueur") {
  const params = new URLSearchParams({
    c: d.frise.map((c) => c.id).join("-"),
    p: d.frise.map((c) => (!c.par ? "n" : c.par === bleu ? "b" : "r")).join(""),
  });
  if (d.dernier) {
    params.set("d", String(d.dernier.carte.id));
    params.set("j", d.dernier.juste ? "1" : "0");
  }
  return params.toString();
}

// Depuis la requête ({ c, p, d, j }) : { frise: [{ libelle, annee, auteur,
// marque }] }
// ou null si illisible.
export function decodeFrise(query) {
  const ids = String(query?.c ?? "").split("-").filter(Boolean).map(Number);
  const liste = cartes();
  if (!ids.length || ids.length > CARTES_MAX || ids.some((i) => !Number.isInteger(i) || !liste[i])) return null;
  const dernier = query?.d != null ? Number(query.d) : null;
  const marque = query?.j === "1" ? "juste" : "faux";
  const auteurs = String(query?.p ?? "");
  return {
    frise: ids.map((i, k) => ({
      libelle: liste[i].libelle,
      annee: liste[i].annee,
      auteur: FONDS[auteurs[k]] ? auteurs[k] : "n",
      marque: i === dernier ? marque : null,
    })),
  };
}

// ── Dessin ──────────────────────────────────────────────────────────

// Coupe un libellé en 2 lignes au plus (largeur estimée en caractères),
// « … » si ça ne tient pas.
export function couperLignes(texte, max = 29) {
  const mots = texte.split(" ");
  const lignes = [""];
  for (const mot of mots) {
    const cur = lignes[lignes.length - 1];
    if (!cur) lignes[lignes.length - 1] = mot;
    else if ((cur + " " + mot).length <= max) lignes[lignes.length - 1] = `${cur} ${mot}`;
    else lignes.push(mot);
  }
  if (lignes.length <= 2) return lignes;
  const seconde = lignes.slice(1).join(" ");
  return [lignes[0], `${seconde.slice(0, max - 1).trimEnd()}…`];
}

function carteSvg(c, i) {
  const y = MARGE_HAUT + i * PAS + BOITE_H / 2;
  const gauche = i % 2 === 0;
  const x = gauche ? CENTRE - ECART_LIGNE - BOITE_L : CENTRE + ECART_LIGNE;
  const { fond, bord: bordAuteur } = FONDS[c.auteur ?? "n"];
  const bord = c.marque ? SURLIGNE : bordAuteur;
  const epaisseur = c.marque ? 4 : 1.5;
  const lignes = couperLignes(c.libelle);
  const tailleTexte = 17;
  const yTexte = y - (lignes.length - 1) * 10 + 6;
  const textes = lignes
    .map(
      (l, k) =>
        `<text x="${x + BOITE_L / 2}" y="${yTexte + k * 21}" font-family="${FONT_FAMILY}" font-size="${tailleTexte}" text-anchor="middle" fill="${TEXTE}">${escapeXml(l)}</text>`,
    )
    .join("");
  // Pastille de l'année, centrée sur la ligne
  const annee = formatAnnee(c.annee);
  // Année longue (« 52 av. J.-C. ») : police réduite, la pastille ne
  // déborde pas sur les cartes
  const taillePastille = annee.length > 6 ? 15 : 19;
  const lp = Math.max(78, annee.length * (taillePastille * 0.6) + 22);
  const xRelie = gauche ? x + BOITE_L : x;
  return [
    `<line x1="${xRelie}" y1="${y}" x2="${CENTRE}" y2="${y}" stroke="${bord}" stroke-width="${c.marque ? 3 : 2}"/>`,
    `<rect x="${x}" y="${y - BOITE_H / 2}" width="${BOITE_L}" height="${BOITE_H}" rx="10" fill="${fond}" stroke="${bord}" stroke-width="${epaisseur}"/>`,
    textes,
    `<rect x="${CENTRE - lp / 2}" y="${y - 16}" width="${lp}" height="32" rx="16" fill="${PASTILLE}" stroke="${c.marque ? SURLIGNE : "none"}" stroke-width="3"/>`,
    `<text x="${CENTRE}" y="${y + taillePastille / 2.7}" font-family="${FONT_FAMILY}" font-size="${taillePastille}" text-anchor="middle" fill="${PASTILLE_TEXTE}">${escapeXml(annee)}</text>`,
    c.marque ? badgeSvg(gauche ? x : x + BOITE_L, y - BOITE_H / 2, c.marque === "juste") : "",
  ].join("\n");
}

// Badge rond au coin extérieur de la carte : ✓ ou ✗ dessinés (la police
// embarquée n'a pas ces glyphes), contour blanc.
function badgeSvg(cx, cy, juste) {
  const r = 14;
  const trait = `stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const signe = juste
    ? `<path d="M ${cx - 6} ${cy} L ${cx - 1.5} ${cy + 5} L ${cx + 7} ${cy - 5}" ${trait}/>`
    : `<path d="M ${cx - 5} ${cy - 5} L ${cx + 5} ${cy + 5} M ${cx + 5} ${cy - 5} L ${cx - 5} ${cy + 5}" ${trait}/>`;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${juste ? BADGE_JUSTE : BADGE_FAUX}" stroke="#ffffff" stroke-width="2.5"/>${signe}`;
}

export function buildFriseSvg({ frise }) {
  const hauteur = MARGE_HAUT + (frise.length - 1) * PAS + BOITE_H + MARGE_BAS;
  const yFin = hauteur - 14;
  const ligne = [
    `<line x1="${CENTRE}" y1="${MARGE_HAUT / 2}" x2="${CENTRE}" y2="${yFin - 10}" stroke="${LIGNE}" stroke-width="5" stroke-linecap="round"/>`,
    // Flèche du temps, vers le bas
    `<path d="M ${CENTRE - 11} ${yFin - 16} L ${CENTRE + 11} ${yFin - 16} L ${CENTRE} ${yFin} Z" fill="${LIGNE}"/>`,
  ].join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}">
<rect width="${LARGEUR}" height="${hauteur}" rx="18" fill="${FOND}"/>
${ligne}
${frise.map(carteSvg).join("\n")}
</svg>`;
}

// ── Frise décorative (récapitulatif de fin) ─────────────────────────
// Purement décorative : ligne du temps horizontale et quelques dates fixes,
// jalons alternés au-dessus et au-dessous de la ligne. Image identique
// pour toutes les parties.
const DATES_DECOR = [-52, 800, 1492, 1789, 1903, 1969, 2016];

export function buildDecorSvg() {
  const h = 150;
  const y = h / 2;
  const x0 = 50;
  const x1 = LARGEUR - 50;
  // Dernier jalon à distance de la flèche
  const pas = (x1 - x0 - 80) / (DATES_DECOR.length - 1);
  const jalons = DATES_DECOR.map((a, k) => {
    const x = x0 + 20 + k * pas;
    const haut = k % 2 === 0;
    const yTexte = haut ? y - 30 : y + 44;
    return [
      `<line x1="${x}" y1="${y}" x2="${x}" y2="${haut ? y - 18 : y + 18}" stroke="${LIGNE}" stroke-width="3"/>`,
      `<circle cx="${x}" cy="${y}" r="9" fill="${PASTILLE}" stroke="${FOND}" stroke-width="3"/>`,
      `<text x="${x}" y="${yTexte}" font-family="${FONT_FAMILY}" font-size="${a < 0 ? 17 : 21}" text-anchor="middle" fill="${PASTILLE}">${escapeXml(formatAnnee(a))}</text>`,
    ].join("");
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${h}" viewBox="0 0 ${LARGEUR} ${h}">
<rect width="${LARGEUR}" height="${h}" rx="18" fill="${FOND}"/>
<line x1="${x0}" y1="${y}" x2="${x1 - 12}" y2="${y}" stroke="${LIGNE}" stroke-width="5" stroke-linecap="round"/>
<path d="M ${x1 - 16} ${y - 11} L ${x1 - 16} ${y + 11} L ${x1} ${y} Z" fill="${LIGNE}"/>
${jalons.join("\n")}
</svg>`;
}

async function rasterize(svg) {
  const fontPaths = await readGameFontPaths();
  const resvg = new Resvg(Buffer.from(texteAffichable(svg), "utf8"), {
    fitTo: { mode: "width", value: LARGEUR },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

export const getFriseImage = (frise) => rasterize(buildFriseSvg(frise));
export const getDecorImage = () => rasterize(buildDecorSvg());
