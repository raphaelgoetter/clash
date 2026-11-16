// ============================================================
// gobeletImage.js — Images du Gobelet Duel, format portrait 600 px pensé
// pour le mobile, sur une piste de dés (cadre bois, feutrine violette) :
// - main du joueur (éphémère) : 5 dés réalistes (les dés gardés ne sont
//   montrés que par les boutons : un clic sur un dé ne recharge pas l'image),
//   tirages joués, combinaison retenue, grille des combinaisons
//   (réalisées barrées, celles de l'adversaire marquées d'un point) ;
// - dernière manche terminée (message public) : dés finaux, combinaison et
//   total de chaque joueur ;
// - fin de partie : total, points de chaque manche en pastilles, meilleure
//   combinaison avec ses dés.
// Même technique que blackjackImage.js : SVG généré à la volée, rastérisé
// en PNG via @resvg/resvg-js, police Inter embarquée (Vercel Blob). Rendu
// sans état : tout passe dans l'URL (encode*), qui change avec l'état, ce
// qui contourne le cache d'images de Discord.
// ============================================================

import { Resvg } from "@resvg/resvg-js";
import { texteAffichable, tronquer } from "@clash/commun/texteImage.js";
import { readGameFontPaths } from "@clash/commun/blobAssets.js";
import { COMBINATIONS, JOKER, NO_COMBINATION } from "./gobelet.js";

const FONT_FAMILY = "Inter";
const LARGEUR = 600;
const MARGE = 40;
const OR = "#f0c040";
const BLANC = "#ffffff";
const ADVERSAIRE = "#ff8a3d";

// Index stables dans les URL : combinaisons du barème, puis Joker, puis
// « Aucune combinaison »
const CATEGORIES = [...COMBINATIONS.map((c) => c.label), JOKER, NO_COMBINATION];
const STATUTS = ["en_cours", "choix", "termine"];
const MAX_MANCHES = 10;

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// La police embarquée n'a pas d'emoji : retirés des pseudos
const sansEmoji = (nom) => String(nom).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim() || "?";

const texte = (x, y, contenu, { size = 20, fill = BLANC, anchor = "start", weight = 400, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" opacity="${opacity}">${escapeXml(contenu)}</text>`;

const borner = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
const pluriel = (n, mot, pl = `${mot}s`) => `${n} ${n > 1 ? pl : mot}`;
const pts = (n) => pluriel(n, "pt");
const encoder = (d) => Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
const decoder = (param) => JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));

// Dés en chiffres (« 56332 »), 5 au plus
const versDes = (des) => (des ?? []).slice(0, 5).map((v) => borner(v, 1, 6)).join("");
const depuisDes = (s) =>
  String(s ?? "")
    .slice(0, 5)
    .split("")
    .map((c) => borner(c, 1, 6));
const indexCategorie = (c) => CATEGORIES.indexOf(c ?? "");
const categorie = (i) => CATEGORIES[Number(i)] ?? null;
// Combinaisons réalisées en masque de bits (index de CATEGORIES)
const versMasque = (liste = []) => liste.reduce((m, c) => (indexCategorie(c) >= 0 ? m | (1 << indexCategorie(c)) : m), 0);
const depuisMasque = (m) => CATEGORIES.filter((_, i) => (Number(m) || 0) & (1 << i));

// ── Dé réaliste ─────────────────────────────────────────────────────
// Cube ivoire arrondi : ombre portée floue, dégradé de face, biseau clair,
// points creusés (dégradé radial).

const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

const DEFS_DES = `<filter id="ombreDe" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
<linearGradient id="faceDe" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#f4efe4"/><stop offset="1" stop-color="#d9d0bf"/></linearGradient>
<linearGradient id="biseauDe" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<radialGradient id="pointDe" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4a4a4a"/><stop offset="0.6" stop-color="#151515"/><stop offset="1" stop-color="#000000"/></radialGradient>
<radialGradient id="feutrine" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#5e2f8c"/><stop offset="1" stop-color="#26103d"/></radialGradient>`;

