// ============================================================
// blackjackImage.js — Image de la main de Blackjack (jeu spécial et duel),
// format portrait pensé pour le mobile : tapis vert, main du Croupier /
// de Kévina en haut (absente en 1v1), main du joueur en bas, score en
// pastille à droite de chaque nom, légende en pied (jour ou manche).
// Cartes classiques dessinées en SVG (rang + couleur) ; au-delà de 3
// cartes, elles se chevauchent pour garder une largeur fixe.
// Même technique que potatoImage.js : SVG généré à la volée, rastérisé en
// PNG via @resvg/resvg-js, police Inter embarquée (Vercel Blob).
//
// Rendu sans état : la main est passée dans l'URL (encodeMain) ; l'URL
// change avec l'état, ce qui contourne le cache d'images de Discord.
// ⚠️ Anti-spoiler : quand le Croupier joue en second, l'URL ne contient
// NI ses cartes NI son score (`croupier.cache`), deux dos de carte seulement.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { texteAffichable, tronquer } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";

const FONT_FAMILY = "Inter";

const LARGEUR = 600;
const CW = 132;
const CH = 188;
const MARGE = 40;
const ROUGE_CARTE = "#c62828";
const NOIR_CARTE = "#1a1a1a";
const OR = "#f0c040";
const BLANC = "#ffffff";

// Couleur de la pastille de score selon l'issue de la main
const PASTILLES = {
  en_cours: "#1e5fa8",
  stand: "#1e5fa8",
  win: "#2e7d32",
  push: "#b8860b",
  lose: "#6d4c41",
  bust: "#c62828",
  cache: "#555555",
};

const RANGS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const COULEURS = ["♠", "♥", "♦", "♣"];
const STATUTS = ["en_cours", "stand", "bust"];
const ISSUES = ["win", "push", "lose"];
// Cartes affichées au plus par main (au-delà, illisible ; jamais atteint en
// pratique : 11 cartes font déjà plus de 21)
const MAX_CARTES = 12;

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// La police embarquée n'a pas d'emoji : retirés des pseudos
const sansEmoji = (nom) => String(nom).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim() || "?";

const texte = (x, y, contenu, { size = 20, fill = BLANC, anchor = "start", weight = 400, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" opacity="${opacity}">${escapeXml(contenu)}</text>`;

// ── Encodage dans l'URL ─────────────────────────────────────────────
// { j: [pseudo, cartes, score, statut, issue], c: croupier ou absent,
//   l: légende } ; cartes = "rang.couleur" par index (RANGS, COULEURS)
//   séparées par des virgules ; croupier = [nom, cartes, score] visible,
//   [nom] caché (joue en second) ; statut = index de STATUTS ; issue =
//   index de ISSUES, -1 si inconnue.

const versCartes = (cartes) =>
  cartes
    .slice(0, MAX_CARTES)
    .map((c) => `${Math.max(0, RANGS.indexOf(c.rank))}.${Math.max(0, COULEURS.indexOf(String(c.suit).replace(/\u{FE0F}/gu, "")))}`)
    .join(",");

function depuisCartes(s) {
  if (!s) return [];
  return String(s)
    .split(",")
    .slice(0, MAX_CARTES)
    .map((c) => {
      const [r, s2] = c.split(".").map(Number);
      return { rang: RANGS[r] ?? "?", couleur: COULEURS[s2] ?? "♠" };
    });
}

const borner = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));

/**
 * @param {object} p
 * @param {{ nom: string, cartes: object[], score: number, statut: string, issue?: string|null }} p.joueur
 * @param {{ nom: string, cartes?: object[], score?: number, cache?: boolean }|null} p.croupier
 *   null en 1v1 ; `cache` : joue en second, ni cartes ni score encodés
 * @param {string} p.legende texte du pied (« Jour 4/7 », « Manche 3/10 »…)
 */
