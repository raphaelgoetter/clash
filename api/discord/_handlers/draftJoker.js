// ============================================================
// draftJoker.js — Bonus Joker du Draft, partagé par le jeu spécial
// (_handlers/draftroyale.js) et le duel /draft (_handlers/draftDuel.js) :
// menus de la main éphémère (bonus du tour, espionnage), lignes d'état et
// du bilan. Tout tient sur l'écran de la main, sans étape. Règles dans
// backend/services/draftRules.js.
//
// custom_id : `<prefixe>_jk:bonus:<tour>` (menu « Bonus du tour ») et
// `<prefixe>_jk:espion:<tour>` (menu « Espionner »).
// ============================================================

import { jokerCout, compterCartes, echangeValide, jokerValide } from "../../../backend/services/draftRules.js";

export const JOKER_EMOJI = "🃏";

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

export function jokerPointsLabel(n) {
  return `${JOKER_EMOJI} ${plural(n, "point")} Joker`;
}

// Accord d'un participe avec le nom de la carte (« Géant reçu »,
// « Archères reçues ») : `config.accords` donne genre et nombre ("m",
// "f", "mp", "fp") ; féminin singulier par défaut (« carte »).
export function accord(key, participe, config) {
  const a = config.accords?.[key] || "f";
  return `${participe}${a.startsWith("f") ? "e" : ""}${a.endsWith("p") ? "s" : ""}`;
}

// Ligne d'échange au marché du bilan.
export function echangeLigne(l, nom, cardName, config) {
  const garde = `${cardName(l.depot)} ${accord(l.depot, "gardé", config)}`;
  if (l.type === "perdue") {
    return `**${nom}** : ${cardName(l.voulue)} ${accord(l.voulue, "choisi", config)} ${accord(l.voulue, "manqué", config)}, ${garde} (+${l.gain} pts Joker)`;
  }
  if (l.type === "gelee") return `**${nom}** : ${cardName(l.voulue)} ${accord(l.voulue, "gelé", config)}, ${garde}`;
  return `**${nom}** : **${cardName(l.key)}** ${accord(l.key, "reçu", config)} · ${cardName(l.depot)} ${accord(l.depot, "donné", config)}`;
}

// Lignes d'état du tour : un tour se joue par un échange au marché, un
// bonus Joker, ou les deux. `suite` : fin de la ligne d'un tour prêt.
export function tourStatutLignes({ action, id, joueurs, marche, config, cardName, trade, suite }) {
  const main = joueurs[id]?.main || [];
  const echangeOk = echangeValide(action, main, marche);
  const lignes = [];
  if (echangeOk) lignes.push(`${trade} Échange prévu : tu prends **${cardName(action.prise)}**, tu déposes **${cardName(action.depot)}**. ${suite}`);
  else if (marche.includes(action.prise)) lignes.push(`⚠️ Tu prends **${cardName(action.prise)}** : choisis aussi la carte à déposer.`);
  else if (main.includes(action.depot)) lignes.push(`⚠️ Tu déposes **${cardName(action.depot)}** : choisis aussi la carte à prendre.`);
  else if (jokerValide(action.joker, id, joueurs, config, { echangeOk: false, marche })) lignes.push(`${trade} Pas d'échange au marché : ton tour se joue avec ton bonus. ${suite}`);
  const joker = action.joker;
  if (joker?.type === "priorite") lignes.push(`${JOKER_EMOJI} Bonus : Priorité${echangeOk ? "" : " (sans échange complet, il ne sera pas utilisé)"}.`);
  if (joker?.type === "geler") {
    lignes.push(`${JOKER_EMOJI} Bonus : ${cardName(joker.carte)} ${accord(joker.carte, "gelé", config)} (personne ne pourra la prendre ce tour-ci, toi compris).`);
    if (joker.carte === action.prise) lignes.push(`⚠️ Tu gèles la carte que tu veux prendre : ton échange au marché sera annulé.`);
  }
  return lignes;
}

