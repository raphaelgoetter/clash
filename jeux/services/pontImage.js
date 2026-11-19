// ============================================================
// pontImage.js — Images du Pont du Troll, format paysage 900 × 600 (le plus
// grand affichage possible dans Discord), sur un décor illustré fixe (pierre à gauche, cordes à
// droite, troll dans le ravin) :
// - matin (message du jour) : multiplicateurs à l'entrée de chaque pont,
//   règle ou événement du jour, troll endormi. Aucune répartition ;
// - résultat (message du lendemain) : avatars Discord des passants en deux
//   files sur chaque tablier (rouge = attrapés, or = gagnants), troll qui
//   attrape le pont concerné, gain par passant.
// SVG rastérisé par @resvg/resvg-js puis encodé en JPEG (fond photo).
// Fonds et illustration d'annonce lus depuis Vercel Blob (chemins complets,
// jamais de constante de dossier) : `npm run assets:upload-blob -- pont/images`.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { texteAffichable } from "@clash/commun/texteImage.js";
import { readBlobAsset, readGameFontPaths } from "@clash/commun/blobAssets.js";
import { avatarDataUrl } from "./avatarsDiscord.js";
import { PIERRE, CORDES, REPU, FINALE, formatPieces } from "./pont.js";

const FOND_ENDORMI = "pont/images/pont-fond.jpg";
const FOND_ATTRAPE = { [PIERRE]: "pont/images/pont-troll-gauche.jpg", [CORDES]: "pont/images/pont-troll-droite.jpg" };
const ILLUSTRATION_IMAGE_PATH = "pont/images/pont-start.webp";

const FONT_FAMILY = "Inter";
// Paysage 3:2 : Discord plafonne la hauteur d'affichage (~350 px sur
// ordinateur), un format large affiche l'image bien plus grande qu'un portrait
const W = 900;
const H = 600;
const QUALITE_JPEG = 85;
const OR = "#f5c542";
const ROUGE = "#ff4d4f";
const BLANC = "#ffffff";
const NOM = { [PIERRE]: "Pierre", [CORDES]: "Cordes" };
const COTE_ECRAN = { [PIERRE]: "gauche", [CORDES]: "droite" };

// Axe central de chaque tablier sur le décor, en (y, x), du proche au lointain
const AXES = {
  gauche: [[480, 120], [400, 150], [300, 190], [200, 258], [130, 350]],
  droite: [[480, 768], [400, 738], [300, 688], [200, 620], [130, 555]],
};
const Y_PROCHE = 385;
const Y_LOIN = 140;

function xSur(cote, y) {
  const pts = AXES[cote];
  for (let i = 0; i < pts.length - 1; i++) {
    const [y1, x1] = pts[i];
    const [y2, x2] = pts[i + 1];
    if (y <= y1 && y >= y2) return x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
  }
  return pts.at(-1)[1];
}

const fondCache = new Map();
async function fondBase64(chemin) {
  if (!fondCache.has(chemin)) fondCache.set(chemin, (await readBlobAsset(chemin)).toString("base64"));
  return fondCache.get(chemin);
}

// ── Éléments SVG ──────────────────────────────────────────────────

// Positions des avatars d'un pont : deux files décalées (trois au-delà de
// 16 passants), tous affichés, plus petits au loin ; peu nombreux, ils
// restent groupés à l'entrée.
export function positionsPassants(cote, n) {
  const files = n > 16 ? 3 : 2;
  const rangs = Math.ceil(n / files);
  const haut = Math.max(Y_LOIN, Y_PROCHE - (rangs - 1) * 48);
  const out = [];
  for (let i = 0; i < n; i++) {
    const rang = Math.floor(i / files);
    const file = i % files;
    const t = rangs === 1 ? 0 : rang / (rangs - 1);
    const decale = file % 2 ? 10 * (1 - t * 0.6) : 0;
    const y = Y_PROCHE - (Y_PROCHE - haut) * Math.pow(t, 0.85) - decale;
    const p = (y - Y_LOIN) / (Y_PROCHE - Y_LOIN); // 1 = près, 0 = loin
    const demiLargeur = 30 + 80 * p;
    const pas = rangs === 1 ? 99 : ((Y_PROCHE - haut) / (rangs - 1)) * (0.6 + 0.6 * p);
    const r = Math.max(8, Math.min(30 * (0.4 + 0.6 * p), demiLargeur / files, pas * 0.8));
    // Files réparties sur la largeur du tablier
    const position = files === 2 ? (file ? 1 : -1) * 0.42 : (file - 1) * 0.6;
    out.push({ x: xSur(cote, y) + position * demiLargeur, y, r });
  }
  return out;
}

