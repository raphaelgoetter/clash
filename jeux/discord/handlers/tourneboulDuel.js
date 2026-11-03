// ============================================================
// tourneboulDuel.js (handler) — Tourneboule (`/tourneboule`), deux modes :
// - contre Kévina, le bot (`/tourneboule adversaire:bot`) : plateau public
//   dans le salon (suivi par tous) et vue éphémère du joueur (plateau et
//   boutons de coup), édités en place à chaque coup ; Kévina joue aussitôt après
//   le joueur ; résultat publié dans un nouveau message en fin de partie ;
// - 1v1 (`/tourneboule adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; plateau visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque coup du joueur). Une seule
//   partie à la fois, comme Quatre à la suite.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : tourneboulduel_poser:<case>:<vue>[:pvp] (<case> 0 à 24, ligne × 5 +
// colonne ; <vue> = d.vue à l'affichage, un clic sur une vue dépassée est
// refusé), tourneboulduel_ouvrir (bouton Jouer du message public),
// tourneboulduel_regles, tourneboulduel_abandon[:pvp] (🏳️, demande
// confirmation), tourneboulduel_abandon_ok[:pvp] / tourneboulduel_abandon_non[:pvp].
//
// Service : jeux/services/tourneboulDuel.js (Redis),
// règles : jeux/services/tourneboulRules.js, pions : jeux/services/pions.js
// (ceux de Quatre à la suite).
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  INACTIVITE_SECONDES,
  loadDuelConfig,
  nouveauDuel,
  ouvrirPvp,
  readDuel,
  readPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/tourneboulDuel.js";
import { NB_CASES, ROC, TAILLE, adversaire, casesJouables, choixKevina, compter, poser } from "../../services/tourneboulRules.js";
import { formatPion, pionButtonEmoji } from "../../services/pions.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

// Violet foncé
const TOURNEBOULE_COLOR = 0x6c3483;
const TITRE = "🌀 Tourneboule";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Ses pions en bleu, ceux de l'adversaire en rouge (messages publics :
// premier joueur en bleu), comme Quatre à la suite
const MOI = "bleu";
const ADV = "rouge";
// Case centrale bloquée et étape de retournement (pions retournés 🌀,
// affichés un court instant avant le plateau suivant)
const ROCHER = "🪨";
const TOURNE = "🌀";
const DELAI_RETOURNEMENT_MS = 900;
// Contre Kévina : délai avant d'afficher son coup (elle joue en quelques
// millisecondes, un coup instantané paraît mécanique), durée tirée au sort
const REFLEXION_MS = { min: 2000, max: 5000 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick ||
    body.member?.user?.global_name ||
    body.member?.user?.username ||
    "Inconnu";
  return { discordId, username };
}

// Messages en Components V2 (conteneur à liseré coloré, comme un embed) :
// le texte y a la taille d'un message (16 px) et non d'un embed (14 px),
// donc des cartes plus grandes à interligne serré. Les vues sont écrites
// comme des embeds, converties ici à l'envoi : titre en `###`, description,
// puis boutons dans le conteneur. `content` seul : texte nu.
const IS_COMPONENTS_V2 = 1 << 15;
const EPHEMERE = 1 << 6;
// Limite Discord : 4 000 caractères de texte pour tout le message
const TEXTE_MAX = 4000;

export function versV2({ content = null, embeds = [], components = [], ...reste }) {
  const blocs = [];
  if (content) blocs.push({ type: 10, content });
  const [embed] = embeds;
  if (embed) {
    const texte = [embed.title ? `### ${embed.title}` : null, embed.description].filter(Boolean).join("\n");
    blocs.push({
      type: 17,
      accent_color: embed.color ?? TOURNEBOULE_COLOR,
      components: [{ type: 10, content: texte.slice(0, TEXTE_MAX) }, ...components],
    });
  } else blocs.push(...components);
  return { ...reste, flags: IS_COMPONENTS_V2, components: blocs };
}

// Message visé : la réponse de l'interaction (`@original`), ou un followup
// si l'URL mémorisée désigne déjà un message (`…/messages/<id>`).
const urlMessage = (webhookUrl) => (webhookUrl.includes("/messages/") ? webhookUrl : `${webhookUrl}/messages/@original`);

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(urlMessage(webhookUrl), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versV2(payload)),
    });
    // Refus de Discord (vue invalide, jeton expiré) : sinon le clic reste sans effet visible
    if (!res.ok) console.error(`[Tourneboule] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Tourneboule] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Tourneboule] Échec DELETE:", err.message);
    return false;
  }
}

// Nouveau message éphémère de l'interaction (followup), posté après les
// messages déjà présents. Renvoie l'URL du followup (à mémoriser pour
// l'éditer), null en cas d'échec.
async function envoyerEphemere(webhookUrl, payload) {
  if (!webhookUrl) return null;
  try {
    const v2 = versV2(payload);
    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...v2, flags: v2.flags | EPHEMERE }),
    });
    if (!res.ok) {
      console.error(`[Tourneboule] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Tourneboule] Échec followup:", err.message);
    return null;
  }
}

