// ============================================================
// puntoDuel.js (handler) — Punto (`/punto`), deux modes :
// - contre Kévina, le bot (`/punto adversaire:bot`) : plateau public
//   dans le salon (suivi par tous) et vue éphémère du joueur (plateau en
//   boutons), édités en place à chaque coup ; Kévina joue aussitôt après
//   le joueur ; résultat publié dans un nouveau message en fin de partie ;
// - 1v1 (`/punto adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; plateau visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque coup du joueur). Une seule
//   partie à la fois, comme Quatre à la suite.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : puntoduel_poser:<case> (contre Kévina),
// puntoduel_poser:<case>:pvp (1v1), puntoduel_ouvrir (bouton Jouer du
// message public), puntoduel_regles, puntoduel_abandon[:pvp] (🏳️, demande
// confirmation), puntoduel_abandon_ok[:pvp] / puntoduel_abandon_non[:pvp].
//
// Service : jeux/services/puntoDuel.js (Redis),
// règles : jeux/services/puntoRules.js, cartes : jeux/services/puntoCartes.js.
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
} from "../../services/puntoDuel.js";
import { TAILLE, NB_CASES, adversaire, casesJouables, choixKevina, poser } from "../../services/puntoRules.js";
import { carteButtonEmoji, formatCarte } from "../../services/puntoCartes.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

// Violet élixir
const PUNTO_COLOR = 0x8e44c9;
const TITRE = "🃏 Punto";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Ses propres couleurs froides (bleu, vert), celles de l'adversaire
// chaudes (rouge, orange), comme le bleu et le rouge de Clash Royale ;
// indice = couleur de la carte (0 ou 1) dans le moteur
const MOI = ["bleu", "vert"];
const ADV = ["rouge", "orange"];
const PASTILLES = { moi: "🟦🟩", adv: "🟥🟧" };
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
      accent_color: embed.color ?? PUNTO_COLOR,
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
    if (!res.ok) console.error(`[Punto] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Punto] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Punto] Échec DELETE:", err.message);
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
      console.error(`[Punto] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Punto] Échec followup:", err.message);
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
      console.warn(`[Punto] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Punto] Erreur réseau (${method} message public):`, err.message);
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

// Couleur affichée d'une carte du siège `s` (couleur `k` du moteur), vue
// par le siège `moi`.
const couleurDe = (s, k, moi) => (s === moi ? MOI : ADV)[k];

// Carte en emoji vue par `moi` ; `s` : siège du propriétaire.
const carteVue = (carte, s, moi, opts) => formatCarte(couleurDe(s, carte.k, moi), carte.v, opts);

// Plateau vu par le siège `moi` (ses cartes en bleu et vert) : emojis à
// taille de texte séparés par une espace, une rangée par ligne de texte.
// `noms` : { moi, adv } libellés des deux camps, en légende.
function plateau(d, moi, noms) {
  const gagnantes = new Set(d.alignement ?? []);
  const rangees = [];
  for (let r = 0; r < TAILLE; r++) {
    const cases = [];
    for (let c = 0; c < TAILLE; c++) {
      const i = r * TAILLE + c;
      const x = d.grille[i];
      cases.push(x ? carteVue(x, x.s, moi, { gagnant: gagnantes.has(i) }) : formatCarte("vide"));
    }
    rangees.push(cases.join(" "));
  }
  return [`${PASTILLES.moi} **${noms.moi}** · ${PASTILLES.adv} **${noms.adv}**`, ...rangees];
}

// Plateau neutre (message public) : premier joueur en bleu et vert.
function plateauPublic(d, nomJoueur, nomBot) {
  return plateau(d, "joueur", { moi: nomJoueur, adv: nomBot });
}

