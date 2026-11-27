// ============================================================
// coffreImage.js — Images du Coffre, format paysage 900 × 600, sur le décor
// illustré (coffre fermé ou ouvert à droite, mur libre à gauche) :
// - plateau privé (éphémère) : rendu sans état depuis le paramètre `d` de
//   l'URL (encodePlateau), qui porte les essais ET leurs réponses déjà
//   calculées par le serveur : l'URL ne permet donc pas de tester un code ;
// - jour (message public) : les 6 symboles du jeu, rien de secret ;
// - code (résultat) : code d'un jour déjà résolu (historique uniquement).
// SVG rastérisé par @resvg/resvg-js puis encodé en JPEG (fond peint).
// Fonds lus depuis Vercel Blob (chemins complets, jamais de constante de
// dossier) : `npm run assets:upload-blob -- coffre/images`.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { readBlobAsset, readGameFontPaths } from "@clash/commun/blobAssets.js";
import { SYMBOLES, IDS_SYMBOLES, symbole, texteIndiceCourt } from "./coffre.js";

const FOND_FERME = "coffre/images/coffre-fond.jpg";
const FOND_OUVERT = "coffre/images/coffre-ouvert.jpg";
const ILLUSTRATION_IMAGE_PATH = "coffre/images/coffre-start.webp";

const FONT_FAMILY = "Inter";
const W = 900;
const H = 600;
const QUALITE_JPEG = 85;
const OR = "#f5c542";
const BLANC = "#ffffff";
const GRIS = "#a9adc6";
const VERT = "#3ecf6a";
const PANNEAU = "#0d0818";

const fondCache = new Map();
async function fondBase64(chemin) {
  if (!fondCache.has(chemin)) fondCache.set(chemin, (await readBlobAsset(chemin)).toString("base64"));
  return fondCache.get(chemin);
}

// ── Formes (forme ET couleur distinctes) ─────────────────────────