// Dé de côté `t` centré en (cx, cy), incliné de `angle` degrés
function de(cx, cy, valeur, { t = 88, angle = 0 } = {}) {
  const r = t * 0.2;
  const ecart = t * 0.27;
  const rp = t * 0.085;
  const points = (PIPS[valeur] ?? PIPS[1])
    .map(([px, py]) => `<circle cx="${px * ecart}" cy="${py * ecart}" r="${rp}" fill="url(#pointDe)"/><circle cx="${px * ecart - rp * 0.3}" cy="${py * ecart - rp * 0.35}" r="${rp * 0.28}" fill="#ffffff" opacity="0.18"/>`)
    .join("");
  const h = t / 2;
  return `<g transform="translate(${cx},${cy}) rotate(${angle})">
  <rect x="${-h + 4}" y="${-h + 9}" width="${t}" height="${t}" rx="${r}" fill="#000" opacity="0.45" filter="url(#ombreDe)"/>
  <rect x="${-h}" y="${-h}" width="${t}" height="${t}" rx="${r}" fill="url(#faceDe)" stroke="#b9ae9a" stroke-width="1.5"/>
  <rect x="${-h + 4}" y="${-h + 4}" width="${t - 8}" height="${t - 8}" rx="${r - 3}" fill="none" stroke="url(#biseauDe)" stroke-width="3"/>
  ${points}</g>`;
}

// Légère inclinaison des dés lancés (fixe par position : rendu stable)
const ANGLES = [-7, 4, -3, 6, -5];

function rangeeDes(des, cy, { t = 86, centre = LARGEUR / 2, ecart = 16, incline = true } = {}) {
  const total = des.length * t + (des.length - 1) * ecart;
  const x0 = centre - total / 2 + t / 2;
  return des
    .map((v, i) => de(x0 + i * (t + ecart), cy, v, { t, angle: incline ? ANGLES[i % 5] : 0 }))
    .join("");
}

