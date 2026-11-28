// ============================================================
// pilepoilRules.js — Règles pures de Pile Poil (calcul du jour) :
// égalité secrète de 8 caractères `__+__=__` ou `__-__=__` (nombres et
// résultat de 10 à 99), 6 chiffres à retrouver en 6 essais. Un essai est
// une suite de 6 chiffres quelconques (le total n'a pas à être juste).
// Retour chiffre par chiffre : bien placé, présent ailleurs, absent.
// Règles : jeux/CONTRIBUTING.md, section « Pile Poil ».
// Aucune dépendance (ni Redis ni Discord) : testé par pilepoilRules.test.js.
// ============================================================

export const SIGNES = ["+", "-"];
export const NB_CHIFFRES = 6;

// États d'une case (retour) et d'un chiffre du pavé : codés sur un caractère
// dans les URL d'images (pilepoilImage.js)
export const ABSENT = 0;
export const PRESENT = 1;
export const BIEN = 2;

// Toutes les égalités d'un signe : `ab<signe>cd=ef`, trois nombres de 10 à
// 99 (3 240 par signe)
export function toutesLesEgalites(signe) {
  const res = [];
  for (let a = 10; a <= 99; a++) {
    for (let b = 10; b <= 99; b++) {
      const c = signe === "+" ? a + b : a - b;
      if (c >= 10 && c <= 99) res.push(`${a}${signe}${b}=${c}`);
    }
  }
  return res;
}

let _toutes = null;
export function toutes() {
  if (!_toutes) _toutes = SIGNES.flatMap(toutesLesEgalites);
  return _toutes;
}

// Les 6 chiffres d'une égalité (« 47+38=85 » → « 473885 »)
export const chiffresDe = (egalite) => String(egalite).replace(/\D/g, "");
export const signeDe = (egalite) => (String(egalite).includes("-") ? "-" : "+");

// Gabarit affiché : « __+__=__ »
export const gabarit = (signe) => `__${signe}__=__`;

// Égalité lisible à partir du signe et des 6 chiffres : « 47 + 38 = 85 »
export function egaliteLisible(signe, chiffres) {
  const c = String(chiffres).padEnd(NB_CHIFFRES, "_");
  return `${c.slice(0, 2)} ${signe === "-" ? "−" : "+"} ${c.slice(2, 4)} = ${c.slice(4, 6)}`;
}

// Tirage de l'égalité du jour : signe à pile ou face, puis une égalité
// jamais sortie (`dejaSorties` : Set ou tableau). Toutes sorties : on repart
// de zéro (après plus de 17 ans).
export function tirerEgalite(dejaSorties = [], rng = Math.random) {
  const sorties = dejaSorties instanceof Set ? dejaSorties : new Set(dejaSorties);
  const premier = rng() < 0.5 ? "+" : "-";
  for (const signe of [premier, premier === "+" ? "-" : "+"]) {
    const libres = toutesLesEgalites(signe).filter((e) => !sorties.has(e));
    if (libres.length) return libres[Math.floor(rng() * libres.length)];
  }
  const tout = toutesLesEgalites(premier);
  return tout[Math.floor(rng() * tout.length)];
}

// Saisie tolérante : tout ce qui n'est pas un chiffre est ignoré (« 47+38=85 »,
// « 47 38 85 », « 473885 »). Renvoie les 6 chiffres, ou null s'il n'y en a
// pas exactement 6.
export function lireSaisie(texte) {
  const chiffres = String(texte ?? "").replace(/\D/g, "");
  return chiffres.length === NB_CHIFFRES ? chiffres : null;
}

// Retour d'un essai (règle du Wordle, doublons compris) : tableau de 6 états.
// Les bien placés d'abord ; un chiffre présent n fois dans la solution ne
// colore que n cases de l'essai.
export function retour(essai, solution) {
  const e = chiffresDe(essai);
  const s = chiffresDe(solution);
  const res = Array(NB_CHIFFRES).fill(ABSENT);
  const reste = {};
  for (let i = 0; i < NB_CHIFFRES; i++) {
    if (e[i] === s[i]) res[i] = BIEN;
    else reste[s[i]] = (reste[s[i]] ?? 0) + 1;
  }
  for (let i = 0; i < NB_CHIFFRES; i++) {
    if (res[i] !== BIEN && reste[e[i]]) {
      res[i] = PRESENT;
      reste[e[i]] -= 1;
    }
  }
  return res;
}

export const gagne = (r) => r.every((x) => x === BIEN);

// Pavé 0-9 : meilleur état connu de chaque chiffre (null = pas encore joué)
export function etatPave(essais) {
  const pave = Array(10).fill(null);
  for (const { chiffres, retour: r } of essais) {
    [...chiffres].forEach((c, i) => {
      const d = Number(c);
      if (pave[d] === null || r[i] > pave[d]) pave[d] = r[i];
    });
  }
  return pave;
}

// Points du jour : trouvé au n-ième essai = essaisMax + 1 - n (6 … 1)
export const pointsDuJour = (n, essaisMax = 6) => Math.max(0, essaisMax + 1 - n);

// Égalités encore possibles après une série d'essais (PNJ, simulation)
export function compatibles(candidats, essais) {
  return candidats.filter((c) => essais.every((h) => retour(h.chiffres, c).join("") === h.retour.join("")));
}

// Classement du mois : points décroissants, puis le moins de jours joués
// (meilleure moyenne) ; ex aequo au-delà
export function classementMois(points, jours = {}, usernames = {}) {
  return Object.entries(points)
    .map(([discordId, pts]) => ({ discordId, username: usernames[discordId] || null, points: pts, jours: jours[discordId] ?? 0 }))
    .sort((a, b) => b.points - a.points || a.jours - b.jours);
}
export const memeRangMois = (a, b) => a.points === b.points && a.jours === b.jours;

// Bilan d'un jour à partir des parties des joueurs. Pure.
// parEssais : { n: [discordId…] } pour les trouvés ; rates : [discordId…]
export function bilanJour(parties) {
  const joueurs = Object.entries(parties).filter(([, p]) => p?.essais?.length);
  const parEssais = {};
  const rates = [];
  for (const [id, p] of joueurs) {
    if (p.trouve) (parEssais[p.essais.length] ??= []).push(id);
    else rates.push(id);
  }
  return { joueurs: joueurs.length, trouves: joueurs.length - rates.length, parEssais, rates };
}

// Série d'un joueur au jour `jour` : jours consécutifs trouvés, remise à 0
// dès qu'un jour est manqué ou raté (dernier jour trouvé antérieur à la veille)
export function serieAffichee(serie, jour) {
  if (!serie) return 0;
  return serie.dernierJourTrouve >= jour - 1 ? serie.serie : 0;
}
export function serieApresVictoire(serie, jour) {
  if (serie?.dernierJourTrouve === jour) return serie;
  const suite = serie?.dernierJourTrouve === jour - 1 ? serie.serie + 1 : 1;
  return { serie: suite, dernierJourTrouve: jour };
}
