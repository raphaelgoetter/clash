// ============================================================
// creneaux.js — Deux mains par jour pour les jeux spéciaux Blackjack et
// Gobelet (pas leurs duels) : une en journée (8h30-20h), une le soir
// (20h-8h), heure de Paris. Le jour de jeu va de 8h à 8h : la main du soir
// appartient au jour publié le matin même, le décompte se fait à 8h (plus
// aucune action ensuite) et le cron publie le jour suivant vers 8h20.
// Entre 8h et 8h30 : aucun créneau ouvert.
// ============================================================

import { parisParts } from "./meowRules.js";

export const JOURNEE = 1;
export const SOIR = 2;
export const CRENEAUX = [JOURNEE, SOIR];

const DEBUT_JOURNEE = 8 * 60 + 30;
const DEBUT_SOIR = 20 * 60;
const DECOMPTE = 8 * 60;

// Libellés affichés (« Ta main du soir »)
export const NOM_CRENEAU = { [JOURNEE]: "journée", [SOIR]: "soir" };
export const HORAIRES_CRENEAU = { [JOURNEE]: "8h30-20h", [SOIR]: "20h-8h" };

const minutesParis = (now) => {
  const { h, min } = parisParts(now);
  return h * 60 + min;
};

// Créneau ouvert à `now` (JOURNEE, SOIR) ou null (8h-8h30)
export function creneauA(now = Date.now()) {
  const m = minutesParis(now);
  if (m >= DEBUT_JOURNEE && m < DEBUT_SOIR) return JOURNEE;
  if (m >= DEBUT_SOIR || m < DECOMPTE) return SOIR;
  return null;
}

// Jour de jeu (« AAAA-MM-JJ ») de l'instant : celui de la veille avant 8h
export function jourDeJeu(now) {
  const t = new Date(now).getTime();
  const { date, h } = parisParts(t);
  if (h >= 8) return date;
  return parisParts(t - (h + 1) * 3_600_000).date;
}

// Créneau jouable pour le jour publié à `publishedAt` : null si aucun
// créneau n'est ouvert, ou si le jour de jeu a changé (décompte de 8h
// passé, jour suivant pas encore publié).
export function creneauJouable(publishedAt, now = Date.now()) {
  if (!publishedAt || jourDeJeu(publishedAt) !== jourDeJeu(now)) return null;
  return creneauA(now);
}

// Créneau lu dans un custom_id (« 3:2 ») : SOIR si 2, JOURNEE sinon
export const creneauDepuis = (valeur) => (String(valeur) === String(SOIR) ? SOIR : JOURNEE);

// Message d'un clic hors créneau
export function messageHorsCreneau(publishedAt, now = Date.now()) {
  if (publishedAt && jourDeJeu(publishedAt) !== jourDeJeu(now)) {
    return "La journée est terminée (décompte à 8h), le jour suivant arrive vers 8h20.";
  }
  return "Les mains sont closes de 8h à 8h30. Prochaine main à 8h30 !";
}