function cadre(hauteur, contenu) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${hauteur}" viewBox="0 0 ${LARGEUR} ${hauteur}">
<defs>${DEFS_DES}</defs>
<rect width="${LARGEUR}" height="${hauteur}" rx="28" fill="#5a3a1e"/>
<rect x="6" y="6" width="${LARGEUR - 12}" height="${hauteur - 12}" rx="24" fill="none" stroke="#7a5230" stroke-width="3"/>
<rect x="14" y="14" width="${LARGEUR - 28}" height="${hauteur - 28}" rx="20" fill="url(#feutrine)"/>
${contenu}
</svg>`;
}

const separateur = (y) =>
  `<line x1="60" y1="${y}" x2="${LARGEUR - 60}" y2="${y}" stroke="${OR}" stroke-width="2" stroke-dasharray="8 8" opacity="0.6"/>`;

// Pastille arrondie centrée en (cx, cy) avec un texte
function pastille(cx, cy, contenu, { fond, size = 24, padding = 22, hauteur = 44 } = {}) {
  const w = Math.max(hauteur, contenu.length * size * 0.6 + padding * 2);
  return `<rect x="${cx - w / 2}" y="${cy - hauteur / 2}" width="${w}" height="${hauteur}" rx="${hauteur / 2}" fill="${fond}" stroke="${BLANC}" stroke-width="2.5"/>${texte(cx, cy + size * 0.36, contenu, { size, weight: 800, anchor: "middle" })}`;
}

const libelleCombinaison = (category, points) =>
  category === NO_COMBINATION || !category ? "Aucune combinaison" : `${category} +${points}`;

// ── Main du joueur (éphémère) ───────────────────────────────────────
// { n: pseudo, d: dés, t: tirage, s: statut,
//   c: combinaison retenue (index, -1), p: points, u: réalisées (masque),
//   o: [pseudo adversaire, masque] ou absent, l: légende }

/**
 * @param {object} p
 * @param {string} p.nom
 * @param {number[]} p.des
 * @param {number} p.tirage 1 à 3
 * @param {string} p.statut en_cours | choix | termine
 * @param {string|null} p.category combinaison retenue (main terminée)
 * @param {number|null} p.points
 * @param {string[]} p.used combinaisons déjà réalisées par le joueur
 * @param {{ nom: string, used: string[] }|null} p.adversaire
 * @param {string} p.legende « Manche 2/5 »
 */
export function encodeMain({ nom, des, tirage, statut, category = null, points = null, used = [], adversaire = null, legende = "" }) {
  const d = {
    n: tronquer(sansEmoji(nom), 18),
    d: versDes(des),
    t: borner(tirage, 1, 3),
    s: Math.max(0, STATUTS.indexOf(statut)),
    c: indexCategorie(category),
    p: borner(points, 0, 99),
    u: versMasque(used),
    l: tronquer(String(legende), 40),
  };
  if (adversaire) d.o = [tronquer(sansEmoji(adversaire.nom || "Adversaire"), 14), versMasque(adversaire.used)];
  return encoder(d);
}

export function decodeMain(param) {
  try {
    const d = decoder(param);
    const des = depuisDes(d?.d);
    if (des.length !== 5) return null;
    return {
      nom: String(d.n ?? "?"),
      des,
      tirage: borner(d.t, 1, 3),
      statut: STATUTS[Number(d.s)] ?? "en_cours",
      category: categorie(d.c),
      points: borner(d.p, 0, 99),
      used: depuisMasque(d.u),
      adversaire: Array.isArray(d.o) ? { nom: String(d.o[0] ?? "Adversaire"), used: depuisMasque(d.o[1]) } : null,
      legende: String(d.l ?? ""),
    };
  } catch {
    return null;
  }
}

// ⚠️ Lisibilité mobile : l'embed s'affiche sur ~300 px de large au
// téléphone, soit la moitié de LARGEUR. Aucun texte sous 24 px ici (~12 px
// à l'écran), d'où les libellés courts de la grille.

// Indicateur des tirages : 3 petits gobelets pleins (joués) ou vides
function tirages(cx, cy, tirage) {
  return [0, 1, 2]
    .map((i) => {
      const x = cx + (i - 1) * 36;
      const plein = i < tirage;
      return `<path d="M${x - 13},${cy - 15} h26 l-4,30 h-18 z" fill="${plein ? OR : "none"}" stroke="${OR}" stroke-width="2.5" opacity="${plein ? 1 : 0.6}"/>`;
    })
    .join("");
}

// Libellés courts de la grille (les règles gardent les libellés complets)
const COURTS = { "Double quelconque": "Double", "Tout différent": "Tout diff.", "Petite Suite": "P. Suite", "Grande Suite": "G. Suite" };

// Grille des combinaisons, 2 colonnes : points à droite, réalisées barrées,
// point orange devant celles de l'adversaire, combinaison retenue en or.
const GRILLE = [...COMBINATIONS.map((c) => ({ label: c.label, points: String(c.points) })), { label: JOKER, points: "Σ" }];
const LIGNE_H = 46;

function grille(y0, { used, adversaire, retenue }) {
  const lignes = Math.ceil(GRILLE.length / 2);
  const ecart = 12;
  const marge = 26;
  const largeur = (LARGEUR - 2 * marge - ecart) / 2;
  return GRILLE.map((c, i) => {
    const col = Math.floor(i / lignes);
    const ligne = i % lignes;
    const x = marge + col * (largeur + ecart);
    const y = y0 + ligne * LIGNE_H;
    const fait = used.includes(c.label);
    const chezAdv = adversaire?.used.includes(c.label);
    const choisie = retenue === c.label;
    let s = `<rect x="${x}" y="${y}" width="${largeur}" height="${LIGNE_H - 6}" rx="10" fill="${choisie ? OR : "#000"}" opacity="${choisie ? 1 : 0.22}"/>`;
    const couleur = choisie ? "#3a2a00" : BLANC;
    const opacite = fait && !choisie ? 0.38 : 1;
    const milieu = y + (LIGNE_H - 6) / 2;
    if (chezAdv) s += `<circle cx="${x + 16}" cy="${milieu}" r="8" fill="${ADVERSAIRE}" stroke="${BLANC}" stroke-width="2"/>`;
    s += texte(x + 32, milieu + 9, COURTS[c.label] ?? c.label, { size: 25, fill: couleur, weight: 700, opacity: opacite });
    s += texte(x + largeur - 12, milieu + 9, c.points, { size: 25, fill: couleur, weight: 800, anchor: "end", opacity: opacite });
    if (fait && !choisie) s += `<line x1="${x + 28}" y1="${milieu}" x2="${x + largeur - 8}" y2="${milieu}" stroke="${BLANC}" stroke-width="3" opacity="0.75"/>`;
    return s;
  }).join("");
}