// Récit du dernier coup et des cartes défaussées depuis, vu par `moi` :
// « Kévina pose 🟥7 sur ton 🟦4. », « Ta carte 🟦1 ne peut être posée
// nulle part : défaussée. »
function recit(d, moi, A) {
  const lignes = [];
  const x = d.dernier;
  if (x) {
    const sujet = x.id === moi ? "Tu poses" : `${A.Sujet} pose`;
    const sur = x.recouverte
      ? ` sur ${x.recouverte.s === moi ? "ton" : x.id === moi ? "le" : "son"} ${carteVue(x.recouverte, x.recouverte.s, moi)}`
      : "";
    lignes.push(`${sujet} ${carteVue(x.carte, x.id, moi)}${sur}.`);
  }
  for (const { id, carte } of d.defausses ?? []) {
    lignes.push(
      `${id === moi ? "Ta carte" : `La carte de ${A.Sujet}`} ${carteVue(carte, id, moi)} ne peut être posée nulle part : défaussée.`,
    );
  }
  return lignes.join("\n") || null;
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  interdite: "Ta carte ne peut pas aller sur cette case.",
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
  custom_id: "puntoduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

// 🏳️ : abandon, après confirmation (défaite, la série est perdue)
const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `puntoduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `puntoduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `puntoduel_abandon_non${sfx}` },
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
      : d.gagnant === "nul"
        ? "Les pioches sont vides."
        : d.gagnant === moi
          ? "Tu alignes 4 cartes de la même couleur."
          : `${A.Sujet} aligne 4 cartes de la même couleur.`;
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
        color: PUNTO_COLOR,
      },
    ],
    // Pas de bouton Règles : celui du message public posté au même moment suffit
    components: [],
  };
}

// Plateau en boutons (5 rangées de 5) : chaque bouton montre la carte du
// dessus (ou une case vide). À son tour, les cases où la carte peut aller
// sont en bleu, les autres grisées ; hors de son tour, tout est grisé.
function boutonsPlateau(d, moi, monTour, sfx) {
  const jouables = new Set(monTour && d.carte ? casesJouables(d.grille, d.carte) : []);
  const rangees = [];
  for (let r = 0; r < TAILLE; r++) {
    const components = [];
    for (let c = 0; c < TAILLE; c++) {
      const i = r * TAILLE + c;
      const x = d.grille[i];
      const emoji = x ? carteButtonEmoji(couleurDe(x.s, x.k, moi), x.v) : carteButtonEmoji("vide");
      components.push({
        type: 2,
        style: jouables.has(i) ? 1 : 2,
        // Repli tant que les emojis ne sont pas uploadés : la valeur en texte
        ...(emoji ? { emoji } : { label: x ? String(x.v) : "·" }),
        custom_id: `puntoduel_poser:${i}${sfx}`,
        disabled: !jouables.has(i),
      });
    }
    rangees.push({ type: 1, components });
  }
  return rangees;
}

// « Ta carte : 🟦7 » à son tour, « Carte de Kévina : 🟥3 » sinon.
function ligneCarte(d, moi, A) {
  if (!d.carte) return null;
  const carte = carteVue(d.carte, d.actif, moi);
  return d.actif === moi ? `**Ta carte : ${carte}**` : `Carte de ${A.Sujet} : ${carte}`;
}