export function forme(id, cx, cy, r) {
  const c = symbole(id)?.couleur ?? GRIS;
  const st = `fill="${c}" stroke="#140c08" stroke-width="3"`;
  switch (id) {
    case "rond":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" ${st}/>`;
    case "carre":
      return `<rect x="${cx - r * 0.85}" y="${cy - r * 0.85}" width="${r * 1.7}" height="${r * 1.7}" rx="6" ${st}/>`;
    case "losange":
      return `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" ${st}/>`;
    case "triangle":
      return `<polygon points="${cx},${cy - r} ${cx + r},${cy + r * 0.8} ${cx - r},${cy + r * 0.8}" ${st}/>`;
    case "etoile": {
      const p = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        p.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon points="${p.join(" ")}" ${st}/>`;
    }
    case "coeur":
      return `<path d="M ${cx} ${cy + r * 0.9} C ${cx - r * 1.4} ${cy - r * 0.1}, ${cx - r * 0.7} ${cy - r * 1.2}, ${cx} ${cy - r * 0.45} C ${cx + r * 0.7} ${cy - r * 1.2}, ${cx + r * 1.4} ${cy - r * 0.1}, ${cx} ${cy + r * 0.9} Z" ${st}/>`;
    default:
      return `<circle cx="${cx}" cy="${cy}" r="${r - 6}" fill="none" stroke="${GRIS}" stroke-width="3" stroke-dasharray="6 6"/>`;
  }
}

// ── Encodage du plateau dans l'URL (sans état) ────────────────────

// `plateau` : { jour, duree, essaisMax, essais: [{ symboles, bien, mal }],
// ouvert, points, indice }
export function encodePlateau({ jour, duree, essaisMax, essais, ouvert, points, indice }) {
  const compact = {
    j: jour,
    n: duree,
    m: essaisMax,
    e: essais.map((e) => `${e.symboles.map((s) => IDS_SYMBOLES.indexOf(s)).join("")}${e.bien}${e.mal}`),
    o: ouvert ? 1 : 0,
    p: points ?? 0,
    i: indice ? [indice.type, IDS_SYMBOLES.indexOf(indice.symbole), indice.position ?? -1] : null,
  };
  return Buffer.from(JSON.stringify(compact)).toString("base64url");
}

const entier = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Décode et valide (null si invalide)
export function decodePlateau(param) {
  try {
    const c = JSON.parse(Buffer.from(String(param ?? ""), "base64url").toString("utf-8"));
    if (!entier(c.j, 1, 99) || !entier(c.n, 1, 99) || !entier(c.m, 1, 9) || !Array.isArray(c.e) || c.e.length > c.m) return null;
    const essais = c.e.map((s) => {
      if (!/^[0-5]{4}[0-4][0-4]$/.test(s)) throw new Error("essai");
      return { symboles: [...s.slice(0, 4)].map((x) => IDS_SYMBOLES[Number(x)]), bien: Number(s[4]), mal: Number(s[5]) };
    });
    let indice = null;
    if (Array.isArray(c.i)) {
      const [type, s, p] = c.i;
      if (!["absent", "position", "ailleurs", "pasEn"].includes(type) || !entier(s, 0, 5) || !entier(p, -1, 3)) return null;
      indice = { type, symbole: IDS_SYMBOLES[s], ...(p >= 0 ? { position: p } : {}) };
    }
    return { jour: c.j, duree: c.n, essaisMax: c.m, essais, ouvert: c.o === 1, points: entier(c.p, 0, 9) ? c.p : 0, indice };
  } catch {
    return null;
  }
}

// ── Cadre commun ──────────────────────────────────────────────────

function cadre(fond, contenu) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}" font-weight="700">
  <defs>
    <linearGradient id="haut" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PANNEAU}" stop-opacity="0.85"/><stop offset="1" stop-color="${PANNEAU}" stop-opacity="0"/></linearGradient>
  </defs>
  <image href="data:image/jpeg;base64,${fond}" x="0" y="0" width="${W}" height="${H}"/>
  <rect x="0" y="0" width="${W}" height="100" fill="url(#haut)"/>
  ${contenu}
</svg>`;
}

const titre = (jour, duree) =>
  `<text x="30" y="60" font-size="44" fill="${OR}">LE COFFRE</text>
  <text x="300" y="60" font-size="36" fill="${BLANC}">Jour ${jour}/${duree}</text>`;

// Pastille (texte en haut à droite, au-dessus du coffre)
const pastille = (lignes, couleur = BLANC) => {
  const h = 30 + lignes.length * 44;
  return `<rect x="604" y="24" width="282" height="${h}" rx="16" fill="${PANNEAU}" fill-opacity="0.82" stroke="${OR}" stroke-width="2"/>
  ${lignes.map((l, i) => `<text x="745" y="${70 + i * 44}" text-anchor="middle" font-size="${i ? 36 : 40}" fill="${i ? GRIS : couleur}">${l}</text>`).join("")}`;
};

// ── Plateau privé ─────────────────────────────────────────────────

export function buildPlateauSvg(plateau, fond) {
  const { jour, duree, essaisMax, essais, ouvert, points, indice } = plateau;
  const X0 = 30;
  const Y0 = 96;
  const PAS_Y = Math.min(80, Math.floor(400 / essaisMax));
  const R = 28;
  let rangees = `<rect x="${X0 - 12}" y="${Y0 - 8}" width="588" height="${essaisMax * PAS_Y + 16}" rx="20" fill="${PANNEAU}" fill-opacity="0.72"/>`;
  for (let i = 0; i < essaisMax; i++) {
    const y = Y0 + i * PAS_Y + PAS_Y / 2;
    const e = essais[i];
    rangees += `<text x="${X0 + 12}" y="${y + 13}" font-size="36" fill="${GRIS}">${i + 1}</text>`;
    for (let k = 0; k < 4; k++) {
      rangees += forme(e ? e.symboles[k] : null, X0 + 88 + k * 86, y, R);
    }
    if (e) {
      const bx = X0 + 88 + 4 * 86 - 16;
      rangees += `<rect x="${bx}" y="${y - 25}" width="66" height="50" rx="12" fill="${VERT}"/><text x="${bx + 33}" y="${y + 13}" text-anchor="middle" font-size="36" fill="#0f2a18">${e.bien}</text>`;
      rangees += `<rect x="${bx + 76}" y="${y - 25}" width="66" height="50" rx="12" fill="${OR}"/><text x="${bx + 109}" y="${y + 13}" text-anchor="middle" font-size="36" fill="#3a2a00">${e.mal}</text>`;
    }
  }

  const restants = essaisMax - essais.length;
  const etat = ouvert
    ? pastille([`+${points} point${points > 1 ? "s" : ""}`, "coffre ouvert"], OR)
    : restants > 0
      ? pastille([`${restants} essai${restants > 1 ? "s" : ""}`, restants > 1 ? "restants" : "restant"])
      : pastille(["Plus d'essai", "à demain !"]);

  const yIndice = Y0 + essaisMax * PAS_Y + 22;
  const blocIndice = indice
    ? `<rect x="${X0 - 12}" y="${yIndice}" width="588" height="${H - yIndice - 14}" rx="20" fill="${PANNEAU}" fill-opacity="0.82" stroke="${OR}" stroke-width="2"/>
  ${forme(indice.symbole, X0 + 32, yIndice + 41, 24)}
  <text x="${X0 + 70}" y="${yIndice + 54}" font-size="36" fill="${BLANC}">${texteIndiceCourt(indice)}</text>`
    : "";

  return cadre(fond, `${titre(jour, duree)}${rangees}${etat}${blocIndice}`);
}

// ── Image du jour (message public) ────────────────────────────────

export function buildJourSvg({ jour, duree }, fond) {
  const symboles = SYMBOLES.map((s, i) => forme(s.id, 80 + (i % 3) * 150, 220 + Math.floor(i / 3) * 130, 44)).join("");
  return cadre(
    fond,
    `${titre(jour, duree)}
  <rect x="18" y="120" width="460" height="330" rx="20" fill="${PANNEAU}" fill-opacity="0.72"/>
  ${symboles}
  <rect x="18" y="470" width="580" height="110" rx="20" fill="${PANNEAU}" fill-opacity="0.82" stroke="${OR}" stroke-width="2"/>
  <text x="308" y="516" text-anchor="middle" font-size="36" fill="${BLANC}">Code de 4 symboles différents</text>
  <text x="308" y="560" text-anchor="middle" font-size="36" fill="${OR}">5 essais pour l'ouvrir</text>`,
  );
}

// ── Code d'un jour résolu (résultat) ──────────────────────────────

// `entry` : entrée d'historique { jour, code, joueurs, ouverts }
export function buildCodeSvg(entry, duree, fond) {
  const formes = entry.code.map((s, k) => forme(s, 92 + k * 132, 260, 50)).join("");
  const bilan = entry.joueurs
    ? `${entry.ouverts} coffre${entry.ouverts > 1 ? "s" : ""} ouvert${entry.ouverts > 1 ? "s" : ""} sur ${entry.joueurs}`
    : "Personne n'a joué";
  return cadre(
    fond,
    `${titre(entry.jour, duree)}
  <rect x="18" y="120" width="560" height="260" rx="20" fill="${PANNEAU}" fill-opacity="0.78" stroke="${OR}" stroke-width="2"/>
  <text x="298" y="180" text-anchor="middle" font-size="38" fill="${OR}">Le code était</text>
  ${formes}
  <text x="298" y="360" text-anchor="middle" font-size="36" fill="${BLANC}">${bilan}</text>`,
  );
}

// ── Rendu ─────────────────────────────────────────────────────────

async function rendre(svg) {
  const fontPaths = await readGameFontPaths();
  const rendu = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  }).render();
  const buffer = Buffer.from(jpeg.encode({ data: rendu.pixels, width: rendu.width, height: rendu.height }, QUALITE_JPEG).data);
  return { buffer, mimeType: "image/jpeg" };
}

export async function getPlateauImage(plateau) {
  return rendre(buildPlateauSvg(plateau, await fondBase64(plateau.ouvert ? FOND_OUVERT : FOND_FERME)));
}

export async function getJourImage(jour, duree) {
  return rendre(buildJourSvg({ jour, duree }, await fondBase64(FOND_FERME)));
}

export async function getCodeImage(entry, duree) {
  return rendre(buildCodeSvg(entry, duree, await fondBase64(FOND_OUVERT)));
}

export async function getIllustrationImage() {
  return { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
}
