// ============================================================
// potatoDuel.js (handler) — Potato (`/potato`), deux modes :
// - contre Kévina, le bot (`/potato adversaire:bot`) : message public dans
//   le salon (barre des chauffes, suivie par tous) et vue éphémère du joueur
//   (thermomètre, patate, boutons), éditées en place à chaque coup ; Kévina
//   joue aussitôt après le joueur ; résultat publié dans un nouveau message
//   en fin de partie ;
// - 1v1 (`/potato adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre) et une vue éphémère par
//   joueur, rééditée après chaque coup adverse (webhook mémorisé, valable
//   15 min, renouvelé à chaque coup du joueur). Une seule partie à la fois.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : potatoduel_chauffer:<0|1|2>:<vue>[:pvp], potatoduel_ouvrir
// (bouton Jouer du message public), potatoduel_regles,
// potatoduel_abandon[:pvp] (🏳️, demande confirmation),
// potatoduel_abandon_ok[:pvp] / potatoduel_abandon_non[:pvp].
// <vue> = d.vue à l'affichage : un clic sur une vue dépassée est refusé.
//
// Service : jeux/services/potatoDuel.js (Redis), règles :
// jeux/services/potatoRules.js, images : jeux/services/potatoImage.js
// (routes /api/potato/vue et /api/potato/public).
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  loadDuelConfig,
  nouveauDuel,
  ouvrirPvp,
  readDuel,
  readPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/potatoDuel.js";
import {
  CHAUFFES,
  FUME,
  GLACON,
  MANCHES_GAGNANTES,
  SEUIL_MAX,
  SEUIL_MIN,
  SIFFLE,
  TEMP_DEPART,
  adversaire,
  chauffePermise,
  chauffer,
  chauffesDe,
  choixKevina,
  etatVisible,
  evenementDe,
  reperes,
} from "../../services/potatoRules.js";
import { encodePublic, encodeVue } from "../../services/potatoImage.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";