export function buildMainSvg({ nom, des, tirage, statut, category, points, used, adversaire, legende }) {
  const enCours = statut === "en_cours";
  let c = texte(MARGE, 74, tronquer(nom, 14), { size: 34, weight: 800 });
  if (enCours) c += texte(LARGEUR - MARGE - 118, 74, `${tirage}/3`, { size: 30, weight: 700, anchor: "end" });
  c += tirages(LARGEUR - MARGE - 48, 64, enCours ? tirage : 3);
  c += rangeeDes(des, 168, { incline: enCours });
  // Bandeau sous les dés : combinaison retenue, ou choix à faire
  let y = 230;
  if (statut === "termine") {
    c += pastille(LARGEUR / 2, y + 40, libelleCombinaison(category, points), { fond: category === NO_COMBINATION ? "#555555" : "#2e7d32", size: 30, hauteur: 54 });
    y += 82;
  } else if (statut === "choix") {
    c += texte(LARGEUR / 2, y + 50, "Choisis ta combinaison", { size: 30, weight: 800, anchor: "middle", fill: OR });
    y += 76;
  }
  c += separateur(y + 6);
  y += 22;
  c += grille(y, { used, adversaire, retenue: statut === "termine" ? category : null });
  y += Math.ceil(GRILLE.length / 2) * LIGNE_H + 4;
  if (adversaire) {
    c += `<circle cx="${MARGE + 4}" cy="${y + 22}" r="8" fill="${ADVERSAIRE}" stroke="${BLANC}" stroke-width="2"/>`;
    c += texte(MARGE + 22, y + 31, `Déjà faite par ${adversaire.nom}`, { size: 25, opacity: 0.9 });
    y += 46;
  }
  if (legende) {
    c += texte(LARGEUR / 2, y + 40, legende, { size: 27, weight: 700, anchor: "middle", opacity: 0.85 });
    y += 52;
  }
  return cadre(y + 28, c);
}

// ── Dernière manche terminée (message public) ───────────────────────
// { t: titre, j: [[pseudo, dés, combinaison, points, total]] } ; toujours
// une manche résolue (jamais de main en cours dans le message public).

/**
 * @param {object} p
 * @param {string} p.titre « Manche 2 : Raphaël +35 »
 * @param {{ nom: string, des: number[], category: string, points: number, total: number }[]} p.joueurs 1 ou 2
 */
export function encodeManche({ titre, joueurs }) {
  return encoder({
    t: tronquer(String(titre), 44),
    j: joueurs.slice(0, 2).map((j) => [tronquer(sansEmoji(j.nom), 18), versDes(j.des), indexCategorie(j.category), borner(j.points, 0, 99), borner(j.total, 0, 999)]),
  });
}

export function decodeManche(param) {
  try {
    const d = decoder(param);
    if (!Array.isArray(d?.j) || !d.j.length) return null;
    const joueurs = d.j.slice(0, 2).map(([nom, des, cat, points, total]) => ({
      nom: String(nom ?? "?"),
      des: depuisDes(des),
      category: categorie(cat) ?? NO_COMBINATION,
      points: borner(points, 0, 99),
      total: borner(total, 0, 999),
    }));
    if (joueurs.some((j) => j.des.length !== 5)) return null;
    return { titre: String(d.t ?? ""), joueurs };
  } catch {
    return null;
  }
}