let clipSeq = 0;
function medaillons(cote, dataUrls, couleur) {
  const pos = positionsPassants(cote, dataUrls.length);
  // Du plus lointain au plus proche : les proches passent devant
  return pos
    .map((p, i) => ({ ...p, url: dataUrls[i] }))
    .reverse()
    .map(({ x, y, r, url }) => {
      const id = `pa${clipSeq++}`;
      const cy = y - r;
      return `<clipPath id="${id}"><circle cx="${x}" cy="${cy}" r="${r}"/></clipPath>
      <circle cx="${x}" cy="${cy}" r="${r + 2.5}" fill="${couleur}" stroke="#140c08" stroke-width="1.5"/>
      ${url ? `<image href="${url}" x="${x - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${id})"/>` : ""}`;
    })
    .join("");
}

// Étiquette à l'entrée d'un pont : nom + multiplicateur, et nombre de
// passants au résultat
function etiquette(cote, mult, res) {
  const cx = COTE_ECRAN[cote] === "gauche" ? 140 : 760;
  const y = res ? 392 : 430;
  const l = 250;
  const bord = res ? res.couleur : OR;
  const ligne2 = res
    ? `<text x="${cx}" y="${y + 85}" text-anchor="middle" font-size="36" fill="${res.couleur}">${res.n} passant${res.n > 1 ? "s" : ""}</text>`
    : "";
  return `<rect x="${cx - l / 2}" y="${y}" width="${l}" height="${res ? 102 : 56}" rx="14" fill="#120c1c" fill-opacity="0.82" stroke="${bord}" stroke-width="3"/>
  <text x="${cx}" y="${y + 41}" text-anchor="middle" font-size="36" fill="${BLANC}">${NOM[cote]} <tspan fill="${OR}">×${mult}</tspan></text>${ligne2}`;
}

