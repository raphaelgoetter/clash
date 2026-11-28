// ============================================================
// pilepoilImage.js — Images de Pile Poil, 600 px de large (portrait),
// style sombre à tuiles plates :
// - plateau privé (éphémère) : rendu sans état depuis le paramètre `d` de
//   l'URL (encodePlateau), qui porte les essais ET leurs retours déjà
//   calculés par le serveur : l'URL ne permet donc pas de tester un essai ;
// - récap d'un jour clos : grilles colorées des joueurs, sans chiffres.
// SVG rastérisé par @resvg/resvg-js (police embarquée, readGameFontPaths),
// encodé en PNG. Lisibilité mobile : aucun texte de moins de 24 px.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import { texteAffichable, tronquer } from "@clash/commun/texteImage.js";
import { BIEN, PRESENT, ABSENT, etatPave } from "./pilepoilRules.js";

const FONT_FAMILY = "Inter";
const W = 600;
const FOND = "#15131f";
const CASE = "#26233a";
const BORD = "#3a3655";
const SIGNE = "#3a3655";
const BLANC = "#ffffff";
const GRIS_TEXTE = "#a9adc6";
const COULEURS = { [BIEN]: "#3ecf6a", [PRESENT]: "#f5c542", [ABSENT]: "#4a4760" };
// Texte sombre sur vert et jaune, blanc sur gris
const TEXTE_SUR = { [BIEN]: "#16131f", [PRESENT]: "#16131f", [ABSENT]: BLANC };
// Rang des cases de chiffres dans les 8 caractères de l'égalité
const POSITIONS_CHIFFRES = [0, 1, 3, 4, 6, 7];

const echapper = (texte) =>
  texteAffichable(texte).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── Encodage du plateau dans l'URL (sans état) ────────────────────

// `plateau` : { jour, signe, essaisMax, essais: [{ chiffres, retour }], trouve }
export function encodePlateau({ jour, signe, essaisMax, essais, trouve }) {
  const compact = {
    j: jour,
    s: signe === "-" ? "-" : "+",
    m: essaisMax,
    e: essais.map((e) => `${e.chiffres}${e.retour.join("")}`),
    t: trouve ? 1 : 0,
  };
  return Buffer.from(JSON.stringify(compact)).toString("base64url");
}

const entier = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Décode et valide (null si invalide)
export function decodePlateau(param) {
  try {
    const c = JSON.parse(Buffer.from(String(param ?? ""), "base64url").toString("utf-8"));
    if (!entier(c.j, 1, 99999) || !["+", "-"].includes(c.s) || !entier(c.m, 1, 9) || !Array.isArray(c.e) || c.e.length > c.m) return null;
    const essais = c.e.map((s) => {
      if (!/^\d{6}[0-2]{6}$/.test(s)) throw new Error("essai");
      return { chiffres: s.slice(0, 6), retour: [...s.slice(6)].map(Number) };
    });
    return { jour: c.j, signe: c.s, essaisMax: c.m, essais, trouve: c.t === 1 };
  } catch {
    return null;
  }
}

// ── Plateau ───────────────────────────────────────────────────────

const C = 58;
const G = 8;
const X0 = (W - (8 * C + 7 * G)) / 2;

function texte(x, y, contenu, { taille = 24, couleur = BLANC, ancre = "middle", opacite = 1 } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${ancre}" font-size="${taille}" fill="${couleur}"${opacite < 1 ? ` opacity="${opacite}"` : ""}>${echapper(contenu)}</text>`;
}

// Une ligne de 8 cases : chiffres colorés selon le retour, signe et `=` fixes
function ligne(y, signe, essai) {
  let s = "";
  const signes = { 2: signe === "-" ? "−" : "+", 5: "=" };
  for (let i = 0; i < 8; i++) {
    const x = X0 + i * (C + G);
    if (signes[i]) {
      s += `<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="10" fill="${SIGNE}"/>`;
      s += texte(x + C / 2, y + C / 2 + 13, signes[i], { taille: 38, couleur: GRIS_TEXTE });
      continue;
    }
    const k = POSITIONS_CHIFFRES.indexOf(i);
    if (!essai) {
      s += `<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="10" fill="${CASE}" stroke="${BORD}" stroke-width="2.5"/>`;
      continue;
    }
    const etat = essai.retour[k];
    s += `<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="10" fill="${COULEURS[etat]}"/>`;
    s += texte(x + C / 2, y + C / 2 + 13, essai.chiffres[k], { taille: 38, couleur: TEXTE_SUR[etat] });
  }
  return s;
}