// Brun patate
const POTATO_COLOR = 0xc98a3c;
const TITRE = "🥔 Potato";
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;
// Explosion affichée un instant avant la manche suivante
const DELAI_FIN_MANCHE_MS = 2500;
// Contre Kévina : délai avant d'afficher son coup (elle joue en quelques
// millisecondes, un coup instantané paraît mécanique)
const REFLEXION_MS = { min: 1200, max: 2800 };
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
// les vues sont écrites comme des embeds, converties ici à l'envoi : titre
// en `###`, description, image (galerie), puis boutons.
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
      accent_color: embed.color ?? POTATO_COLOR,
      components: [
        { type: 10, content: texte.slice(0, TEXTE_MAX) },
        ...(embed.image?.url ? [{ type: 12, items: [{ media: { url: embed.image.url } }] }] : []),
        ...components,
      ],
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
    if (!res.ok) console.error(`[Potato] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Potato] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Potato] Échec DELETE:", err.message);
    return false;
  }
}

// Nouveau message éphémère de l'interaction (followup), posté après les
// messages déjà présents. Renvoie l'URL du followup, null en cas d'échec.
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
      console.error(`[Potato] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Potato] Échec followup:", err.message);
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
      console.warn(`[Potato] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Potato] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

// Désignation de l'adversaire dans les textes : Kévina (le bot) ou un joueur.
const BOT = { Sujet: "Kévina" };
const nomsAdv = (partie, moi) => ({ Sujet: partie.noms[partie.sieges[adversaire(moi)]] ?? "?" });

// Côté d'un siège dans l'image publique : joueur à gauche, bot à droite
const cote = (id) => (id === "joueur" ? 0 : 1);

// Image de la vue de `moi` : thermomètre (repères fume / siffle), patate
// et, si c'est son tour, son événement (le Thermomètre y montre la
// température d'explosion).
function urlVue(d, moi) {
  const ev = d.actif === moi ? evenementDe(d, moi) : null;
  const param = encodeVue({
    temp: d.temp,
    etat: etatVisible(d),
    evenement: ev?.type ?? null,
    explosion: ev?.type === "thermo" ? d.seuil : null,
    ...reperes(d),
  });
  return `${TRUST_ROYALE_URL}/api/potato/vue?d=${param}`;
}

// Manche affichée publiquement : la dernière terminée tant que la nouvelle
// n'a reçu aucune chauffe (ou en fin de partie), sinon celle en cours.
const mancheTerminee = (d) => (d.historique.length && (d.termine || !d.chauffes.length) ? d.historique.at(-1) : null);

// Image publique : joueurs (`nomDe(siège)`), manches, barre des chauffes ;
// `deco` : patate qui fume au centre (message final).
function urlPublic(d, nomDe, { deco = false } = {}) {
  const h = mancheTerminee(d);
  const param = encodePublic({
    noms: [nomDe("joueur"), nomDe("bot")],
    manches: [d.manches.joueur, d.manches.bot],
    chauffes: (h ?? d).chauffes.map((c) => [cote(c.id), c.v]),
    tient: h ? -1 : cote(d.actif),
    explose: h ? cote(h.perdant) : -1,
    deco,
  });
  return `${TRUST_ROYALE_URL}/api/potato/public?d=${param}`;
}

// Récit d'une action `x` (`d.dernier`) : `S` sujet, `toi` deuxième personne.
function phraseAction(x, S, toi) {
  const v = (tu, il) => (toi ? tu : il);
  const c = `+${x.chauffe} °C`;
  const ev = x.evenement?.type;
  if (x.gants) return `🧤 ${S} ${v("enfiles", "enfile")} les gants : la patate ${v("t'aurait", "lui aurait")} explosé dans les mains, elle passe brûlante (${c})`;
  if (ev === "glacon") return `🧊 ${S} ${v("reçois", "reçoit")} un glaçon (−${GLACON} °C), puis ${v("chauffes", "chauffe")} de ${c}`;
  if (ev === "thermo") return `🌡️ ${S} ${v("lis", "lit")} le thermomètre, puis ${v("chauffes", "chauffe")} de ${c}`;
  if (ev === "four") return `♨️ ${S} ${v("passes", "passe")} la patate au four : ${c}`;
  if (ev === "gants") return `🧤 ${S} ${v("chauffes", "chauffe")} de ${c} avec les gants`;
  if (ev === "retour") return `🔁 ${S} ${v("chauffes", "chauffe")} de ${c}, et la patate ${v("te", "lui")} revient`;
  if (ev === "courant") return `🌬️ ${S} ${v("chauffes", "chauffe")} de ${c} dans un courant d'air`;
  if (ev === "impose") return `🎯 Chauffe imposée : ${S.toLowerCase() === "tu" ? "tu" : S} ${v("chauffes", "chauffe")} de ${c}`;
  return `${S} ${v("chauffes", "chauffe")} la patate de ${c}`;
}

// Récit de la dernière action vue par `moi`, sans point final.
function recit(d, moi, A) {
  const x = d.dernier;
  if (!x) return null;
  const toi = x.id === moi;
  return phraseAction(x, toi ? "Tu" : A.Sujet, toi);
}

const recitPublic = (d, nomDe) => (d.dernier ? `${phraseAction(d.dernier, nomDe(d.dernier.id), false)}.` : null);

// « 💥 La patate t'explose dans les mains à 115 °C (dès 105 °C) : manche 2
// pour Kévina » ; `nomDe(id)` : null pour « toi ».
function ligneManche(h, numero, nomDe) {
  const p = nomDe(h.perdant);
  const g = nomDe(h.gagnant);
  const temp = h.temp > h.seuil ? `à ${h.temp} °C (elle explosait dès ${h.seuil} °C)` : `à ${h.temp} °C`;
  const ou = p ? `explose dans les mains de ${p} ${temp}` : `t'explose dans les mains ${temp}`;
  return `💥 ${h.renvoi ? "Renvoyée brûlante, la patate" : "La patate"} ${ou} : manche ${numero} pour ${g ?? "toi"}`;
}

const score = (d, moi, A) => `Toi ${d.manches[moi]} – ${d.manches[adversaire(moi)]} ${A.Sujet}`;

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  choix: "Choix impossible.",
  perime: "La patate a changé depuis : rejoue sur cette vue.",
  impose: "Chauffe imposée : +10 °C seulement.",
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};

const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "potatoduel_regles" };
const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];
const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `potatoduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `potatoduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `potatoduel_abandon_non${sfx}` },
      ],
    },
  ];
}