export function buildMancheSvg({ titre, joueurs }) {
  let c = texte(LARGEUR / 2, 62, titre, { size: 30, weight: 800, anchor: "middle", fill: OR });
  let y = 84;
  joueurs.forEach((j, i) => {
    if (i > 0) {
      c += separateur(y);
      y += 6;
    }
    c += texte(MARGE, y + 40, tronquer(j.nom, 14), { size: 32, weight: 800 });
    c += texte(LARGEUR - MARGE, y + 40, `Total ${j.total}`, { size: 30, weight: 700, anchor: "end" });
    c += rangeeDes(j.des, y + 110, { t: 84, ecart: 18 });
    c += pastille(LARGEUR / 2, y + 196, libelleCombinaison(j.category, j.points), { fond: j.points > 0 ? "#2e7d32" : "#555555", size: 28, hauteur: 50 });
    y += 236;
  });
  return cadre(y + 20, c);
}

// ── Fin de partie ────────────────────────────────────────────────────
// { t: manches, j: [[pseudo, total, "pts.cat,…", dés meilleure, cat, pts]] }

/**
 * @param {object} p
 * @param {{ nom: string, points: number, manches: { points: number, category: string }[],
 *   meilleure: { des: number[], category: string, points: number }|null }[]} p.joueurs 1 ou 2
 * @param {number} p.totalManches
 */
export function encodeFin({ joueurs, totalManches }) {
  return encoder({
    t: totalManches,
    j: joueurs.slice(0, 2).map((j) => [
      tronquer(sansEmoji(j.nom), 18),
      borner(j.points, 0, 999),
      j.manches
        .slice(0, MAX_MANCHES)
        .map((m) => `${borner(m.points, 0, 99)}.${Math.max(0, indexCategorie(m.category))}`)
        .join(","),
      j.meilleure ? versDes(j.meilleure.des) : "",
      j.meilleure ? indexCategorie(j.meilleure.category) : -1,
      j.meilleure ? borner(j.meilleure.points, 0, 99) : 0,
    ]),
  });
}

export function decodeFin(param) {
  try {
    const d = decoder(param);
    if (!Array.isArray(d?.j) || !d.j.length) return null;
    return {
      totalManches: borner(d.t, 1, MAX_MANCHES),
      joueurs: d.j.slice(0, 2).map(([nom, points, manches, des, cat, pm]) => ({
        nom: String(nom ?? "?"),
        points: borner(points, 0, 999),
        manches: String(manches ?? "")
          .split(",")
          .filter(Boolean)
          .slice(0, MAX_MANCHES)
          .map((m) => {
            const [p, ci] = m.split(".").map(Number);
            return { points: borner(p, 0, 99), category: categorie(ci) ?? NO_COMBINATION };
          }),
        meilleure: des && depuisDes(des).length === 5 ? { des: depuisDes(des), category: categorie(cat) ?? NO_COMBINATION, points: borner(pm, 0, 99) } : null,
      })),
    };
  } catch {
    return null;
  }
}

// Meilleure combinaison d'une partie : plus de points, puis la plus
// ancienne. null si aucune manche n'a rapporté de point.
export function meilleureCombinaison(manches) {
  let best = null;
  for (const m of manches) if (m.points > 0 && (!best || m.points > best.points)) best = m;
  return best;
}

// Couleur d'une pastille selon les points de la manche (violet : Joker)
function fondManche({ points, category }) {
  if (category === JOKER) return "#7b1fa2";
  if (points <= 0) return "#555555";
  if (points < 25) return "#6d4c41";
  if (points < 40) return "#1e5fa8";
  if (points < 50) return "#2e7d32";
  return "#b8860b";
}

const PAS_PASTILLE = 54;
const xPastille = (i, n) => (LARGEUR - (n - 1) * PAS_PASTILLE) / 2 + i * PAS_PASTILLE;

function pastillesManches(manches, y) {
  return manches
    .map(
      (m, i) =>
        `<circle cx="${xPastille(i, manches.length)}" cy="${y}" r="25" fill="${fondManche(m)}" stroke="${BLANC}" stroke-width="2.5"/>` +
        texte(xPastille(i, manches.length), y + 9, String(m.points), { size: 25, weight: 800, anchor: "middle" }),
    )
    .join("");
}