// Message public (jeton du bot) : création, édition, suppression.
async function messageSalon(method, channelId, messageId, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !channelId) return null;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages${messageId ? `/${messageId}` : ""}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      // Jamais de ping dans ce jeu, même si une mention se glissait
      ...(payload
        ? { body: JSON.stringify({ allowed_mentions: { parse: [] }, ...versV2(payload) }) }
        : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[Tourneboule] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Tourneboule] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

// Désignation de l'adversaire dans les textes : Kévina (le bot) ou un joueur.
const BOT = { Sujet: "Kévina", emoji: "🤖" };

function nomsJoueur(pseudo) {
  return { Sujet: pseudo, emoji: "⚔️" };
}

// Adversaire du siège `moi` dans une partie 1v1.
function nomsAdv(partie, moi) {
  return nomsJoueur(partie.noms[partie.sieges[adversaire(moi)]] ?? "?");
}

const pions = (n) => plural(n, "pion");

// Case vue par `moi` : texte (emoji) d'un pion, du rocher, de 🌀 ou d'une
// case vide
function caseTexte(x, moi) {
  if (x === "roc") return ROCHER;
  if (x === TOURNE) return TOURNE;
  if (!x) return formatPion("vide");
  return formatPion(x === moi ? MOI : ADV);
}

// Plateau en texte (messages publics, confirmation d'abandon) : une rangée
// d'emojis par ligne, en titre H3.
function plateau(d, moi = "joueur", titre = "###") {
  const rangees = [];
  for (let r = 0; r < TAILLE; r++) {
    rangees.push(`${titre} ${d.grille.slice(r * TAILLE, (r + 1) * TAILLE).map((x) => caseTexte(x, moi)).join(" ")}`);
  }
  return rangees;
}

// Étape de retournement après un coup qui retourne des pions (`d.dernier`),
// null sinon : copie du duel dont les pions retournés montrent 🌀 ; pas de
// fin (le récapitulatif suit).
function etatRetournement(d) {
  const x = d.dernier;
  if (!x?.retournes.length) return null;
  const etat = structuredClone(d);
  for (const i of x.retournes) etat.grille[i] = TOURNE;
  return Object.assign(etat, { retournement: true, termine: false });
}

// « 🌀 Kévina retourne 3 pions ! » (étape de retournement, messages publics)
const ligneRetournement = (d, nom) => `${TOURNE} ${nom(d.dernier.id)} retourne ${pions(d.dernier.retournes.length)} !`;

// Score : nombre de pions de chacun
const score = (d, id) => compter(d.grille, id);

// Plateau neutre (message public, premier joueur en bleu), puis le score.
function plateauPublic(d, nomJoueur, nomBot) {
  return [...plateau(d), `Score : ${formatPion(MOI)} **${nomJoueur} ${score(d, "joueur")}** · ${formatPion(ADV)} ${nomBot} ${score(d, "bot")}`];
}

// Récit du dernier coup vu par `moi`, sans point final : « Tu poses un
// pion », « Kévina pose un pion et retourne 3 pions 🌀 ».
function recit(d, moi, A) {
  const x = d.dernier;
  if (!x) return null;
  const toi = x.id === moi;
  const n = x.retournes.length;
  return `${toi ? "Tu poses" : `${A.Sujet} pose`} un pion${n ? ` et ${toi ? "retournes" : "retourne"} ${pions(n)} ${TOURNE}` : ""}`;
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  occupee: "Cette case est déjà prise.",
  sansVoisin: "Pose ton pion à côté d'un pion déjà posé (côté ou coin).",
  perime: "Le plateau a changé depuis : rejoue sur celui-ci.",
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};

const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "tourneboulduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

// 🏳️ : abandon, après confirmation (défaite, la série est perdue)
const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `tourneboulduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `tourneboulduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `tourneboulduel_abandon_non${sfx}` },
      ],
    },
  ];
}