function titreFin(d, moi, A, raison) {
  if (d.abandon) return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} abandonne.` : "🏳️ Tu abandonnes.";
  if (raison === "delai") return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.` : "💀 Défaite… tu n'as pas joué à temps.";
  return d.gagnant === moi ? "🏆 Victoire !" : "💀 Défaite…";
}

// Vue de fin : une phrase, le détail est dans le message public posté au
// même moment.
function vueFin(d, { moi, A, raison }) {
  const issue = d.gagnant === moi ? "c'est une victoire pour toi !" : "c'est une défaite pour toi…";
  return {
    embeds: [
      {
        title: `${TITRE} · ${titreFin(d, moi, A, raison)}`,
        description: `${score(d, moi, A)}. La partie est terminée, et ${issue}`,
        color: POTATO_COLOR,
      },
    ],
    components: [],
  };
}

// Vue d'un joueur : score dans le titre, récit, consigne, image (thermomètre
// et patate), boutons de chauffe. Étape de fin de manche (`d.etapeManche`) :
// récit et explosion en texte seulement (l'explosion se voit en public).
function buildVue(d, { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false } = {}) {
  if (d.termine && !d.etapeManche) return vueFin(d, { moi, A, raison });
  const monTour = !d.etapeManche && d.actif === moi;
  const sfx = pvp ? ":pvp" : "";
  const titre = `${TITRE} · ${score(d, moi, A)}${pvp && monTour ? " · À toi !" : ""}`;
  if (confirmerAbandon) {
    return {
      embeds: [{ title: titre, description: "🏳️ **Abandonner la partie ?** Ce sera une défaite.", color: POTATO_COLOR }],
      components: boutonsConfirmation(sfx),
    };
  }
  if (d.etapeManche) {
    const h = d.etapeManche;
    return {
      embeds: [
        {
          title: titre,
          description: [texte, "", ligneManche(h, h.numero, (id) => (id === moi ? null : A.Sujet))].filter((l) => l !== null).join("\n"),
          color: POTATO_COLOR,
        },
      ],
      components: [],
    };
  }
  const consigne = monTour ? "À toi : chauffe la patate, puis elle passe." : `⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`;
  const limite = monTour && echeance ? [`⏰ Limite <t:${echeance}:R>`] : [];
  const ev = monTour ? evenementDe(d, moi) : null;
  const evenement = ev ? ["", LIGNES_EVENEMENT[ev.type](d)] : [];
  const lignes = [`Manche **${d.numero}** · premier à ${MANCHES_GAGNANTES}`, ...(texte ? ["", texte] : []), ...evenement, "", consigne, ...limite];
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), image: { url: urlVue(d, moi) }, color: POTATO_COLOR };
  const chauffes = monTour
    ? chauffesDe(d, moi).map((c, k) => ({
        type: 2,
        style: 2,
        label: `+${c} °C`,
        emoji: { name: "🔥" },
        custom_id: `potatoduel_chauffer:${k}:${d.vue}${sfx}`,
        disabled: !chauffePermise(d, moi, k),
      }))
    : [];
  // Contre Kévina, ce n'est jamais son tour qu'en pleine réflexion : pas d'abandon
  // Bouton Règles : sur le message public seulement (jamais en double)
  const abandon = monTour || pvp ? [boutonAbandon(sfx)] : [];
  const rangee = [...chauffes, ...abandon];
  return { embeds: [embed], components: rangee.length ? [{ type: 1, components: rangee }] : [] };
}

