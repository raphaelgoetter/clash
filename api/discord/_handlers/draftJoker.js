// ============================================================
// draftJoker.js — Magasin Joker du Draft, partagé par le jeu spécial
// (_handlers/draftroyale.js) et le duel /draft (_handlers/draftDuel.js) :
// libellés, vue du magasin (édition en place de la main éphémère) et
// lignes du bilan. Règles dans backend/services/draftRules.js.
//
// custom_id : `<prefixe>_jk:<champ>:<tour>` avec champ = ouvrir, retour,
// annuler (boutons) ou type, cible, carte, maCarte (menus).
// ============================================================

import { JOKER_ACTIONS, jokerCout, compterCartes, echangeValide, jokerValide, jokerEnConflit } from "../../../backend/services/draftRules.js";

export const JOKER_EMOJI = "🃏";

const ACTIONS = {
  priorite: { label: "Priorité", description: "Servi en premier si la carte que tu prends est disputée" },
  proteger: { label: "Protéger", description: "Aucune action Joker ne peut te cibler ce tour-ci" },
  voir: { label: "Voir main", description: "Découvre la main d'un joueur après la clôture" },
  saboter: { label: "Saboter", description: "Une carte au hasard de sa main part au marché contre une autre" },
  echanger: { label: "Échanger carte", description: "Échange une de tes cartes contre une carte choisie de sa main" },
};
const AVEC_CIBLE = new Set(["voir", "saboter", "echanger"]);

// Accord d'un participe avec le nom de la carte (« Géant reçu »,
// « Archères reçues ») : `config.accords` donne genre et nombre ("m",
// "f", "mp", "fp") ; féminin singulier par défaut (« carte »).
export function accord(key, participe, config) {
  const a = config.accords?.[key] || "f";
  return `${participe}${a.startsWith("f") ? "e" : ""}${a.endsWith("p") ? "s" : ""}`;
}

// Ligne d'échange au marché du bilan (prise ou carte disputée manquée).
export function echangeLigne(l, nom, cardName, config) {
  const donne = `${cardName(l.depot)} ${accord(l.depot, "donné", config)}`;
  if (l.type === "perdue") {
    return `**${nom}** : ${cardName(l.voulue)} ${accord(l.voulue, "choisi", config)} ${accord(l.voulue, "manqué", config)}, **${cardName(l.key)}** ${accord(l.key, "reçu", config)} (+${l.gain} pts Joker) · ${donne}`;
  }
  return `**${nom}** : **${cardName(l.key)}** ${accord(l.key, "reçu", config)} · ${donne}`;
}

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

export function jokerPointsLabel(n) {
  return `${JOKER_EMOJI} ${plural(n, "point")} Joker`;
}

// Ligne d'état du Joker prévu (main éphémère et magasin).
export function jokerStatutLigne(joker, noms, cardName) {
  if (!joker?.type) return null;
  const a = ACTIONS[joker.type];
  if (AVEC_CIBLE.has(joker.type) && !joker.cible) return `${JOKER_EMOJI} Joker ${a.label} : choisis la cible.`;
  if (joker.type === "echanger" && (!joker.carte || !joker.maCarte)) return `${JOKER_EMOJI} Joker ${a.label} : choisis les deux cartes.`;
  if (joker.type === "echanger") return `${JOKER_EMOJI} Joker prévu : ${a.label} avec **${noms[joker.cible]}** (tu donnes ${cardName(joker.maCarte)}, tu prends ${cardName(joker.carte)}).`;
  if (AVEC_CIBLE.has(joker.type)) return `${JOKER_EMOJI} Joker prévu : ${a.label} **${noms[joker.cible]}**.`;
  if (joker.type === "priorite") return `${JOKER_EMOJI} Joker prévu : Priorité (sans échange complet, il ne sera pas utilisé).`;
  return `${JOKER_EMOJI} Joker prévu : ${a.label}.`;
}

// Lignes d'état du tour : un tour se joue par un échange au marché, une
// action Joker, ou les deux. `suite` : fin de la ligne d'un tour prêt.
export function tourStatutLignes({ action, id, joueurs, marche, config, cardName, trade, suite }) {
  const main = joueurs[id]?.main || [];
  const echangeOk = echangeValide(action, main, marche);
  const jokerOk = jokerValide(action.joker, id, joueurs, config, false);
  const lignes = [];
  if (echangeOk) lignes.push(`${trade} Échange prévu : tu prends **${cardName(action.prise)}**, tu déposes **${cardName(action.depot)}**. ${suite}`);
  else if (marche.includes(action.prise)) lignes.push(`⚠️ Tu prends **${cardName(action.prise)}** : choisis aussi la carte à déposer.`);
  else if (main.includes(action.depot)) lignes.push(`⚠️ Tu déposes **${cardName(action.depot)}** : choisis aussi la carte à prendre.`);
  else if (jokerOk) lignes.push(`${trade} Pas d'échange au marché : ton tour se joue avec ton Joker. ${suite}`);
  if (echangeOk && jokerEnConflit(action, main)) {
    lignes.push(`⚠️ Tu déposes déjà ton seul ${cardName(action.depot)} au marché : l'Échange Joker ne sera pas joué. Annule l'échange au marché ou choisis une autre carte.`);
  }
  return lignes;
}