function titreFin(d, moi, A, raison) {
  if (d.gagnant === "nul") return "🤝 Match nul";
  if (d.abandon) return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} abandonne.` : "🏳️ Tu abandonnes.";
  if (raison === "delai") {
    return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.` : "💀 Défaite… tu n'as pas joué à temps.";
  }
  return d.gagnant === moi ? "🏆 Victoire !" : "💀 Défaite…";
}

// Vue de fin : une phrase seulement, le plateau final est déjà dans le
// message public posté au même moment.
function vueFin(d, { moi, A, raison }) {
  const fin = d.abandon
    ? d.gagnant === moi
      ? `${A.Sujet} abandonne.`
      : "Tu abandonnes."
    : raison === "delai"
      ? d.gagnant === moi
        ? `${A.Sujet} n'a pas joué à temps.`
        : "Tu n'as pas joué à temps."
      : `Plateau plein : tu as ${pions(score(d, moi))}, ${A.Sujet} ${score(d, adversaire(moi))}${d.fin === "coins" ? " (départagés aux coins)" : d.fin === "retournement" ? " (départagés au dernier retournement)" : ""}.`;
  const issue =
    d.gagnant === "nul"
      ? "c'est un match nul."
      : d.gagnant === moi
        ? "c'est une victoire pour toi !"
        : "c'est une défaite pour toi…";
  return {
    embeds: [
      {
        title: `${TITRE} · ${titreFin(d, moi, A, raison)}`,
        description: `${fin} La partie est terminée, et ${issue}`,
        color: TOURNEBOULE_COLOR,
      },
    ],
    // Pas de bouton Règles : celui du message public posté au même moment suffit
    components: [],
  };
}

// Plateau en boutons (5 rangées de 5), comme Punto : chaque bouton montre
// le pion (ou la case vide, ou 🌀 pendant un retournement). Tous gris ;
// désactivés (grisés) : le rocher central et, à son tour, les cases vides
// sans voisin (non jouables). Les pions ne sont jamais désactivés (Discord
// estomperait l'emoji) : un clic sur une case prise ou hors de son tour
// donne un avertissement. Le numéro de vue dans le custom_id écarte un clic
// sur une vue dépassée (pendant la réflexion de Kévina, par exemple).
function boutonsPlateau(d, moi, sfx) {
  const jouables = new Set(d.actif === moi && !d.retournement ? casesJouables(d.grille) : []);
  const monTour = d.actif === moi && !d.retournement;
  const rangees = [];
  for (let r = 0; r < TAILLE; r++) {
    const components = [];
    for (let c = 0; c < TAILLE; c++) {
      const i = r * TAILLE + c;
      const x = d.grille[i];
      const bouton = { type: 2, style: 2, custom_id: `tourneboulduel_poser:${i}:${d.vue}${sfx}` };
      if (x === "roc") Object.assign(bouton, { emoji: { name: ROCHER }, disabled: true });
      else if (x === TOURNE) bouton.emoji = { name: TOURNE };
      else {
        const emoji = pionButtonEmoji(!x ? "vide" : x === moi ? MOI : ADV);
        // Repli tant que les emojis ne sont pas uploadés
        bouton.emoji = emoji ?? { name: caseTexte(x, moi) };
        if (!x && monTour && !jouables.has(i)) bouton.disabled = true;
      }
      components.push(bouton);
    }
    rangees.push({ type: 1, components });
  }
  return rangees;
}