// Ligne de l'événement du joueur au trait, dans sa vue
const LIGNES_EVENEMENT = {
  glacon: () => `🧊 **Glaçon** : la patate refroidit de ${GLACON} °C.`,
  four: () => "♨️ **Four** : ta chauffe compte double.",
  thermo: (d) => `🌡️ **Thermomètre** : la patate explose à ${d.seuil} °C.`,
  gants: () => "🧤 **Gants** : si ta chauffe devait la faire exploser, elle passe brûlante à ton adversaire.",
  retour: () => "🔁 **Retour à l'envoyeur** : après ta chauffe, la patate te revient et tu rejoues.",
  courant: () => "🌬️ **Courant d'air** : impossible de voir si la patate fume ou siffle.",
  impose: () => "🎯 **Chauffe imposée** : +10 °C seulement.",
};

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Potato",
    description: [
      `Une patate passe de main en main en chauffant. Elle part de **${TEMP_DEPART} °C** et explose à une température **secrète**, tirée entre **${SEUIL_MIN} et ${SEUIL_MAX} °C** à chaque manche.`,
      "",
      `**🔥 À ton tour** : chauffe-la de **${CHAUFFES.map((c) => `+${c}`).join(", ").replace(/, ([^,]*)$/, " ou $1")} °C**, puis elle passe à l'adversaire. Celui qui la fait exploser **perd la manche**.`,
      `**👀 Indices** : la patate fume quand l'explosion est à ${FUME} °C ou moins, puis siffle à ${SIFFLE} °C ou moins. Ton thermomètre note la température où elle a commencé à fumer, puis à siffler.`,
      "",
      "**🎲 Événements** (un peu plus d'un tour sur trois, pour celui qui tient la patate) :",
      `- 🧊 **Glaçon** : la patate refroidit de ${GLACON} °C.`,
      "- ♨️ **Four** : ta chauffe compte double.",
      "- 🌡️ **Thermomètre** : tu vois la température d'explosion.",
      "- 🧤 **Gants** : si ta chauffe devait faire exploser la patate, elle passe brûlante à l'adversaire et lui explose dans les mains (sauf si un Glaçon ou ses propres Gants le sauvent).",
      "- 🔁 **Retour à l'envoyeur** : après ta chauffe, la patate te revient et tu rejoues.",
      "- 🌬️ **Courant d'air** : impossible de voir si la patate fume ou siffle.",
      "- 🎯 **Chauffe imposée** : +10 °C seulement.",
      "",
      `**🏁 Manches** : le perdant commence la suivante. **Premier à ${MANCHES_GAGNANTES} manches.**`,
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ ${plural(config.delai_tour_minutes, "minute")} par action, sinon défaite.`,
    ].join("\n"),
    color: POTATO_COLOR,
  };
}

// ── Actions (communes aux deux modes) ────────────────────────────────

// Chauffe n° `k` du siège `moi` ; `vue` : numéro de la vue cliquée.
function agir(d, moi, k, vue) {
  if (d.termine) return { erreur: "termine" };
  if (vue !== d.vue) return { erreur: "perime" };
  return chauffer(d, moi, k);
}

// Copie du duel pour l'étape de fin de manche `numero` (explosion).
function etapeFinManche(d, numero) {
  const e = structuredClone(d);
  e.etapeManche = { ...d.historique[numero - 1], numero };
  return e;
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handlePotatoRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, { content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie." });
}

// Ligne publique de la dernière manche terminée, affichée jusqu'à la
// première chauffe de la suivante.
function ligneDerniereManche(d, nomDe) {
  const h = mancheTerminee(d);
  return h && !d.termine ? ligneManche(h, d.historique.length, nomDe) : null;
}

// Message public d'une partie contre Kévina : suivi par le salon, le joueur
// joue depuis sa vue éphémère.
function messageSolo(d, pseudo, config) {
  const nomDe = (id) => (id === "bot" ? "Kévina" : pseudo);
  const derniere = ligneDerniereManche(d, nomDe);
  const recitPub = !derniere && d.dernier?.manche === d.numero ? recitPublic(d, nomDe) : null;
  const etat = d.etapeManche
    ? null
    : d.actif === "bot"
      ? "⏳ Kévina réfléchit…"
      : `Au tour de **${pseudo}**, limite <t:${echeanceSolo(d, config)}:R>.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [
          `Manche **${d.numero}** · Score : **${pseudo} ${d.manches.joueur}** – ${d.manches.bot} 🤖 Kévina`,
          ...(derniere ? ["", derniere] : []),
          ...(recitPub ? ["", recitPub] : []),
          ...(etat ? ["", etat] : []),
        ]
          .join("\n")
          .slice(0, 4096),
        image: { url: urlPublic(d, nomDe) },
        color: POTATO_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function majSalonSolo(d, pseudo, config) {
  if (d.salon) await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, messageSolo(d, pseudo ?? "?", config));
}