// Bouton qui efface les deux choix du marché (le tour peut se jouer avec
// le Joker seul).
export function annulerEchangeButton(prefixe, tour, action) {
  return {
    type: 2,
    style: 2,
    label: "Annuler l'échange",
    custom_id: `${prefixe}_annuler:${tour}`,
    disabled: !action.prise && !action.depot,
  };
}

export function jokerButton(prefixe, tour, points, joker) {
  return {
    type: 2,
    style: 2,
    label: `Joker (${points})`,
    emoji: { name: JOKER_EMOJI },
    custom_id: `${prefixe}_jk:ouvrir:${tour}`,
    disabled: points < 1 && !joker,
  };
}

// Vue du magasin. `adversaires` : [{ id, nom }] ; `main` : main du joueur ;
// `familles` : cartes en jeu.
export function buildMagasin({ prefixe, tour, points, joker, adversaires, main, familles, config, cardName, noms, color }) {
  const lignes = [
    `Tu as **${plural(points, "point")} Joker**. Une action par tour, payée et résolue à la clôture.`,
    "Les points restants départagent les cartes disputées.",
    "",
    ...JOKER_ACTIONS.map((t) => `• **${ACTIONS[t].label}** (${plural(jokerCout(t, config), "pt")}) : ${ACTIONS[t].description}.`),
  ];
  const statut = jokerStatutLigne(joker, noms, cardName);
  if (statut) lignes.push("", statut);

  const select = (champ, placeholder, options) => ({
    type: 1,
    components: [{ type: 3, custom_id: `${prefixe}_jk:${champ}:${tour}`, placeholder, options: options.slice(0, 25) }],
  });
  const rows = [
    select(
      "type",
      "Action Joker",
      JOKER_ACTIONS.map((t) => ({
        label: `${ACTIONS[t].label} (${plural(jokerCout(t, config), "pt")})`,
        description: ACTIONS[t].description.slice(0, 100),
        value: t,
        default: joker?.type === t || undefined,
      })),
    ),
  ];
  if (AVEC_CIBLE.has(joker?.type) && adversaires.length) {
    rows.push(select("cible", "Joueur ciblé", adversaires.map((a) => ({ label: a.nom.slice(0, 100), value: a.id, default: joker.cible === a.id || undefined }))));
  }
  if (joker?.type === "echanger") {
    rows.push(select("carte", "Carte à lui prendre", familles.map((k) => ({ label: cardName(k).slice(0, 100), value: k, default: joker.carte === k || undefined }))));
    rows.push(
      select(
        "maCarte",
        "Carte de ta main à lui donner",
        [...compterCartes(main).keys()].map((k) => ({ label: cardName(k).slice(0, 100), value: k, default: joker.maCarte === k || undefined })),
      ),
    );
  }
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 2, label: "Retour à ma main", custom_id: `${prefixe}_jk:retour:${tour}` },
      { type: 2, style: 4, label: "Annuler le Joker", custom_id: `${prefixe}_jk:annuler:${tour}`, disabled: !joker },
    ],
  });
  return {
    content: "",
    embeds: [{ title: `${JOKER_EMOJI} Magasin Joker`, description: lignes.join("\n").slice(0, 4096), color }],
    components: rows,
  };
}

// Lignes du bilan pour les actions Joker de la clôture, vues par
// `viewerId` : le détail des cartes n'est montré qu'à l'auteur et à la
// cible, les autres voient seulement qui a visé qui.
export function jokerBilanLignes(lignes, viewerId, noms, cardName, formatGroupes, config) {
  const out = [];
  for (const l of lignes.filter((x) => x.type === "joker")) {
    const auteur = `**${noms[l.discordId]}**`;
    const cible = `**${noms[l.cible]}**`;
    const concerne = l.discordId === viewerId || l.cible === viewerId;
    if (l.echec === "protege") out.push(`${JOKER_EMOJI} ${auteur} vise ${cible}, protégé : action perdue.`);
    else if (l.action === "proteger") {
      if (l.discordId === viewerId) out.push(`${JOKER_EMOJI} Tu étais protégé.`);
    } else if (l.action === "voir") {
      out.push(l.discordId === viewerId ? `${JOKER_EMOJI} Main de ${cible} : ${formatGroupes(l.main)}` : `${JOKER_EMOJI} ${auteur} a regardé la main de ${cible}.`);
    } else if (l.action === "saboter") {
      out.push(
        concerne
          ? `${JOKER_EMOJI} ${auteur} sabote ${cible} : ${cardName(l.retiree)} ${accord(l.retiree, "perdu", config)}, ${cardName(l.recue)} ${accord(l.recue, "reçu", config)}.`
          : `${JOKER_EMOJI} ${auteur} sabote ${cible}.`,
      );
    } else if (l.action === "echanger" && l.echec) {
      out.push(l.discordId === viewerId ? `${JOKER_EMOJI} Échange raté avec ${cible} : ${cardName(l.carte)} absente de sa main (ou ${cardName(l.maCarte)} de la tienne).` : `${JOKER_EMOJI} ${auteur} rate un échange avec ${cible}.`);
    } else if (l.action === "echanger") {
      out.push(concerne ? `${JOKER_EMOJI} ${auteur} échange avec ${cible} : ${cardName(l.maCarte)} contre ${cardName(l.carte)}.` : `${JOKER_EMOJI} ${auteur} échange une carte avec ${cible}.`);
    }
  }
  return out;
}