// Vue d'un joueur : résultat de la dernière action (`texte`), carte à
// poser et plateau en boutons (grisés hors de son tour), ou fin.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison,
// confirmerAbandon (question et plateau en texte à la place des boutons) }
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false } = {},
) {
  if (d.termine) return vueFin(d, { moi, A, raison });
  const monTour = d.actif === moi;
  const sfx = pvp ? ":pvp" : "";
  const noms = { moi: "Toi", adv: `${A.emoji} ${A.Sujet}` };
  const lignes = confirmerAbandon
    ? ["🏳️ **Abandonner la partie ?** Ce sera une défaite.", "", ...plateau(d, moi, noms)]
    : [
        ...(texte ? [texte, ""] : []),
        `${PASTILLES.moi} **${noms.moi}** · ${PASTILLES.adv} **${noms.adv}**`,
        ligneCarte(d, moi, A),
        ...(monTour ? [] : [`⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
      ].filter((l) => l !== null);
  const titre = `${TITRE} · ${pvp ? (monTour ? "À toi !" : `contre ${A.Sujet}`) : "contre Kévina"}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: PUNTO_COLOR };
  if (confirmerAbandon) return { embeds: [embed], components: boutonsConfirmation(sfx) };
  // Contre Kévina, ce n'est jamais son tour qu'en pleine réflexion : pas d'abandon
  const regles = { type: 1, components: [BOUTON_REGLES, ...(monTour || pvp ? [boutonAbandon(sfx)] : [])] };
  return { embeds: [embed], components: [...boutonsPlateau(d, moi, monTour, sfx), regles] };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Punto",
    description: [
      `Une grille de ${TAILLE}×${TAILLE} cases. Chaque joueur a sa pioche de 36 cartes : 2 couleurs, de 1 à 9 élixir, chaque carte en double. Tes cartes sont bleues et vertes, celles de ton adversaire rouges et orange.`,
      "",
      "**🃏 À ton tour** : tu retournes la carte du dessus de ta pioche et tu la poses :",
      "• sur une case vide **voisine** d'une carte (côté ou coin) ;",
      "• ou **sur une carte moins chère**, quelle que soit sa couleur : elle la recouvre.",
      "La toute première carte se pose au centre. Les cases possibles sont en bleu.",
      "**🏆 Victoire** : le premier qui aligne 4 cartes **de la même couleur** (horizontale, verticale ou diagonale) gagne.",
      "**🗑️ Carte bloquée** : si elle ne peut aller nulle part, elle est défaussée et ton adversaire joue.",
      "**🤝 Match nul** : les pioches sont vides sans alignement.",
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: PUNTO_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionPoser(d, moi, i) {
  const r = poser(d, moi, i);
  if (r.erreur) {
    return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : "interdite" };
  }
  return {};
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handlePuntoRoleRejected(webhookUrl) {
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
          d.actif === "bot"
            ? "⏳ Kévina réfléchit…"
            : `Au tour de **${pseudo}**, carte à poser : ${carteVue(d.carte, d.actif, "joueur")}`,
          "",
          ...plateauPublic(d, pseudo, "🤖 Kévina"),
          "",
          `⏰ Sans action, partie abandonnée <t:${expiration}:R>.`,
        ]
          .join("\n")
          .slice(0, 4096),
        color: PUNTO_COLOR,
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
export async function handlePuntoCommand(webhookUrl, body) {
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
      texte: "Nouvelle partie contre Kévina ! Tu commences : ta première carte va au centre.",
    });
    if (enregistre && (await supprimerOriginal(webhookUrl)) && (await envoyerEphemere(webhookUrl, vue))) return;
    await patchOriginal(webhookUrl, vue);
  } catch (err) {
    console.error("[Punto] Échec lancement:", err.message);
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
// salon, plateau final et série compris. Pseudo en clair, jamais de mention.
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
  const resultat = d.abandon
    ? `🏳️ ${pseudo} abandonne face à Kévina.`
    : d.gagnant === "nul"
      ? `🤝 Match nul entre ${pseudo} et Kévina, les pioches sont vides.`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} aligne 4 cartes et bat Kévina !`
        : `🤖 Kévina aligne 4 cartes et bat ${pseudo}.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, "", ...plateauPublic(d, pseudo, "🤖 Kévina"), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: PUNTO_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function executerSolo(webhookUrl, discordId, i, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(discordId, (d) => {
    const r = actionPoser(d, "joueur", i);
    if (r.erreur) return r;
    const texteJoueur = recit(d, "joueur", BOT);
    const lignes = [texteJoueur];
    // Plateau après le coup du joueur, affiché pendant la réflexion de Kévina
    let avantKevina = null;
    // Kévina joue dans la foulée (sous le même verrou), plusieurs fois si
    // la carte du joueur est défaussée
    while (!d.termine && d.actif === "bot") {
      avantKevina ??= structuredClone(d);
      poser(d, "bot", choixKevina(d, "bot", {
        defense: config.defense_kevina,
        prudence: config.prudence_kevina,
        solidite: config.solidite_kevina,
        marge: config.marge_kevina,
      }));
      lignes.push(recit(d, "joueur", BOT));
    }
    return { texte: lignes.join("\n"), vientDeFinir: d.termine, avantKevina, texteJoueur };
  }, { nom: pseudo });
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  if (resultat.avantKevina) {
    // Coup du joueur affiché d'abord, celui de Kévina après sa réflexion
    await Promise.all([
      patchOriginal(webhookUrl, buildVue(resultat.avantKevina, { texte: resultat.texteJoueur })),
      majSalonSolo(resultat.avantKevina, pseudo),
    ]);
    await pause(REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min));
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
      description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/punto` !",
      color: PUNTO_COLOR,
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
// dernier coup est raconté.
function vuePvp(partie, config, discordId, texte = null, { confirmerAbandon = false } = {}) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: PUNTO_COLOR,
        },
      ],
      // Pas de bouton Règles : celui du message public suffit
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  const A = nomsAdv(partie, moi);
  const d = partie.duel;
  return buildVue(d, {
    texte: texte ?? recit(d, moi, A),
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
  custom_id: "puntoduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, carte à
// poser, délai, plateau neutre).
function messagePublic(partie, config) {
  if (partie.statut === "lobby") {
    const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: PUNTO_COLOR,
        },
      ],
      components,
    };
  }
  const d = partie.duel;
  const nom = (siege) => partie.noms[partie.sieges[siege]] ?? "?";
  return {
    embeds: [
      {
        title: `${TITRE} · ${nom("joueur")} contre ${nom("bot")}`,
        // Plateau neutre, suivi par le salon ; chaque joueur joue depuis sa
        // vue éphémère
        description: [
          `Au tour de **${nom(d.actif)}**, carte à poser : ${carteVue(d.carte, d.actif, "joueur")}, limite <t:${echeanceDe(partie, config)}:R>`,
          "",
          ...plateauPublic(d, nom("joueur"), nom("bot")),
        ].join("\n").slice(0, 4096),
        color: PUNTO_COLOR,
      },
    ],
    // Partie lancée : Jouer retiré, on joue depuis sa vue éphémère
    components: boutonsFin(),
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
      ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")}, les pioches sont vides.`
      : partie.raisonFin === "delai"
        ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nom(g)} aligne 4 cartes et bat ${nom(adversaire(g))} !`;
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
        description: [resultat, "", ...plateauPublic(d, nom("joueur"), nom("bot")), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: PUNTO_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées).
async function diffuserPvp(partie, config, discordId, webhookUrl, texte) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
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
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/punto` (1v1) !",
      color: PUNTO_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/punto adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handlePuntoPvpCommand(webhookUrl, body) {
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
    const vue = vuePvp(r.partie, config, discordId, "🃏 Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    // Adversaire arrivé entre-temps : sa diffusion n'a pas pu atteindre cette vue
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Punto] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour). L'ancienne vue du
// joueur est supprimée : seule la dernière est rééditée, une vue restée
// au-dessus afficherait sinon un tour figé.
export async function handlePuntoOuvrir(webhookUrl, body) {
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
    await supprimerOriginal(ancienneVue);
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (resultat.erreur) {
      const [a, b] = Object.values(partie.sieges);
      await patchOriginal(webhookUrl, {
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/punto\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence (première carte au centre).`
        : null;
      // Le lanceur voit aussi l'arrivée de son adversaire
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      if (resultat.rejoint) await surveillerDelai(partie, config, discordId, webhookUrl);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[Punto] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, i) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionPoser(p.duel, moi, i);
    return r.erreur ? r : { texte: recit(p.duel, moi, nomsAdv(p, moi)), coup: true };
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
    await diffuserPvp(partie, config, discordId, webhookUrl, texte);
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
export async function handlePuntoAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
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
    console.error("[Punto] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

export async function handlePuntoPoser(webhookUrl, discordId, i, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (!Number.isInteger(i) || i < 0 || i >= NB_CASES) return;
    if (pvp) await executerPvp(webhookUrl, discordId, i);
    else await executerSolo(webhookUrl, discordId, i, { channelId, pseudo });
  } catch (err) {
    console.error("[Punto] Échec poser:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handlePuntoRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Punto] Échec Règles:", err.message);
  }
}