// Lance une nouvelle partie : message public dans le salon, puis vue
// éphémère du joueur EN DESSOUS (réponse différée supprimée, vue renvoyée
// en followup). Repli : vue dans la réponse différée.
export async function handlePotatoCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const { duel, ancien } = await nouveauDuel(discordId);
    if (ancien?.salon && !ancien.termine) await messageSalon("DELETE", ancien.salon.channelId, ancien.salon.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messageSolo(duel, username, config));
    const enregistre = message?.id
      ? await agirDuel(discordId, (d) => {
          d.salon = { channelId: body.channel_id, messageId: message.id };
        })
      : null;
    const d = enregistre?.duel ?? duel;
    const vue = vueSolo(d, config, { texte: "Nouvelle partie contre Kévina ! Tu commences." });
    if (!(enregistre && (await supprimerOriginal(webhookUrl)) && (await envoyerEphemere(webhookUrl, vue)))) await patchOriginal(webhookUrl, vue);
    await surveillerDelaiSolo(webhookUrl, discordId, d, config, { channelId: body.channel_id, pseudo: username });
  } catch (err) {
    console.error("[Potato] Échec lancement:", err.message);
  }
}

// ── Séries de victoires (messages de fin) ────────────────────────────

const SERIE_CASSEE_MIN = 2;
const victoires = (n) => (n > 1 ? `${n} victoires d'affilée` : `${n} victoire`);
const deNom = (pseudo) => (/^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo) ? `d'${pseudo}` : `de ${pseudo}`);

function lignesSeries({ gagnant, perdant, record, libelleSerie, libelleRecord }) {
  const rec = record ? `${libelleRecord} : ${record.username ?? "?"} (${record.serie})` : null;
  const lignes = [];
  if (gagnant) lignes.push([`🔥 ${libelleSerie(gagnant.nom)} : ${victoires(gagnant.serie)}`, rec].filter(Boolean).join(" · "));
  else if (rec) lignes.push(rec);
  if (perdant && perdant.avant >= SERIE_CASSEE_MIN) lignes.push(`💔 Fin de la série ${deNom(perdant.nom)} (${perdant.avant})`);
  return lignes;
}