// Encadré des quadruplés de la manche précédente (et de la nouvelle
// donne), mis en avant en tête de la main éphémère. `scores` : décompte du
// tour ; null s'il n'y en a pas eu.
export function quadruplesEmbed(recap, noms, cardName, color = 0xf1c40f) {
  const quads = (recap?.scores || []).filter((s) => s.carre);
  if (!quads.length && !recap?.redistribution) return null;
  const lignes = quads.map((s) => {
    const [key] = [...compterCartes(s.main)].sort((a, b) => b[1] - a[1])[0] || [];
    return `🎉 **${noms[s.discordId]}** : quadruplé de ${s.vedette ? "⭐ " : ""}**${cardName(key)}** · **+${s.points} pts**`;
  });
  if (recap.redistribution) lignes.push("", "🔄 **Nouvelle donne** : toutes les cartes ont été redistribuées.");
  return { title: quads.length > 1 ? "🎉 Quadruplés !" : "🎉 Quadruplé !", description: lignes.join("\n").slice(0, 4096), color };
}

// Cartes vedettes de la donne (leur quadruplé rapporte `points_vedette`).
export function vedetteLigne(vedettes, cardName) {
  if (!vedettes?.length) return null;
  const noms = vedettes.map((k) => `**${cardName(k)}**`).join(", ");
  return `⭐ ${vedettes.length > 1 ? "Cartes vedettes" : "Carte vedette"} : ${noms}`;
}

// Main vue ce tour-ci (Espionner).
export function voirLigne(vu, noms, formatGroupes) {
  if (!vu) return null;
  return `🕵️ Main de **${noms[vu.cible]}** (espionnée ce tour) : ${formatGroupes(vu.main)}`;
}

// Bouton qui efface les deux choix du marché (le tour peut se jouer avec
// le bonus seul).
export function annulerEchangeButton(prefixe, tour, action) {
  return {
    type: 2,
    style: 2,
    label: "Annuler l'échange",
    custom_id: `${prefixe}_annuler:${tour}`,
    disabled: !action.prise && !action.depot,
  };
}

// Menus Joker de la main : « Bonus du tour » (Priorité ou Geler une
// carte du marché, résolu à la clôture) et « Espionner » (instantané).
export function jokerRows({ prefixe, tour, points, action, marche, adversaires, config, cardName }) {
  const cout = (t) => jokerCout(t, config);
  const bonus = action.joker?.type === "geler" ? `geler:${action.joker.carte}` : action.joker?.type || "aucun";
  const options = [
    { label: "Aucune action", value: "aucun" },
    {
      label: `Priorité (${plural(cout("priorite"), "pt")})`,
      description: "Servi en premier si la carte que tu prends est disputée",
      value: "priorite",
      default: bonus === "priorite" || undefined,
    },
    ...[...compterCartes(marche).keys()]
      .sort((a, b) => cardName(a).localeCompare(cardName(b)))
      .map((k) => ({
        label: `Geler ${cardName(k)} (${plural(cout("geler"), "pt")})`.slice(0, 100),
        description: "Personne ne pourra la prendre ce tour-ci, toi compris",
        value: `geler:${k}`,
        default: bonus === `geler:${k}` || undefined,
      })),
  ].slice(0, 25);
  const vu = action.vu;
  const espionPossible = !vu && points >= cout("espionner") && adversaires.length > 0;
  return [
    {
      type: 1,
      components: [{ type: 3, custom_id: `${prefixe}_jk:bonus:${tour}`, placeholder: `${JOKER_EMOJI} Actions (${points})`, options }],
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `${prefixe}_jk:espion:${tour}`,
          placeholder: vu ? "🕵️ Déjà espionné ce tour-ci" : `🕵️ Espionner (${plural(cout("espionner"), "pt")})`,
          disabled: !espionPossible,
          options: (adversaires.length ? adversaires : [{ id: "-", nom: "-" }]).slice(0, 25).map((a) => ({ label: a.nom.slice(0, 100), value: a.id })),
        },
      ],
    },
  ];
}

// Lignes du bilan pour les bonus de la clôture. L'espion a déjà vu la
// main dans la journée : seuls les autres sont informés.
export function jokerBilanLignes(lignes, viewerId, noms, cardName) {
  const out = [];
  for (const l of lignes.filter((x) => x.type === "joker")) {
    if (l.action === "geler") out.push(`🧊 **${noms[l.discordId]}** a gelé ${cardName(l.carte)}.`);
    if (l.action === "espionner" && l.discordId !== viewerId) out.push(`🕵️ **${noms[l.discordId]}** a espionné **${noms[l.cible]}**.`);
  }
  return out;
}