export function encodeMain({ joueur, croupier = null, legende = "" }) {
  const d = {
    j: [
      tronquer(sansEmoji(joueur.nom), 18),
      versCartes(joueur.cartes),
      joueur.score,
      Math.max(0, STATUTS.indexOf(joueur.statut)),
      ISSUES.indexOf(joueur.issue ?? ""),
    ],
    l: tronquer(String(legende), 48),
  };
  if (croupier) {
    d.c = croupier.cache
      ? [tronquer(sansEmoji(croupier.nom), 18)]
      : [tronquer(sansEmoji(croupier.nom), 18), versCartes(croupier.cartes ?? []), croupier.score];
  }
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

// null si le paramètre est illisible.
export function decodeMain(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    if (!Array.isArray(d?.j)) return null;
    const [nom, cartes, score, statut, issue] = d.j;
    const main = {
      joueur: {
        nom: String(nom ?? "?"),
        cartes: depuisCartes(cartes),
        score: borner(score, 0, 99),
        statut: STATUTS[Number(statut)] ?? "en_cours",
        issue: ISSUES[Number(issue)] ?? null,
      },
      croupier: null,
      legende: String(d.l ?? ""),
    };
    if (Array.isArray(d.c)) {
      main.croupier =
        d.c.length === 1
          ? { nom: String(d.c[0] ?? "?"), cache: true }
          : { nom: String(d.c[0] ?? "?"), cartes: depuisCartes(d.c[1]), score: borner(d.c[2], 0, 99), cache: false };
    }
    return main;
  } catch {
    return null;
  }
}

// ── Dessin ──────────────────────────────────────────────────────────

function dosDeCarte(x, y) {
  return `<g transform="translate(${x},${y})"><rect width="${CW}" height="${CH}" rx="14" fill="#1f3a8a" stroke="${BLANC}" stroke-width="5"/>
    <rect x="12" y="12" width="${CW - 24}" height="${CH - 24}" rx="8" fill="none" stroke="${OR}" stroke-width="3"/>
    ${texte(CW / 2, CH / 2 + 20, "?", { size: 60, fill: OR, anchor: "middle", weight: 800 })}</g>`;
}

function faceDeCarte(x, y, { rang, couleur }, echelle = 1) {
  const fill = couleur === "♥" || couleur === "♦" ? ROUGE_CARTE : NOIR_CARTE;
  return `<g transform="translate(${x},${y}) scale(${echelle})"><rect width="${CW}" height="${CH}" rx="14" fill="#fdfdf8" stroke="#bbbbbb" stroke-width="2"/>
    ${texte(12, 40, rang, { size: 36, fill, weight: 800 })}
    ${texte(12, 72, couleur, { size: 30, fill })}
    ${texte(CW / 2 + 10, CH / 2 + 42, couleur, { size: 80, fill, anchor: "middle" })}</g>`;
}

// Rangée centrée sur `centre`, dans une largeur `place` ; au-delà de 3
// cartes, chevauchement à largeur fixe
function rangee(cartes, y, dessin, { echelle = 1, centre = LARGEUR / 2, place = LARGEUR - 2 * MARGE } = {}) {
  const n = cartes.length;
  if (!n) return "";
  const w = CW * echelle;
  const ecart = 12 * echelle;
  const pas = n <= 3 ? w + ecart : Math.min(w + ecart, (place - w) / (n - 1));
  const total = pas * (n - 1) + w;
  const x0 = centre - total / 2;
  return cartes.map((c, i) => dessin(x0 + i * pas, y, c, echelle)).join("");
}

function bandeau(y, nom, score, fond) {
  return `${texte(MARGE, y, nom, { size: 34, weight: 800 })}
  <g transform="translate(${LARGEUR - 80},${y - 12})"><rect x="-46" y="-30" width="92" height="52" rx="26" fill="${fond}" stroke="${BLANC}" stroke-width="3"/>
  ${texte(0, 9, score, { size: 32, weight: 800, anchor: "middle" })}</g>`;
}

const pastilleJoueur = (j) => (j.statut === "bust" ? PASTILLES.bust : PASTILLES[j.issue ?? j.statut]);

// Hauteur d'une zone : bandeau (nom + pastille) puis cartes
const ZONE_H = 96 + CH;
const PIED_H = 70;

export function buildMainSvg({ joueur, croupier, legende }) {
  const haut = 32;
  let y = haut;
  let contenu = "";
  if (croupier) {
    contenu += bandeau(y + 44, croupier.nom, croupier.cache ? "?" : String(croupier.score), PASTILLES.cache);
    contenu += croupier.cache
      ? rangee([0, 1], y + 78, (x, yy) => dosDeCarte(x, yy))
      : rangee(croupier.cartes, y + 78, faceDeCarte);
    y += ZONE_H + 16;
    contenu += `<line x1="60" y1="${y}" x2="${LARGEUR - 60}" y2="${y}" stroke="${OR}" stroke-width="2" stroke-dasharray="8 8" opacity="0.6"/>`;
    y += 16;
  }
  contenu += bandeau(y + 44, joueur.nom, String(joueur.score), pastilleJoueur(joueur));
  contenu += rangee(joueur.cartes, y + 78, faceDeCarte);
  y += ZONE_H;
  const hauteur = y + PIED_H;
  if (legende) contenu += texte(LARGEUR / 2, hauteur - 36, legende, { size: 26, anchor: "middle", opacity: 0.85 });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}">