// Fin d'une partie contre Kévina : message public (non éphémère), résultat,
// dernière manche et série. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
  const nomDe = (id) => (id === "bot" ? "Kévina" : pseudo);
  const s = d.series;
  const series = s
    ? lignesSeries({
        gagnant: d.gagnant === "joueur" && s.serie > 0 ? { nom: pseudo, serie: s.serie } : null,
        perdant: d.gagnant === "bot" ? { nom: pseudo, avant: s.avant } : null,
        record: s.record,
        libelleSerie: () => "Série",
        libelleRecord: "Record",
      })
    : [];
  const [j, b] = [d.manches.joueur, d.manches.bot];
  const finJeu = !d.abandon && !d.delai;
  const resultat = d.abandon
    ? `🏳️ ${pseudo} abandonne face à Kévina.`
    : d.delai
      ? `⏰ ${pseudo} n'a pas joué à temps : Kévina gagne.`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} bat Kévina : ${j} manches à ${b} !`
        : `🤖 Kévina bat ${pseudo} : ${b} manches à ${j}.`;
  const derniere = finJeu ? ligneManche(d.historique.at(-1), d.historique.length, nomDe) : null;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, ...(derniere ? ["", derniere] : []), ...(series.length ? ["", ...series] : [])].join("\n").slice(0, 4096),
        ...(finJeu ? { image: { url: urlPublic(d, nomDe, { deco: true }) } } : {}),
        color: POTATO_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Chauffe du joueur contre Kévina, puis les chauffes de Kévina tant que
// c'est son tour (manche suivante comprise). Étapes affichées dans l'ordre :
// réflexion de Kévina, explosions.
async function executerSolo(webhookUrl, discordId, k, vue, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(
    discordId,
    (d) => {
      const avant = d.historique.length;
      const r = agir(d, "joueur", k, vue);
      if (r.erreur) return r;
      const etapes = [];
      const reflexion = () => REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min);
      // Récit du tour : chauffe du joueur puis celles de Kévina (repart à zéro à chaque manche)
      let lignes = [recit(d, "joueur", BOT)];
      const texte = () => `${lignes.join(".\n")}.`;
      if (d.historique.length > avant) {
        etapes.push({ duel: etapeFinManche(d, avant + 1), texte: texte(), pause: DELAI_FIN_MANCHE_MS });
        lignes = [];
      }
      // Kévina joue dans la foulée (sous le même verrou)
      for (let n = 0; n < 20 && !d.termine && d.actif === "bot"; n++) {
        etapes.push({ duel: structuredClone(d), texte: lignes.length ? texte() : null, pause: reflexion() });
        const h = d.historique.length;
        chauffer(d, "bot", choixKevina(d, "bot", { erreur: config.erreur_kevina }));
        lignes.push(recit(d, "joueur", BOT));
        if (d.historique.length > h) {
          etapes.push({ duel: etapeFinManche(d, h + 1), texte: texte(), pause: DELAI_FIN_MANCHE_MS });
          lignes = [];
        }
      }
      // Chrono du joueur relancé après l'affichage des étapes
      const decalageMs = etapes.reduce((t, e) => t + e.pause, 0);
      return { texte: lignes.length ? texte() : null, vientDeFinir: d.termine, etapes, coup: true, decalageMs };
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  for (const etape of resultat.etapes ?? []) {
    await Promise.all([patchOriginal(webhookUrl, buildVue(etape.duel, { texte: etape.texte })), majSalonSolo(etape.duel, pseudo, config)]);
    await pause(etape.pause);
  }
  if ((resultat.vientDeFinir || resultat.delai) && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  const nouvelle = resultat.etapes?.some((e) => e.duel.etapeManche) && !resultat.texte ? "Nouvelle manche !" : null;
  await Promise.all([
    patchOriginal(webhookUrl, vueSolo(duel, config, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte ?? nouvelle })),
    ...(resultat.erreur || duel.termine ? [] : [majSalonSolo(duel, pseudo, config)]),
  ]);
  if (resultat.coup) await surveillerDelaiSolo(webhookUrl, discordId, duel, config, { channelId, pseudo });
}

// Échéance de l'action du joueur contre Kévina (secondes)
const echeanceSolo = (d, config) => Math.floor(((d.tourDepuis ?? Date.now()) + config.delai_tour_minutes * 60_000) / 1000);

// Vue du joueur contre Kévina : limite de l'action, raison de la fin.
const vueSolo = (d, config, opts = {}) => buildVue(d, { ...opts, echeance: echeanceSolo(d, config), raison: d.delai ? "delai" : null });

// Fin au délai sans attendre un clic : l'invocation attend l'échéance puis
// clôt la partie si le joueur n'a pas joué (comme surveillerDelai() en 1v1).
async function surveillerDelaiSolo(webhookUrl, discordId, d, config, { channelId, pseudo }) {
  if (d.termine) return;
  await pause(Math.max(0, echeanceSolo(d, config) * 1000 - Date.now()) + 1000);
  const { duel, resultat } = await agirDuel(discordId, () => ({}), { nom: pseudo });
  if (duel && resultat.delai && !(await publierFinSolo(webhookUrl, channelId, duel, pseudo))) await patchOriginal(webhookUrl, vueSolo(duel, config));
}

const AUCUNE_PARTIE_SOLO = {
  embeds: [{ description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/potato` !", color: POTATO_COLOR }],
  components: [],
};

// Fin contre Kévina : récapitulatif dans un NOUVEAU message, message public
// supprimé (repli : édité en récapitulatif), vue éphémère supprimée. Faux
// si le POST ou la suppression de la vue a échoué.
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
      Object.assign(d, { termine: true, gagnant: "bot", abandon: "joueur", evenement: null });
      return {};
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  if (!resultat.erreur && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  await patchOriginal(webhookUrl, vueSolo(duel, await loadDuelConfig()));
}

// ── 1v1 ──────────────────────────────────────────────────────────────

const echeanceDe = (partie, config) => Math.floor((partie.dernierCoupAt + config.delai_tour_minutes * 60_000) / 1000);

function memoriserWebhook(partie, discordId, webhookUrl) {
  if (webhookUrl) partie.webhooks[discordId] = { url: webhookUrl, at: Date.now() };
}

function webhookValide(partie, discordId) {
  const w = partie.webhooks?.[discordId];
  return w && Date.now() - w.at < WEBHOOK_VALIDITE_MS ? w.url : null;
}