// Vue d'un joueur : plateau, résultat de la dernière action
// (`texte`), le tour et le plateau en boutons, ou fin.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison,
// confirmerAbandon (question à la place des boutons) }. Étape de retournement
// (`d.retournement`) : pas de tour.
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false } = {},
) {
  if (d.termine) return vueFin(d, { moi, A, raison });
  const monTour = d.actif === moi;
  const sfx = pvp ? ":pvp" : "";
  const lignes = confirmerAbandon
    ? ["🏳️ **Abandonner la partie ?** Ce sera une défaite.", "", ...plateau(d, moi)]
    : [
        // Légende d'abord (fixe), puis le récit du dernier coup, puis le tour
        `${formatPion(MOI)} **Toi** · ${formatPion(ADV)} **${A.emoji} ${A.Sujet}**`,
        ...(texte ? ["", texte] : []),
        ...(d.retournement || monTour ? [] : ["", `⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
      ];
  // Score dans le titre : pas de ligne en plus
  const titre = `${TITRE} · Toi ${score(d, moi)} – ${score(d, adversaire(moi))} ${A.Sujet}${pvp && monTour ? " · À toi !" : ""}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: TOURNEBOULE_COLOR };
  if (confirmerAbandon) return { embeds: [embed], components: boutonsConfirmation(sfx) };
  // Contre Kévina, ce n'est jamais son tour qu'en pleine réflexion : pas d'abandon
  const regles = { type: 1, components: [BOUTON_REGLES, ...(!d.retournement && (monTour || pvp) ? [boutonAbandon(sfx)] : [])] };
  return { embeds: [embed], components: [...boutonsPlateau(d, moi, sfx), regles] };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Tourneboule",
    description: [
      `Un plateau de ${TAILLE}×${TAILLE} cases dont la case centrale ${ROCHER} est bloquée. Au départ, un pion chacun à côté du centre : celui qui commence au-dessus, l'autre en dessous. Aucun hasard : tout est visible. Tes pions sont bleus, ceux de ton adversaire rouges.`,
      "",
      "**🔵 À ton tour**, tu poses un pion sur une case vide **à côté d'un pion déjà posé** (côté ou coin) ou du rocher. Pas de déplacement, pions illimités. Les cases grisées ne sont pas jouables.",
      `**${TOURNE} Retournement** : chaque ligne **horizontale, verticale ou diagonale** de pions adverses que ton pion encadre avec un autre de tes pions change de camp.`,
      `**🏆 Fin** : quand le plateau est plein (11 coups chacun), le plus de pions gagne. Égalité : le plus de coins, puis celui qui a retourné des pions en dernier.`,
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: TOURNEBOULE_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionPoser(d, moi, i, vue) {
  if (!d.termine && vue !== d.vue) return { erreur: "perime" };
  const r = poser(d, moi, i);
  if (r.erreur) return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : d.grille[i] !== null ? "occupee" : "sansVoisin" };
  return {};
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleTournebouleRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Plateau public d'une partie contre Kévina, en cours : suivi par le salon,
// le joueur joue depuis sa vue éphémère. Expiration rappelée, sinon le
// message d'une partie abandonnée resterait figé sur « Au tour de X ».
function messageSolo(d, pseudo) {
  const expiration = Math.floor(Date.now() / 1000) + INACTIVITE_SECONDES;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [
          d.retournement
            ? ligneRetournement(d, (id) => (id === "bot" ? "Kévina" : pseudo))
            : d.actif === "bot"
              ? "⏳ Kévina réfléchit…"
              : `Au tour de **${pseudo}**.`,
          "",
          ...plateauPublic(d, pseudo, "🤖 Kévina"),
          "",
          `⏰ Sans action, partie abandonnée <t:${expiration}:R>.`,
        ]
          .join("\n")
          .slice(0, 4096),
        color: TOURNEBOULE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Édite le plateau public (partie lancée avant ce message : rien).
async function majSalonSolo(d, pseudo) {
  if (d.salon) await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, messageSolo(d, pseudo ?? "?"));
}

// Lance une nouvelle partie (remplace une éventuelle partie en cours) :
// plateau public dans le salon, puis vue éphémère du joueur EN DESSOUS. La
// réponse différée, créée dès la commande (au-dessus du plateau), est
// supprimée et la vue renvoyée en followup ; les clics éditent ensuite ce
// followup (message du bouton). Repli : vue dans la réponse différée.
export async function handleTournebouleCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const { duel, ancien } = await nouveauDuel(discordId);
    // Partie remplacée : son plateau public, figé, est retiré du salon
    if (ancien?.salon && !ancien.termine) await messageSalon("DELETE", ancien.salon.channelId, ancien.salon.messageId);
    const message = await messageSalon("POST", body.channel_id, null, messageSolo(duel, username));
    // Échec du POST : partie jouable quand même, résultat publié à la fin
    const enregistre = message?.id
      ? await agirDuel(discordId, (d) => {
          d.salon = { channelId: body.channel_id, messageId: message.id };
        })
      : null;
    const vue = buildVue(enregistre?.duel ?? duel, {
      texte: "Nouvelle partie contre Kévina ! Tu commences.",
    });
    if (enregistre && (await supprimerOriginal(webhookUrl)) && (await envoyerEphemere(webhookUrl, vue))) return;
    await patchOriginal(webhookUrl, vue);
  } catch (err) {
    console.error("[Tourneboule] Échec lancement:", err.message);
  }
}

// ── Séries de victoires (messages de fin) ────────────────────────────

// Série cassée signalée à partir de 2 victoires (« 💔 Fin de la série… »)
const SERIE_CASSEE_MIN = 2;
const victoires = (n) => (n > 1 ? `${n} victoires d'affilée` : `${n} victoire`);
const deNom = (pseudo) => (/^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo) ? `d'${pseudo}` : `de ${pseudo}`);

// « 🔥 Série de X : 4 victoires d'affilée · Record : Y (7) », puis
// « 💔 Fin de la série de Z (5) ». `gagnant` : { nom, serie } ou null,
// `perdant` : { nom, avant } ou null, `libelleSerie(nom)`.
function lignesSeries({ gagnant, perdant, record, libelleSerie, libelleRecord }) {
  const rec = record ? `${libelleRecord} : ${record.username ?? "?"} (${record.serie})` : null;
  const lignes = [];
  if (gagnant) lignes.push([`🔥 ${libelleSerie(gagnant.nom)} : ${victoires(gagnant.serie)}`, rec].filter(Boolean).join(" · "));
  else if (rec) lignes.push(rec);
  if (perdant && perdant.avant >= SERIE_CASSEE_MIN) lignes.push(`💔 Fin de la série ${deNom(perdant.nom)} (${perdant.avant})`);
  return lignes;
}

// Fin d'une partie contre Kévina : message public (non éphémère) dans le
// salon, résultat et série. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
  const s = d.series;
  const series = s
    ? lignesSeries({
        // Match nul : série intacte, rappelée si elle est en cours
        gagnant: d.gagnant !== "bot" && s.serie > 0 ? { nom: pseudo, serie: s.serie } : null,
        perdant: d.gagnant === "bot" ? { nom: pseudo, avant: s.avant } : null,
        record: s.record,
        libelleSerie: () => "Série",
        libelleRecord: "Record",
      })
    : [];
  const [joueur, bot] = [score(d, "joueur"), score(d, "bot")];
  const resultat = d.abandon
    ? `🏳️ ${pseudo} abandonne face à Kévina.`
    : d.gagnant === "nul"
      ? `🤝 Match nul entre ${pseudo} et Kévina (${pions(joueur)} chacun).`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} bat Kévina : ${joueur} à ${bot} !`
        : `🤖 Kévina bat ${pseudo} : ${bot} à ${joueur}.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, "", ...plateau(d), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: TOURNEBOULE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function executerSolo(webhookUrl, discordId, c, coup, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(discordId, (d) => {
    const r = actionPoser(d, "joueur", c, coup);
    if (r.erreur) return r;
    const texteJoueur = `${recit(d, "joueur", BOT)}.`;
    const lignes = [recit(d, "joueur", BOT)];
    // Étapes avant la vue finale : retournement du coup du joueur, réflexion
    // de Kévina (plateau après le coup du joueur, puis attente), retournement
    // de son coup ; un retournement qui termine la partie est montré avant
    // le récapitulatif
    const etapes = [];
    const retournementJoueur = etatRetournement(d);
    if (retournementJoueur) etapes.push({ duel: retournementJoueur, texte: texteJoueur, pause: DELAI_RETOURNEMENT_MS });
    // Kévina joue dans la foulée (sous le même verrou)
    if (!d.termine) {
      etapes.push({ duel: structuredClone(d), texte: texteJoueur, reflexion: true });
      poser(d, "bot", choixKevina(d, "bot", {
        profondeur: config.profondeur_kevina,
        erreur: config.erreur_kevina,
        marge: config.marge_kevina,
      }));
      lignes.push(recit(d, "joueur", BOT));
      const retournementKevina = etatRetournement(d);
      if (retournementKevina) etapes.push({ duel: retournementKevina, texte: `${lignes.join(", ")}.`, pause: DELAI_RETOURNEMENT_MS });
    }
    return { texte: `${lignes.join(", ")}.`, vientDeFinir: d.termine, etapes };
  }, { nom: pseudo });
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  // Coup du joueur affiché d'abord, celui de Kévina après sa réflexion
  for (const etape of resultat.etapes ?? []) {
    await Promise.all([patchOriginal(webhookUrl, buildVue(etape.duel, { texte: etape.texte })), majSalonSolo(etape.duel, pseudo)]);
    await pause(etape.reflexion ? REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min) : etape.pause);
  }
  if (resultat.vientDeFinir && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  await Promise.all([
    patchOriginal(webhookUrl, buildVue(duel, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte })),
    // Fin (repli) : plateau public déjà remplacé par le récapitulatif
    ...(resultat.erreur || duel.termine ? [] : [majSalonSolo(duel, pseudo)]),
  ]);
}