<defs><radialGradient id="tapis" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#1e7a46"/><stop offset="1" stop-color="#0b3d22"/></radialGradient></defs>
<rect width="${LARGEUR}" height="${hauteur}" rx="28" fill="#5a3a1e"/>
<rect x="14" y="14" width="${LARGEUR - 28}" height="${hauteur - 28}" rx="20" fill="url(#tapis)"/>
${contenu}
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

export const getMainImage = (main) => rasterize(buildMainSvg(main));

// ── Image de fin du duel ────────────────────────────────────────────
// Contre Kévina : total en grand, score de chaque manche en pastilles
// colorées par l'issue, décompte, meilleure main de la partie (cartes).
// En 1v1 : vainqueur (ou égalité), une rangée de pastilles par joueur,
// numéros de manche entre les deux pour lire chaque manche en colonne,
// légende des couleurs, meilleure main de chacun.

const ISSUES_FIN = ["win", "push", "lose", "bust"];

// Meilleure main d'une partie : plus haut score sans dépassement, puis
// moins de cartes, puis la plus ancienne. null si toutes ont dépassé.
export function meilleureMain(mains) {
  let best = null;
  for (const m of mains) {
    if (m.statut === "bust" || m.score > 21) continue;
    if (!best || m.score > best.score || (m.score === best.score && m.cartes.length < best.cartes.length)) best = m;
  }
  return best;
}

/**
 * @param {object} p
 * @param {{ nom: string, points: number, manches: { score: number, issue: string }[],
 *   meilleure: { cartes: object[], score: number }|null }[]} p.joueurs 1 (contre Kévina) ou 2
 * @param {number} p.totalManches
 */
export function encodeFin({ joueurs, totalManches }) {
  const d = {
    t: totalManches,
    j: joueurs.slice(0, 2).map((j) => [
      tronquer(sansEmoji(j.nom), 18),
      j.points,
      j.manches
        .slice(0, 10)
        .map((m) => `${borner(m.score, 0, 99)}.${Math.max(0, ISSUES_FIN.indexOf(m.issue))}`)
        .join(","),
      j.meilleure ? versCartes(j.meilleure.cartes) : "",
      j.meilleure ? j.meilleure.score : 0,
    ]),
  };
  return Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
}

export function decodeFin(param) {
  try {
    const d = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    if (!Array.isArray(d?.j) || !d.j.length) return null;
    return {
      totalManches: borner(d.t, 1, 10),
      joueurs: d.j.slice(0, 2).map(([nom, points, manches, cartes, score]) => ({
        nom: String(nom ?? "?"),
        points: borner(points, 0, 99),
        manches: String(manches ?? "")
          .split(",")
          .filter(Boolean)
          .slice(0, 10)
          .map((m) => {
            const [sc, is] = m.split(".").map(Number);
            return { score: borner(sc, 0, 99), issue: ISSUES_FIN[is] ?? "lose" };
          }),
        meilleure: cartes ? { cartes: depuisCartes(cartes), score: borner(score, 0, 99) } : null,
      })),
    };
  } catch {
    return null;
  }
}

const pluriel = (n, mot, pl = `${mot}s`) => `${n} ${n > 1 ? pl : mot}`;
const pts = (n) => pluriel(n, "pt");

// Pastilles des manches, centrées, espacées de 53 px (10 manches au plus)
const PAS_PASTILLE = 53;
const xPastille = (i, n) => (LARGEUR - (n - 1) * PAS_PASTILLE) / 2 + i * PAS_PASTILLE;

function pastillesManches(manches, y) {
  return manches
    .map(
      (m, i) =>
        `<circle cx="${xPastille(i, manches.length)}" cy="${y}" r="21" fill="${PASTILLES[m.issue]}" stroke="${BLANC}" stroke-width="2"/>` +
        texte(xPastille(i, manches.length), y + 7, String(m.score), { size: 18, weight: 800, anchor: "middle" }),
    )
    .join("");
}

const separateur = (y) =>
  `<line x1="60" y1="${y}" x2="${LARGEUR - 60}" y2="${y}" stroke="${OR}" stroke-width="2" stroke-dasharray="8 8" opacity="0.6"/>`;