// Vue éphémère d'un joueur du 1v1 (lobby, partie, fin). Sans `texte`, la
// dernière action de la manche est racontée. `etat` : étape de fin de
// manche à afficher.
function vuePvp(partie, config, discordId, texte = null, { confirmerAbandon = false, etat = null } = {}) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [...(texte ? [texte, ""] : []), "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi."].join("\n"),
          color: POTATO_COLOR,
        },
      ],
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  const A = nomsAdv(partie, moi);
  const d = etat ?? partie.duel;
  return buildVue(d, {
    // Pas de récit d'une manche précédente
    texte: texte ?? (d.dernier?.manche === d.numero && !d.etapeManche ? `${recit(d, moi, A)}.` : null),
    moi,
    A,
    pvp: true,
    echeance: echeanceDe(partie, config),
    raison: partie.raisonFin,
    confirmerAbandon,
  });
}

const BOUTON_JOUER = { type: 2, style: 3, label: "Jouer", custom_id: "potatoduel_ouvrir" };

// [🎮 Reprendre ma partie] pendant la partie : même action que Jouer (un
// joueur assis reçoit sa vue)
const BOUTON_MA_VUE = { type: 2, style: 2, label: "Reprendre ma partie", emoji: { name: "🎮" }, custom_id: "potatoduel_ouvrir" };

// Message public : lobby, puis barre des chauffes en direct.
function messagePublic(partie, config, etat = null) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: POTATO_COLOR,
        },
      ],
      components: [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }],
    };
  }
  const d = etat ?? partie.duel;
  const nomDe = (siege) => partie.noms[partie.sieges[siege]] ?? "?";
  const derniere = ligneDerniereManche(d, nomDe);
  const recitPub = !derniere && d.dernier?.manche === d.numero ? recitPublic(d, nomDe) : null;
  return {
    embeds: [
      {
        title: `${TITRE} · ${nomDe("joueur")} contre ${nomDe("bot")}`,
        description: [
          `Manche **${d.numero}** · Score : **${nomDe("joueur")} ${d.manches.joueur}** – ${d.manches.bot} ${nomDe("bot")}`,
          ...(derniere ? ["", derniere] : []),
          ...(recitPub ? ["", recitPub] : []),
          ...(d.etapeManche ? [] : ["", `Au tour de **${nomDe(d.actif)}**, limite <t:${echeanceDe(partie, config)}:R>`]),
        ]
          .join("\n")
          .slice(0, 4096),
        image: { url: urlPublic(d, nomDe) },
        color: POTATO_COLOR,
      },
    ],
    components: [{ type: 1, components: [BOUTON_MA_VUE, BOUTON_REGLES] }],
  };
}

// Fin du 1v1 : récapitulatif dans un NOUVEAU message, puis suppression du
// message de la partie.
function messageFinal(partie) {
  const d = partie.duel;
  const nomDe = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const finJeu = partie.raisonFin === "jeu";
  const resultat =
    partie.raisonFin === "abandon"
      ? `🏳️ ${nomDe(adversaire(g))} abandonne : ${nomDe(g)} remporte le duel.`
      : partie.raisonFin === "delai"
        ? `🏆 ${nomDe(g)} remporte le duel : ${nomDe(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nomDe(g)} bat ${nomDe(adversaire(g))} : ${d.manches[g]} manches à ${d.manches[adversaire(g)]} !`;
  const derniere = finJeu ? ligneManche(d.historique.at(-1), d.historique.length, nomDe) : null;
  const s = partie.series;
  const series = s
    ? lignesSeries({
        gagnant: { nom: nomDe(g), serie: s[g].serie },
        perdant: { nom: nomDe(adversaire(g)), avant: s[adversaire(g)].avant },
        record: s.record,
        libelleSerie: (n) => `Série ${deNom(n)}`,
        libelleRecord: "Record 1v1",
      })
    : [];
  return {
    embeds: [
      {
        title: `${TITRE} · ${nomDe(g)} contre ${nomDe(adversaire(g))}`,
        description: [resultat, ...(derniere ? ["", derniere] : []), ...(series.length ? ["", ...series] : [])].join("\n").slice(0, 4096),
        ...(finJeu ? { image: { url: urlPublic(d, nomDe, { deco: true }) } } : {}),
        color: POTATO_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après une action : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées). `etape` : explosion, montrée d'abord.
async function diffuserPvp(partie, config, discordId, webhookUrl, texte, etape = null) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  if (etape) {
    await Promise.all([
      patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte, { etat: etape })),
      ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, `${recit(etape, siegeDe(partie, id), nomsAdv(partie, siegeDe(partie, id)))}.`, { etat: etape }))),
      messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config, etape)),
    ]);
    await pause(DELAI_FIN_MANCHE_MS);
  }
  if (partie.statut === "fini") {
    const ok = await messageSalon("POST", partie.channelId, null, messageFinal(partie));
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else await messageSalon("PATCH", partie.channelId, partie.messageId, messageFinal(partie));
    const vues = [[discordId, webhookUrl, texte], ...autres.map((id) => [id, webhookValide(partie, id), null])];
    await Promise.all(
      vues.map(async ([id, url, t]) => {
        if (ok && (await supprimerOriginal(url))) return;
        await patchOriginal(url, vuePvp(partie, config, id, t));
      }),
    );
    return;
  }
  // Après une explosion, la nouvelle manche commence sans récit
  const suite = etape ? "Nouvelle manche !" : null;
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, etape ? suite : texte)),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, suite))),
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