const AUCUNE_PARTIE_SOLO = {
  embeds: [
    {
      description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/tourneboule` !",
      color: TOURNEBOULE_COLOR,
    },
  ],
  components: boutonsFin(),
};

// Fin contre Kévina : récapitulatif dans un NOUVEAU message (visible en bas
// du salon), plateau public supprimé (repli : édité en récapitulatif), vue
// éphémère supprimée. Faux si le POST ou la suppression de la vue a échoué
// (l'appelant affiche alors la vue de fin).
async function publierFinSolo(webhookUrl, channelId, duel, pseudo) {
  const final = messageFinalSolo(duel, pseudo ?? "?");
  const { salon } = duel;
  const ok = await messageSalon("POST", salon?.channelId ?? channelId, null, final);
  if (salon) {
    if (ok) await messageSalon("DELETE", salon.channelId, salon.messageId);
    else await messageSalon("PATCH", salon.channelId, salon.messageId, final);
  }
  return Boolean(ok) && (await supprimerOriginal(webhookUrl));
}

// [🏳️] confirmé contre Kévina : défaite, série perdue.
async function abandonSolo(webhookUrl, discordId, { channelId, pseudo } = {}) {
  const { duel, resultat } = await agirDuel(
    discordId,
    (d) => {
      if (d.termine) return { erreur: "termine" };
      Object.assign(d, { termine: true, gagnant: "bot", abandon: "joueur" });
      return {};
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  if (!resultat.erreur && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  await patchOriginal(webhookUrl, buildVue(duel));
}

// ── 1v1 ──────────────────────────────────────────────────────────────

const echeanceDe = (partie, config) =>
  Math.floor((partie.dernierCoupAt + config.delai_tour_minutes * 60_000) / 1000);

function memoriserWebhook(partie, discordId, webhookUrl) {
  if (webhookUrl) partie.webhooks[discordId] = { url: webhookUrl, at: Date.now() };
}

function webhookValide(partie, discordId) {
  const w = partie.webhooks?.[discordId];
  return w && Date.now() - w.at < WEBHOOK_VALIDITE_MS ? w.url : null;
}

// Vue éphémère d'un joueur du 1v1 (lobby, partie, fin). Sans `texte`, le
// dernier coup est raconté. `etat` : étape de retournement à afficher.
function vuePvp(partie, config, discordId, texte = null, { confirmerAbandon = false, etat = null } = {}) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: TOURNEBOULE_COLOR,
        },
      ],
      // Pas de bouton Règles : celui du message public suffit
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  const A = nomsAdv(partie, moi);
  const d = etat ?? partie.duel;
  return buildVue(d, {
    texte: texte ?? (d.dernier ? `${recit(d, moi, A)}.` : null),
    moi,
    A,
    pvp: true,
    echeance: echeanceDe(partie, config),
    raison: partie.raisonFin,
    confirmerAbandon,
  });
}

const BOUTON_JOUER = {
  type: 2,
  style: 3,
  label: "Jouer",
  custom_id: "tourneboulduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, ses
// délai, plateau neutre). `etat` : étape de retournement à afficher.
// [🎮 Reprendre ma partie] pendant la partie : même action que Jouer (un joueur assis
// reçoit sa vue)
const BOUTON_MA_VUE = { type: 2, style: 2, label: "Reprendre ma partie", emoji: { name: "🎮" }, custom_id: "tourneboulduel_ouvrir" };

function messagePublic(partie, config, etat = null) {
  if (partie.statut === "lobby") {
    const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: TOURNEBOULE_COLOR,
        },
      ],
      components,
    };
  }
  const d = etat ?? partie.duel;
  const nom = (siege) => partie.noms[partie.sieges[siege]] ?? "?";
  return {
    embeds: [
      {
        title: `${TITRE} · ${nom("joueur")} contre ${nom("bot")}`,
        // Plateau neutre, suivi par le salon ; chaque joueur joue depuis sa
        // vue éphémère
        description: [
          d.retournement
            ? ligneRetournement(d, nom)
            : `Au tour de **${nom(d.actif)}**, limite <t:${echeanceDe(partie, config)}:R>`,
          "",
          ...plateauPublic(d, nom("joueur"), nom("bot")),
        ].join("\n").slice(0, 4096),
        color: TOURNEBOULE_COLOR,
      },
    ],
    // Partie lancée : [🎮 Reprendre ma partie] renvoie sa vue éphémère à chaque joueur
    // (vue du lanceur postée au défi, plus haut dans le salon ; autre appareil)
    components: [{ type: 1, components: [BOUTON_MA_VUE, BOUTON_REGLES] }],
  };
}

// Titre de fin du 1v1 : gagnant en premier (ordre des sièges si match nul)
const titreGagnant = (g, nom) =>
  g === "nul" ? `${nom("joueur")} contre ${nom("bot")}` : `${nom(g)} contre ${nom(adversaire(g))}`;

// Fin du 1v1 : récapitulatif dans un NOUVEAU message (visible en bas du
// salon), puis suppression du message de la partie.
function messageFinal(partie) {
  const d = partie.duel;
  // Pseudos en clair, jamais de mention (pas de ping)
  const nom = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const resultat =
    partie.raisonFin === "abandon"
      ? `🏳️ ${nom(adversaire(g))} abandonne : ${nom(g)} remporte le duel.`
      : g === "nul"
      ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")} (${pions(score(d, "joueur"))} chacun).`
      : partie.raisonFin === "delai"
        ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nom(g)} bat ${nom(adversaire(g))} : ${score(d, g)} à ${score(d, adversaire(g))} !`;
  const s = partie.series;
  const series = s
    ? lignesSeries({
        gagnant: g !== "nul" ? { nom: nom(g), serie: s[g].serie } : null,
        perdant: g !== "nul" ? { nom: nom(adversaire(g)), avant: s[adversaire(g)].avant } : null,
        record: s.record,
        libelleSerie: (n) => `Série ${deNom(n)}`,
        libelleRecord: "Record 1v1",
      })
    : [];
  return {
    embeds: [
      {
        title: `${TITRE} · ${titreGagnant(g, nom)}`,
        description: [resultat, "", ...plateau(d), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: TOURNEBOULE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées). Avec `retournement` (pions retournés), étape intermédiaire sur les
// vues et le message public d'abord, même si le coup termine la partie.
async function diffuserPvp(partie, config, discordId, webhookUrl, texte, retournement = null) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  if (retournement) {
    await Promise.all([
      patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte, { etat: retournement })),
      ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, null, { etat: retournement }))),
      messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config, retournement)),
    ]);
    await pause(DELAI_RETOURNEMENT_MS);
  }
  if (partie.statut === "fini") {
    const ok = await messageSalon("POST", partie.channelId, null, messageFinal(partie));
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else await messageSalon("PATCH", partie.channelId, partie.messageId, messageFinal(partie));
    // Le récapitulatif suffit : vues éphémères supprimées (repli : vue de fin)
    const vues = [[discordId, webhookUrl, texte], ...autres.map((id) => [id, webhookValide(partie, id), null])];
    await Promise.all(
      vues.map(async ([id, url, t]) => {
        if (ok && (await supprimerOriginal(url))) return;
        await patchOriginal(url, vuePvp(partie, config, id, t));
      }),
    );
    return;
  }
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte)),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id))),
  ]);
  await messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config));
  await rattraperPvp(partie, config);
}

// Les PATCH d'invocations concurrentes arrivent dans n'importe quel ordre :
// une vue peut être écrasée par un état plus ancien (le joueur au trait
// voit alors « au tour de l'adversaire », sans boutons, jusqu'au délai).
// Après sa diffusion, l'invocation relit la partie : si elle a changé
// entre-temps, vues et message public sont rééditées avec l'état frais.
const empreinte = ({ webhooks, ...etat }) => JSON.stringify(etat);

async function rattraperPvp(partie, config) {
  const fraiche = await readPvp();
  if (fraiche?.statut !== "enCours" || empreinte(fraiche) === empreinte(partie)) return;
  await Promise.all([
    ...Object.values(fraiche.sieges).map((id) => patchOriginal(webhookValide(fraiche, id), vuePvp(fraiche, config, id))),
    messageSalon("PATCH", fraiche.channelId, fraiche.messageId, messagePublic(fraiche, config)),
  ]);
}

// Fin au délai sans attendre un clic : sinon le message public reste figé
// « au tour de X, limite il y a … » jusqu'à la prochaine interaction. Après
// un coup, l'invocation attend l'échéance (+1 s) puis clôt la partie si
// personne n'a joué entre-temps (`verifierDelai()` dans `agirPvp`).
async function surveillerDelai(partie, config, discordId, webhookUrl) {
  if (partie.statut !== "enCours") return;
  await pause(Math.max(0, partie.dernierCoupAt + config.delai_tour_minutes * 60_000 - Date.now()) + 1000);
  const r = await agirPvp(() => ({}));
  if (r.partie && r.resultat.vientDeFinir) await diffuserPvp(r.partie, r.config, discordId, webhookUrl, null);
}

const AUCUNE_PARTIE_PVP = {
  embeds: [
    {
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/tourneboule` (1v1) !",
      color: TOURNEBOULE_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/tourneboule adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleTourneboulePvpCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({ channelId: body.channel_id, lanceur: discordId, nom: username });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, {
        content: `Un duel 1v1 est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.`,
      });
      return;
    }
    // Lobby sans adversaire ou partie au délai dépassé, remplacés
    if (r.ancienne?.messageId) await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messagePublic(r.partie, config));
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    // Vue du lanceur SOUS le message public : réponse différée (créée dès
    // la commande, au-dessus) supprimée, vue renvoyée en followup, dont
    // l'URL est mémorisée pour les mises à jour. Repli : réponse différée.
    const vue = vuePvp(r.partie, config, discordId, "🌀 Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    // Adversaire arrivé entre-temps : sa diffusion n'a pas pu atteindre cette vue
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Tourneboule] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour). L'ancienne vue du
// joueur est supprimée : seule la dernière est rééditée, une vue restée
// au-dessus afficherait sinon un tour figé.
export async function handleTournebouleOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    let ancienneVue = null;
    const { partie, config, resultat } = await agirPvp((p) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, discordId, username);
        memoriserWebhook(p, discordId, webhookUrl);
        return { rejoint: true, coup: true };
      }
      if (p.statut !== "lobby" && !siegeDe(p, discordId)) return { erreur: "pasJoueur" };
      ancienneVue = webhookValide(p, discordId);
      memoriserWebhook(p, discordId, webhookUrl);
      return {};
    });
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (resultat.erreur) {
      const [a, b] = Object.values(partie.sieges);
      await patchOriginal(webhookUrl, {
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/tourneboule\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      await supprimerOriginal(ancienneVue);
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.`
        : null;
      // Le lanceur voit aussi l'arrivée de son adversaire
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      if (resultat.rejoint) await surveillerDelai(partie, config, discordId, webhookUrl);
      return;
    }
    // Ancienne vue supprimée APRÈS l'édition de la nouvelle (aller-retour
    // Discord de moins avant d'afficher le bon état), puis rattrapage
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
    await supprimerOriginal(ancienneVue);
    await rattraperPvp(partie, config);
  } catch (err) {
    console.error("[Tourneboule] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, c, coup) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionPoser(p.duel, moi, c, coup);
    return r.erreur ? r : { texte: `${recit(p.duel, moi, nomsAdv(p, moi))}.`, coup: true, retournement: etatRetournement(p.duel) };
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (resultat.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  const texte = resultat.erreur ? avertissement(resultat.erreur) : resultat.texte;
  if (resultat.coup || resultat.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, texte, resultat.retournement);
    if (resultat.coup) await surveillerDelai(partie, config, discordId, webhookUrl);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte));
}

// [🏳️] confirmé en 1v1 : défaite, l'adversaire remporte le duel.
async function abandonPvp(webhookUrl, discordId) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    Object.assign(p.duel, { termine: true, gagnant: adversaire(moi), abandon: moi });
    p.raisonFin = "abandon";
    return {};
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (resultat.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  // Fin par abandon (ou par délai dépassé constaté au même moment)
  if (resultat.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, null);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, avertissement("termine")));
}

// [🏳️] (`etape` "demande") : question de confirmation à la place des
// boutons de jeu ; "non" : retour à la vue ; "ok" : abandon.
export async function handleTournebouleAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (etape === "ok") {
      if (pvp) await abandonPvp(webhookUrl, discordId);
      else await abandonSolo(webhookUrl, discordId, { channelId, pseudo });
      return;
    }
    const confirmerAbandon = etape === "demande";
    if (!pvp) {
      const duel = await readDuel(discordId);
      await patchOriginal(webhookUrl, duel ? buildVue(duel, { confirmerAbandon }) : AUCUNE_PARTIE_SOLO);
      return;
    }
    const partie = await readPvp();
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (!siegeDe(partie, discordId)) {
      await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
      return;
    }
    const config = await loadDuelConfig();
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, null, { confirmerAbandon }));
  } catch (err) {
    console.error("[Tourneboule] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

// `c` : case, `coup` : numéro de vue affiché par la vue cliquée (d.vue).
export async function handleTourneboulePoser(webhookUrl, discordId, c, coup, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (!Number.isInteger(c) || c < 0 || c >= NB_CASES || c === ROC) return;
    if (pvp) await executerPvp(webhookUrl, discordId, c, coup);
    else await executerSolo(webhookUrl, discordId, c, coup, { channelId, pseudo });
  } catch (err) {
    console.error("[Tourneboule] Échec poser:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleTournebouleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Tourneboule] Échec Règles:", err.message);
  }
}