function cadreFin(hauteur, contenu) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}">
<defs><radialGradient id="tapis" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#1e7a46"/><stop offset="1" stop-color="#0b3d22"/></radialGradient></defs>
<rect width="${LARGEUR}" height="${hauteur}" rx="28" fill="#5a3a1e"/>
<rect x="14" y="14" width="${LARGEUR - 28}" height="${hauteur - 28}" rx="20" fill="url(#tapis)"/>
${contenu}
</svg>`;
}

function decompte(manches) {
  const n = (issue) => manches.filter((m) => m.issue === issue).length;
  return [
    n("win") && pluriel(n("win"), "victoire"),
    n("push") && pluriel(n("push"), "égalité"),
    n("lose") && pluriel(n("lose"), "défaite"),
    n("bust") && pluriel(n("bust"), "dépassement"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function buildFinSoloSvg({ joueurs: [j], totalManches }) {
  let c = texte(LARGEUR / 2, 80, j.nom, { size: 32, weight: 800, anchor: "middle" });
  c += texte(LARGEUR / 2, 170, String(j.points), { size: 96, weight: 800, anchor: "middle", fill: OR });
  c += texte(LARGEUR / 2, 205, `${j.points > 1 ? "points" : "point"} sur ${totalManches} manches`, { size: 22, anchor: "middle", opacity: 0.85 });
  c += pastillesManches(j.manches, 260);
  c += texte(LARGEUR / 2, 312, decompte(j.manches), { size: 19, anchor: "middle", opacity: 0.85 });
  c += separateur(345);
  if (!j.meilleure) {
    c += texte(LARGEUR / 2, 395, "Aucune main sans dépassement", { size: 22, weight: 700, anchor: "middle" });
    return cadreFin(440, c);
  }
  const { cartes, score } = j.meilleure;
  const titre = `Meilleure main : ${score}${cartes.length === 2 && score === 21 ? " en 2 cartes" : ""}`;
  c += texte(LARGEUR / 2, 390, titre, { size: 22, weight: 700, anchor: "middle" });
  c += rangee(cartes, 415, faceDeCarte, { echelle: 110 / CW });
  return cadreFin(640, c);
}

function buildFinPvpSvg({ joueurs }) {
  const [a, b] = joueurs;
  const titre = a.points === b.points ? "Égalité !" : `Victoire de ${a.points > b.points ? a.nom : b.nom} !`;
  let c = texte(LARGEUR / 2, 72, titre, { size: 32, weight: 800, anchor: "middle", fill: OR });
  const tete = Math.max(a.points, b.points);
  const bloc = (j, y) =>
    texte(MARGE, y, j.nom, { size: 28, weight: 800 }) +
    texte(LARGEUR - MARGE, y, pts(j.points), { size: 28, weight: 800, anchor: "end", fill: j.points === tete ? OR : BLANC }) +
    pastillesManches(j.manches, y + 44);
  c += bloc(a, 130);
  const n = Math.max(a.manches.length, b.manches.length);
  for (let i = 0; i < n; i++) c += texte(xPastille(i, n), 222, String(i + 1), { size: 16, anchor: "middle", opacity: 0.6 });
  c += bloc(b, 270);
  [["win", "Gagnée"], ["push", "Égalité"], ["lose", "Perdue"], ["bust", "Dépassé"]].forEach(([k, libelle], i) => {
    const x = 60 + i * 135;
    c += `<circle cx="${x}" cy="362" r="9" fill="${PASTILLES[k]}" stroke="${BLANC}" stroke-width="1.5"/>`;
    c += texte(x + 16, 369, libelle, { size: 18, opacity: 0.85 });
  });
  c += separateur(398);
  c += texte(LARGEUR / 2, 440, "Meilleures mains", { size: 22, weight: 700, anchor: "middle" });
  joueurs.forEach((j, i) => {
    const centre = LARGEUR / 4 + (i * LARGEUR) / 2;
    if (!j.meilleure) {
      c += texte(centre, 478, `${tronquer(j.nom, 12)} : aucune`, { size: 20, anchor: "middle", opacity: 0.9 });
      return;
    }
    c += texte(centre, 478, `${tronquer(j.nom, 12)} : ${j.meilleure.score}`, { size: 20, anchor: "middle", opacity: 0.9 });
    c += rangee(j.meilleure.cartes, 494, faceDeCarte, { echelle: 84 / CW, centre, place: LARGEUR / 2 - 70 });
  });
  return cadreFin(660, c);
}

export const buildFinSvg = (fin) => (fin.joueurs.length === 1 ? buildFinSoloSvg(fin) : buildFinPvpSvg(fin));
export const getFinImage = (fin) => rasterize(buildFinSvg(fin));