// Fin au délai sans attendre un clic : l'invocation attend l'échéance puis
// clôt la partie si personne n'a joué entre-temps.
async function surveillerDelai(partie, config, discordId, webhookUrl) {
  if (partie.statut !== "enCours") return;
  await pause(Math.max(0, partie.dernierCoupAt + config.delai_tour_minutes * 60_000 - Date.now()) + 1000);
  const r = await agirPvp(() => ({}));
  if (r.partie && r.resultat.vientDeFinir) await diffuserPvp(r.partie, r.config, discordId, webhookUrl, null);
}

const AUCUNE_PARTIE_PVP = {
  embeds: [{ description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/potato` (1v1) !", color: POTATO_COLOR }],
  components: [],
};

// `/potato adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handlePotatoPvpCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({ channelId: body.channel_id, lanceur: discordId, nom: username });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, { content: `Un duel 1v1 est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.` });
      return;
    }
    if (r.ancienne?.messageId) await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messagePublic(r.partie, config));
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    const vue = vuePvp(r.partie, config, discordId, "🥔 Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Potato] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa vue
// (nouvel éphémère, mémorisé ; l'ancienne vue est supprimée).
export async function handlePotatoOuvrir(webhookUrl, body) {
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/potato\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      await supprimerOriginal(ancienneVue);
      const texte = resultat.rejoint ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.` : null;
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
    console.error("[Potato] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, k, vue) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const avant = p.duel.historique.length;
    const r = agir(p.duel, moi, k, vue);
    if (r.erreur) return r;
    // Explosion : étape montrée avant la manche suivante (ou le récapitulatif)
    const etape = p.duel.historique.length > avant ? etapeFinManche(p.duel, avant + 1) : null;
    return { texte: `${recit(p.duel, moi, nomsAdv(p, moi))}.`, coup: true, etape };
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
    await diffuserPvp(partie, config, discordId, webhookUrl, texte, resultat.etape);
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
    Object.assign(p.duel, { termine: true, gagnant: adversaire(moi), abandon: moi, evenement: null });
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
  if (resultat.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, null);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, avertissement("termine")));
}

// [🏳️] (`etape` "demande") : question de confirmation à la place des
// boutons ; "non" : retour à la vue ; "ok" : abandon.
export async function handlePotatoAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (etape === "ok") {
      if (pvp) await abandonPvp(webhookUrl, discordId);
      else await abandonSolo(webhookUrl, discordId, { channelId, pseudo });
      return;
    }
    const confirmerAbandon = etape === "demande";
    if (!pvp) {
      const duel = await readDuel(discordId);
      await patchOriginal(webhookUrl, duel ? vueSolo(duel, await loadDuelConfig(), { confirmerAbandon }) : AUCUNE_PARTIE_SOLO);
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
    console.error("[Potato] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

// [🔥 +X °C] : chauffe n° `k` (0, 1, 2) ; `vue` : numéro de la vue cliquée.
export async function handlePotatoChauffer(webhookUrl, discordId, k, vue, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (![0, 1, 2].includes(k)) return;
    if (pvp) await executerPvp(webhookUrl, discordId, k, vue);
    else await executerSolo(webhookUrl, discordId, k, vue, { channelId, pseudo });
  } catch (err) {
    console.error("[Potato] Échec chauffe:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handlePotatoRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Potato] Échec Règles:", err.message);
  }
}