function pave(y, essais) {
  const P = 48;
  const PG = 8;
  const px = (W - (10 * P + 9 * PG)) / 2;
  const etats = etatPave(essais);
  let s = "";
  for (let k = 0; k < 10; k++) {
    const d = (k + 1) % 10; // 1 … 9 puis 0, comme un clavier
    const etat = etats[d];
    const x = px + k * (P + PG);
    const fill = etat === null ? CASE : COULEURS[etat];
    s += `<rect x="${x}" y="${y}" width="${P}" height="${P + 10}" rx="10" fill="${fill}"${etat === null ? ` stroke="${BORD}" stroke-width="2"` : ""}/>`;
    s += texte(x + P / 2, y + P / 2 + 15, String(d), {
      taille: 32,
      couleur: etat === null ? BLANC : TEXTE_SUR[etat],
      opacite: etat === ABSENT ? 0.55 : 1,
    });
  }
  return s;
}

export function buildPlateauSvg({ jour, signe, essaisMax, essais, trouve }) {
  const Y0 = 120;
  const yPave = Y0 + essaisMax * (C + G) + 30;
  const H = yPave + 58 + 34;
  const etat = trouve ? `Trouvé en ${essais.length} essai${essais.length > 1 ? "s" : ""} !` : `Essai ${essais.length}/${essaisMax}`;
  let s = texte(W / 2, 58, "Pile Poil", { taille: 44 });
  s += texte(W / 2, 94, `n°${jour} · ${etat}`, { taille: 24, couleur: trouve ? COULEURS[BIEN] : GRIS_TEXTE });
  for (let l = 0; l < essaisMax; l++) s += ligne(Y0 + l * (C + G), signe, essais[l]);
  s += pave(yPave, essais);
  return cadre(H, s);
}

// ── Récap d'un jour (grilles sans chiffres) ───────────────────────

const COLONNES = 3;
const MINI = 20;
const MINI_G = 3;
const MINI_GROUPE = 8;
const CARTE_W = 180;
const CARTE_H = 34 + 6 * (MINI + MINI_G) + 16;

// `grilles` : [{ nom, retours: [[6 états]…], trouve }]
export function buildRecapSvg({ jour, grilles, essaisMax = 6 }) {
  const lignesCartes = Math.max(1, Math.ceil(grilles.length / COLONNES));
  const Y0 = 110;
  const H = Y0 + lignesCartes * (CARTE_H + 16) + 10;
  const gx = (W - COLONNES * CARTE_W) / (COLONNES + 1);
  let s = texte(W / 2, 56, `Pile Poil n°${jour}`, { taille: 40 });
  s += texte(W / 2, 92, grilles.length ? "Les grilles d'hier" : "Personne n'a joué", { taille: 24, couleur: GRIS_TEXTE });
  grilles.forEach((g, i) => {
    const x = gx + (i % COLONNES) * (CARTE_W + gx);
    const y = Y0 + Math.floor(i / COLONNES) * (CARTE_H + 16);
    s += `<rect x="${x}" y="${y}" width="${CARTE_W}" height="${CARTE_H}" rx="14" fill="#1d1a2b" stroke="${BORD}" stroke-width="2"/>`;
    s += texte(x + CARTE_W / 2, y + 28, tronquer(g.nom, 10), { taille: 24, couleur: g.trouve ? BLANC : GRIS_TEXTE });
    // 6 cases de chiffres par ligne, groupées par 2 (les trois nombres) :
    // sans les cases du signe et du `=`, qui se confondraient avec le gris
    const largeur = 6 * MINI + 5 * MINI_G + 2 * MINI_GROUPE;
    const mx = x + (CARTE_W - largeur) / 2;
    for (let l = 0; l < essaisMax; l++) {
      const r = g.retours[l];
      for (let k = 0; k < 6; k++) {
        const cx = mx + k * (MINI + MINI_G) + Math.floor(k / 2) * MINI_GROUPE;
        s += `<rect x="${cx}" y="${y + 40 + l * (MINI + MINI_G)}" width="${MINI}" height="${MINI}" rx="4" fill="${r ? COULEURS[r[k]] : CASE}"${r ? "" : ` stroke="${BORD}" stroke-width="1.5"`}/>`;
      }
    }
  });
  return cadre(H, s);
}

// ── Rendu ─────────────────────────────────────────────────────────

function cadre(H, contenu) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}" font-weight="700">
  <rect width="${W}" height="${H}" fill="${FOND}"/>
  ${contenu}
</svg>`;
}

async function rendre(svg) {
  const fontPaths = await readGameFontPaths();
  const rendu = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  }).render();
  return { buffer: rendu.asPng(), mimeType: "image/png" };
}

export const getPlateauImage = (plateau) => rendre(buildPlateauSvg(plateau));
export const getRecapImage = (recap) => rendre(buildRecapSvg(recap));