function cadre(fond, contenu, droite, [l1, l2], { l1Or = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}" font-weight="700">
  <defs>
    <linearGradient id="haut" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0818" stop-opacity="0.85"/><stop offset="1" stop-color="#0d0818" stop-opacity="0"/></linearGradient>
    <linearGradient id="bas" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0818" stop-opacity="0"/><stop offset="0.35" stop-color="#0d0818" stop-opacity="0.8"/><stop offset="1" stop-color="#0d0818" stop-opacity="0.92"/></linearGradient>
  </defs>
  <image href="data:image/jpeg;base64,${fond}" x="0" y="0" width="${W}" height="${H}"/>
  <rect x="0" y="0" width="${W}" height="90" fill="url(#haut)"/>
  <text x="28" y="50" font-size="40" fill="${OR}">PONT DU TROLL</text>
  <text x="${W - 28}" y="50" text-anchor="end" font-size="36" fill="${BLANC}">${droite}</text>
  <rect x="0" y="${H - 125}" width="${W}" height="125" fill="url(#bas)"/>
  ${contenu}
  <text x="${W / 2}" y="${l2 ? 543 : 565}" text-anchor="middle" font-size="36" fill="${l1Or ? OR : BLANC}">${l1}</text>
  ${l2 ? `<text x="${W / 2}" y="586" text-anchor="middle" font-size="36" fill="${l1Or ? BLANC : OR}">${l2}</text>` : ""}
</svg>`;
}

// ── Textes de la corniche (purs, testés) ──────────────────────────

export function lignesMatin(evenement) {
  if (evenement === REPU) return ["Troll repu aujourd'hui !", "Il attrape le pont le moins chargé"];
  if (evenement === FINALE) return ["Grande finale !", "Gains doublés aujourd'hui"];
  return ["Le troll attrape le pont le plus chargé"];
}

const SUR = { [PIERRE]: "sur la pierre", [CORDES]: "sur les cordes" };

const piecesTexte = (c) => `${formatPieces(c)} pièce${c >= 200 ? "s" : ""}`;

export function lignesResultat({ attrape, gagnant, gainBase, gainParCote = {}, pierre, cordes }) {
  const nA = attrape === PIERRE ? pierre : attrape === CORDES ? cordes : 0;
  const nG = gagnant === PIERRE ? pierre : cordes;
  // Personne d'attrapé : chacun gagne le multiplicateur de son pont
  if (!attrape || nA === 0) {
    if (pierre + cordes === 0) return ["Personne n'a traversé"];
    return [
      attrape ? "Le troll n'attrape personne" : "Égalité : le troll hésite",
      `Pierre +${formatPieces(gainParCote[PIERRE] ?? 0)} · Cordes +${piecesTexte(gainParCote[CORDES] ?? 0)} chacun`,
    ];
  }
  const l1 = `${nA} passant${nA > 1 ? "s" : ""} attrapé${nA > 1 ? "s" : ""} ${SUR[attrape]}`;
  if (nG === 0) return [l1, "Personne en face pour le butin"];
  const g = formatPieces(gainBase);
  return [l1, `${NOM[gagnant]} : +${g} pièce${gainBase >= 200 ? "s" : ""} chacun`];
}

// ── Rendu ─────────────────────────────────────────────────────────

async function rendre(svg) {
  const fontPaths = await readGameFontPaths();
  const rendu = new Resvg(texteAffichable(svg), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  }).render();
  const buffer = Buffer.from(jpeg.encode({ data: rendu.pixels, width: rendu.width, height: rendu.height }, QUALITE_JPEG).data);
  return { buffer, mimeType: "image/jpeg" };
}

// `cfg` : jourConfig() ; `duree` : nombre de jours de la partie
export async function buildMatinSvg(cfg, duree) {
  const fond = await fondBase64(FOND_ENDORMI);
  return cadre(
    fond,
    `${etiquette(PIERRE, cfg.pierre)}${etiquette(CORDES, cfg.cordes)}`,
    `Jour ${cfg.jour}/${duree}`,
    lignesMatin(cfg.evenement),
    { l1Or: Boolean(cfg.evenement) },
  );
}

export async function getMatinImage(cfg, duree) {
  return rendre(await buildMatinSvg(cfg, duree));
}

// `entry` : entrée d'historique (voir postPont) ; `avatars` : { discordId:
// "id/hash" | "" }
export async function buildResultatSvg(entry, duree, avatars = {}) {
  const fond = await fondBase64(entry.attrape && entry[entry.attrape] > 0 ? FOND_ATTRAPE[entry.attrape] : FOND_ENDORMI);
  const couleur = (cote) => (entry.attrape === cote ? ROUGE : OR);
  let seq = 0;
  const urls = async (ids) => Promise.all(ids.map((id) => avatarDataUrl(avatars[id] || null, seq++)));
  const [urlsPierre, urlsCordes] = [await urls(entry.passants[PIERRE]), await urls(entry.passants[CORDES])];
  return cadre(
    fond,
    `${medaillons("gauche", urlsPierre, couleur(PIERRE))}${medaillons("droite", urlsCordes, couleur(CORDES))}
    ${etiquette(PIERRE, entry.multiplicateurs.pierre, { n: entry.pierre, couleur: couleur(PIERRE) })}
    ${etiquette(CORDES, entry.multiplicateurs.cordes, { n: entry.cordes, couleur: couleur(CORDES) })}`,
    `Jour ${entry.jour}/${duree}`,
    lignesResultat(entry),
  );
}

export async function getResultatImage(entry, duree, avatars) {
  return rendre(await buildResultatSvg(entry, duree, avatars));
}

// Illustration d'annonce, servie telle quelle
let illustrationCache = null;
export async function getIllustrationImage() {
  if (!illustrationCache) {
    illustrationCache = { buffer: await readBlobAsset(ILLUSTRATION_IMAGE_PATH), mimeType: "image/webp" };
  }
  return illustrationCache;
}