function buildFinSoloSvg({ joueurs: [j], totalManches }) {
  let c = texte(LARGEUR / 2, 84, tronquer(j.nom, 16), { size: 36, weight: 800, anchor: "middle" });
  c += texte(LARGEUR / 2, 184, String(j.points), { size: 104, weight: 800, anchor: "middle", fill: OR });
  c += texte(LARGEUR / 2, 226, `${j.points > 1 ? "points" : "point"} en ${totalManches} manches`, { size: 28, anchor: "middle", opacity: 0.9 });
  c += pastillesManches(j.manches, 290);
  c += separateur(342);
  if (!j.meilleure) {
    c += texte(LARGEUR / 2, 400, "Aucune combinaison marquée", { size: 28, weight: 700, anchor: "middle" });
    return cadre(450, c);
  }
  c += texte(LARGEUR / 2, 392, "Meilleure combinaison", { size: 28, weight: 700, anchor: "middle", opacity: 0.9 });
  c += texte(LARGEUR / 2, 434, `${j.meilleure.category} · ${pts(j.meilleure.points)}`, { size: 32, weight: 800, anchor: "middle", fill: OR });
  c += rangeeDes(j.meilleure.des, 518, { t: 86, ecart: 18 });
  return cadre(604, c);
}

function buildFinPvpSvg({ joueurs }) {
  const [a, b] = joueurs;
  const titre = a.points === b.points ? "Égalité !" : `Victoire de ${tronquer(a.points > b.points ? a.nom : b.nom, 14)} !`;
  let c = texte(LARGEUR / 2, 74, titre, { size: 36, weight: 800, anchor: "middle", fill: OR });
  const tete = Math.max(a.points, b.points);
  const bloc = (j, y) =>
    texte(MARGE, y, tronquer(j.nom, 14), { size: 32, weight: 800 }) +
    texte(LARGEUR - MARGE, y, pts(j.points), { size: 32, weight: 800, anchor: "end", fill: j.points === tete ? OR : BLANC }) +
    pastillesManches(j.manches, y + 50);
  c += bloc(a, 136);
  const n = Math.max(a.manches.length, b.manches.length);
  for (let i = 0; i < n; i++) c += texte(xPastille(i, n), 244, String(i + 1), { size: 24, anchor: "middle", opacity: 0.65 });
  c += bloc(b, 300);
  c += separateur(384);
  c += texte(LARGEUR / 2, 430, "Meilleures combinaisons", { size: 28, weight: 700, anchor: "middle", opacity: 0.9 });
  joueurs.forEach((j, i) => {
    const centre = LARGEUR / 4 + (i * LARGEUR) / 2 + (i ? -6 : 6);
    const libelle = j.meilleure ? `${COURTS[j.meilleure.category] ?? j.meilleure.category} · ${j.meilleure.points}` : "aucune";
    c += texte(centre, 474, tronquer(j.nom, 11), { size: 26, weight: 800, anchor: "middle" });
    c += texte(centre, 508, libelle, { size: 26, weight: 700, anchor: "middle", fill: OR });
    if (j.meilleure) c += rangeeDes(j.meilleure.des, 560, { t: 46, ecart: 6, centre, incline: false });
  });
  return cadre(616, c);
}

export const buildFinSvg = (fin) => (fin.joueurs.length === 1 ? buildFinSoloSvg(fin) : buildFinPvpSvg(fin));

// ── Rastérisation ────────────────────────────────────────────────────

async function rasterize(svg) {
  const fontPaths = await readGameFontPaths();
  const resvg = new Resvg(Buffer.from(texteAffichable(svg), "utf8"), {
    fitTo: { mode: "width", value: LARGEUR },
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return { buffer: Buffer.from(resvg.render().asPng()), mimeType: "image/png" };
}

export const getMainImage = (main) => rasterize(buildMainSvg(main));
export const getMancheImage = (manche) => rasterize(buildMancheSvg(manche));
export const getFinImage = (fin) => rasterize(buildFinSvg(fin));
