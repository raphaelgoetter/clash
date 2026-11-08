// ============================================================
// friseDuel.js (handler) — Frise (`/frise`), deux modes :
// - contre Kévina, le bot (`/frise adversaire:bot`) : frise publique dans le
//   salon (suivie par tous) et vue éphémère du joueur (frise, mains, menus
//   de jeu), éditées en place à chaque coup ; Kévina joue aussitôt après le
//   joueur ; résultat publié dans un nouveau message en fin de partie ;
// - 1v1 (`/frise adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; frise visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque action du joueur). Une
//   seule partie à la fois, comme Tourneboule.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : friseduel_carte:<vue>[:pvp] (menu : carte de sa main à
// placer), friseduel_placer:<vue>:<k>[:pvp] (menu : créneau, <k> = numéro du
// menu quand la frise dépasse 25 créneaux ; <vue> = d.vue à l'affichage, un
// choix sur une vue dépassée est refusé), friseduel_ouvrir (bouton Jouer du
// message public), friseduel_regles, friseduel_abandon[:pvp] (🏳️, demande
// confirmation), friseduel_abandon_ok[:pvp] / friseduel_abandon_non[:pvp].
//
// Service : jeux/services/friseDuel.js (Redis),
// règles : jeux/services/friseRules.js.
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
} from "../../services/friseDuel.js";
import { adversaire, choisir, choixKevina, libelleCreneau, nbCreneaux, placer } from "../../services/friseRules.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

// Brun parchemin
const FRISE_COLOR = 0xb9770e;
const TITRE = "🗓️ Frise";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;
// Contre Kévina : pause après le coup du joueur (résultat visible), puis
// réflexion de Kévina (durée tirée au sort)
const DELAI_RESULTAT_MS = 1200;
const REFLEXION_MS = { min: 2000, max: 4000 };
// Options par menu déroulant (limite Discord)
const OPTIONS_MAX = 25;
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

// Messages en Components V2 (conteneur à liseré coloré, comme un embed),
// comme Tourneboule : titre en `###`, description, puis composants dans le
// conteneur. `content` seul : texte nu.
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
      accent_color: embed.color ?? FRISE_COLOR,
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
    if (!res.ok) console.error(`[Frise] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Frise] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Frise] Échec DELETE:", err.message);
    return false;
  }
}

// Nouveau message éphémère de l'interaction (followup). Renvoie son URL
// (à mémoriser pour l'éditer), null en cas d'échec.
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
      console.error(`[Frise] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Frise] Échec followup:", err.message);
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
      // Jamais de ping dans ce jeu
      ...(payload
        ? { body: JSON.stringify({ allowed_mentions: { parse: [] }, ...versV2(payload) }) }
        : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[Frise] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Frise] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

const cartes = (n) => plural(n, "carte");

// Année lisible : « 52 av. J.-C. » pour une année négative
export const formatAnnee = (a) => (a < 0 ? `${-a} av. J.-C.` : String(a));

const BOT = { Sujet: "Kévina", emoji: "🤖" };

function nomsJoueur(pseudo) {
  return { Sujet: pseudo, emoji: "⚔️" };
}

function nomsAdv(partie, moi) {
  return nomsJoueur(partie.noms[partie.sieges[adversaire(moi)]] ?? "?");
}

// Frise en texte : une ligne par carte, année en gras ; la carte du
// dernier coup est marquée ✅ (bien placée) ou ❌ (rangée après une erreur).
function lignesFrise(d) {
  const x = d.dernier;
  return d.frise.map((c) => {
    const marque = x && c.libelle === x.carte.libelle ? (x.juste ? " ✅" : " ❌") : "";
    return `**${formatAnnee(c.annee)}** · ${c.libelle}${marque}`;
  });
}

// Main en texte (dates cachées) ; `choix` : index de la carte choisie (▶️).
function lignesMain(main, choix = null) {
  if (!main.length) return ["*(vide)*"];
  return main.map((c, k) => `${k === choix ? "▶️" : "•"} ${c.libelle}`);
}

// Récit du dernier coup vu par `moi`, sans point final.
function recit(d, moi, A) {
  const x = d.dernier;
  if (!x) return null;
  const toi = x.id === moi;
  const qui = toi ? "Tu places" : `${A.Sujet} place`;
  const annee = formatAnnee(x.carte.annee);
  if (x.juste) return `${qui} « ${x.carte.libelle} » : ✅ ${annee}`;
  const penalite = x.pioche ? (toi ? ", tu pioches une carte" : ", et pioche une carte") : "";
  return `${qui} « ${x.carte.libelle} » : ❌ c'était ${annee}${penalite}`;
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  carte: "Cette carte n'est plus dans ta main.",
  creneau: "Créneau invalide.",
  perime: "La frise a changé depuis : rejoue sur celle-ci.",
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
  custom_id: "friseduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `friseduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `friseduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `friseduel_abandon_non${sfx}` },
      ],
    },
  ];
}

const tronquer = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Menus de jeu : carte à placer (si la main en a plusieurs), puis créneau
// (découpé en plusieurs menus au-delà de 25 créneaux). Chaque créneau
// rappelle les cartes qui l'encadrent.
function menusJeu(d, moi, sfx) {
  const main = d.mains[moi];
  const choix = Math.min(d.choix[moi] ?? 0, main.length - 1);
  const rangees = [];
  if (main.length > 1) {
    rangees.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `friseduel_carte:${d.vue}${sfx}`,
          placeholder: "Carte à placer",
          options: main.map((c, k) => ({ label: tronquer(c.libelle, 100), value: String(k), default: k === choix })),
        },
      ],
    });
  }
  const f = d.frise;
  const n = nbCreneaux(d);
  for (let debut = 0, k = 0; debut < n; debut += OPTIONS_MAX, k++) {
    const options = [];
    for (let i = debut; i < Math.min(n, debut + OPTIONS_MAX); i++) {
      const avant = i > 0 ? f[i - 1].libelle : null;
      const apres = i < f.length ? f[i].libelle : null;
      const description = [avant && `après « ${avant} »`, apres && `avant « ${apres} »`].filter(Boolean).join(", ");
      options.push({ label: libelleCreneau(d, i, formatAnnee), value: String(i), description: tronquer(description, 100) });
    }
    const fin = Math.min(n, debut + OPTIONS_MAX);
    rangees.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `friseduel_placer:${d.vue}:${k}${sfx}`,
          placeholder: n > OPTIONS_MAX ? `Où placer « ${tronquer(main[choix].libelle, 40)} » ? (${debut + 1} à ${fin})` : `Où placer « ${tronquer(main[choix].libelle, 70)} » ?`,
          options,
        },
      ],
    });
  }
  return rangees;
}

function titreFin(d, moi, A, raison) {
  if (d.gagnant === "nul") return "🤝 Match nul";
  if (d.abandon) return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} abandonne.` : "🏳️ Tu abandonnes.";
  if (raison === "delai") {
    return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.` : "💀 Défaite… tu n'as pas joué à temps.";
  }
  return d.gagnant === moi ? "🏆 Victoire !" : "💀 Défaite…";
}

// Vue de fin : une phrase, la frise finale est dans le message public.
function vueFin(d, { moi, A, raison, texte = null }) {
  const issue =
    d.gagnant === "nul"
      ? "C'est un match nul."
      : d.gagnant === moi
        ? "C'est une victoire pour toi !"
        : "C'est une défaite pour toi…";
  return {
    embeds: [
      {
        title: `${TITRE} · ${titreFin(d, moi, A, raison)}`,
        description: [texte, `La partie est terminée. ${issue}`].filter(Boolean).join("\n"),
        color: FRISE_COLOR,
      },
    ],
    components: [],
  };
}

// Vue d'un joueur : récit, frise, sa main (carte choisie ▶️), main
// adverse, puis menus de jeu à son tour. `ctx` : { moi, A, pvp, echeance,
// raison, confirmerAbandon, attente (Kévina réfléchit : pas de menus) }.
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false, attente = false } = {},
) {
  if (d.termine) return vueFin(d, { moi, A, raison, texte });
  const monTour = d.actif === moi && !attente;
  const sfx = pvp ? ":pvp" : "";
  const autre = adversaire(moi);
  const lignes = confirmerAbandon
    ? ["🏳️ **Abandonner la partie ?** Ce sera une défaite."]
    : [
        ...(texte ? [texte, ""] : []),
        "**Frise**",
        ...lignesFrise(d),
        "",
        `**Ta main** (${cartes(d.mains[moi].length)})`,
        ...lignesMain(d.mains[moi], monTour ? Math.min(d.choix[moi] ?? 0, d.mains[moi].length - 1) : null),
        "",
        `**Main de ${A.Sujet}** (${cartes(d.mains[autre].length)})`,
        ...lignesMain(d.mains[autre]),
        "",
        monTour
          ? `👉 À toi : choisis une carte puis son créneau${d.dernierTour ? " (dernier tour !)" : ""}${pvp && echeance ? `, limite <t:${echeance}:R>` : ""}.`
          : `⏳ ${attente ? `${A.Sujet} réfléchit…` : `Au tour de ${A.Sujet}`}${pvp && echeance && !attente ? `, limite <t:${echeance}:R>` : ""}.`,
      ];
  const titre = `${TITRE} · Toi ${d.mains[moi].length} – ${d.mains[autre].length} ${A.Sujet}${pvp && monTour ? " · À toi !" : ""}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: FRISE_COLOR };
  if (confirmerAbandon) return { embeds: [embed], components: boutonsConfirmation(sfx) };
  const bas = { type: 1, components: [BOUTON_REGLES, ...(monTour || pvp ? [boutonAbandon(sfx)] : [])] };
  return { embeds: [embed], components: [...(monTour ? menusJeu(d, moi, sfx) : []), bas] };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Frise",
    description: [
      "Une frise commune démarre avec un événement daté. Chaque joueur a une main de " +
        `${cartes(config.taille_main)} événements, visibles de tous mais **sans leur année**.`,
      "",
      "**🗓️ À ton tour**, choisis une carte de ta main et le créneau de la frise où elle se place (avant, entre ou après les cartes déjà posées).",
      "**✅ Juste** : la carte reste sur la frise, avec son année.",
      "**❌ Faux** : la carte est rangée à sa vraie place et tu pioches une nouvelle carte.",
      "**🏆 Fin** : le premier à vider sa main gagne. Si c'est celui qui a commencé, l'autre joue encore un tour : s'il vide aussi sa main, match nul.",
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: FRISE_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionPlacer(d, moi, creneau, vue) {
  if (!d.termine && vue !== d.vue) return { erreur: "perime" };
  const r = placer(d, moi, creneau);
  return r.erreur ? { erreur: r.erreur } : {};
}

function actionChoisir(d, moi, index, vue) {
  if (!d.termine && vue !== d.vue) return { erreur: "perime" };
  if (!d.termine && d.actif !== moi) return { erreur: "pasTonTour" };
  return choisir(d, moi, index);
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleFriseRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Frise publique et mains, au tour de qui (messages publics en cours).
function corpsPublic(d, nom, tour) {
  return [
    tour,
    "",
    ...lignesFrise(d),
    "",
    `**${nom("joueur")}** (${cartes(d.mains.joueur.length)}) : ${d.mains.joueur.map((c) => c.libelle).join(" · ") || "—"}`,
    `**${nom("bot")}** (${cartes(d.mains.bot.length)}) : ${d.mains.bot.map((c) => c.libelle).join(" · ") || "—"}`,
  ];
}

// Message public d'une partie contre Kévina, en cours. Expiration rappelée,
// sinon le message d'une partie abandonnée resterait figé.
function messageSolo(d, pseudo, { attente = false } = {}) {
  const expiration = Math.floor(Date.now() / 1000) + INACTIVITE_SECONDES;
  const nom = (s) => (s === "bot" ? "🤖 Kévina" : pseudo);
  const tour = attente || d.actif === "bot" ? "⏳ Kévina réfléchit…" : `Au tour de **${pseudo}**.`;
  const derniere = d.dernier ? [`${recit(d, "joueur", BOT).replace(/^Tu places/, `${pseudo} place`).replace(", tu pioches", ", et pioche")}.`, ""] : [];
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [...derniere, ...corpsPublic(d, nom, tour), "", `⏰ Sans action, partie abandonnée <t:${expiration}:R>.`]
          .join("\n")
          .slice(0, 4096),
        color: FRISE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function majSalonSolo(d, pseudo, opts) {
  if (d.salon) await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, messageSolo(d, pseudo ?? "?", opts));
}

// Lance une nouvelle partie (remplace une éventuelle partie en cours) :
// message public dans le salon, puis vue éphémère du joueur EN DESSOUS.
export async function handleFriseCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const { duel, ancien } = await nouveauDuel(discordId);
    if (ancien?.salon && !ancien.termine) await messageSalon("DELETE", ancien.salon.channelId, ancien.salon.messageId);
    const message = await messageSalon("POST", body.channel_id, null, messageSolo(duel, username));
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
    console.error("[Frise] Échec lancement:", err.message);
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

// Fin d'une partie contre Kévina : message public, résultat, frise finale
// et série. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
  const s = d.series;
  const series = s
    ? lignesSeries({
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
      ? `🤝 Match nul entre ${pseudo} et Kévina : mains vidées au même tour.`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} bat Kévina (il lui restait ${cartes(d.mains.bot.length)}) !`
        : `🤖 Kévina bat ${pseudo} (il lui restait ${cartes(d.mains.joueur.length)}).`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, "", ...lignesFrise(d), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: FRISE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

const AUCUNE_PARTIE_SOLO = {
  embeds: [
    {
      description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/frise` !",
      color: FRISE_COLOR,
    },
  ],
  components: boutonsFin(),
};

async function executerSolo(webhookUrl, discordId, creneau, vue, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(
    discordId,
    (d) => {
      const r = actionPlacer(d, "joueur", creneau, vue);
      if (r.erreur) return r;
      const lignes = [recit(d, "joueur", BOT)];
      // Étapes avant la vue finale : résultat du coup du joueur, puis
      // réflexion de Kévina
      const etapes = [];
      if (!d.termine) {
        etapes.push({ duel: structuredClone(d), texte: `${lignes[0]}.`, attente: true });
        const k = choixKevina(d, "bot", { erreur: config.erreur_kevina, echelle: config.echelle_kevina });
        choisir(d, "bot", k.index);
        placer(d, "bot", k.creneau);
        lignes.push(recit(d, "joueur", BOT));
      }
      return { texte: `${lignes.join(".\n")}.`, vientDeFinir: d.termine, etapes };
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  for (const [n, etape] of (resultat.etapes ?? []).entries()) {
    await Promise.all([
      patchOriginal(webhookUrl, buildVue(etape.duel, { texte: etape.texte, attente: etape.attente })),
      majSalonSolo(etape.duel, pseudo, { attente: etape.attente }),
    ]);
    await pause(n === 0 ? DELAI_RESULTAT_MS + REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min) : DELAI_RESULTAT_MS);
  }
  if (resultat.vientDeFinir && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  await Promise.all([
    patchOriginal(webhookUrl, buildVue(duel, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte })),
    ...(resultat.erreur || duel.termine ? [] : [majSalonSolo(duel, pseudo)]),
  ]);
}

async function choisirSolo(webhookUrl, discordId, index, vue) {
  const { duel, resultat } = await agirDuel(discordId, (d) => actionChoisir(d, "joueur", index, vue));
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  await patchOriginal(webhookUrl, buildVue(duel, { texte: resultat.erreur ? avertissement(resultat.erreur) : null }));
}

// Fin contre Kévina : récapitulatif dans un NOUVEAU message, message public
// supprimé (repli : édité), vue éphémère supprimée. Faux si le POST ou la
// suppression de la vue a échoué (l'appelant affiche alors la vue de fin).
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
          color: FRISE_COLOR,
        },
      ],
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  const A = nomsAdv(partie, moi);
  const d = partie.duel;
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
  custom_id: "friseduel_ouvrir",
};

const BOUTON_MA_VUE = { type: 2, style: 2, label: "Reprendre ma partie", emoji: { name: "🎮" }, custom_id: "friseduel_ouvrir" };

function messagePublic(partie, config) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: FRISE_COLOR,
        },
      ],
      components: [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }],
    };
  }
  const d = partie.duel;
  const nom = (siege) => partie.noms[partie.sieges[siege]] ?? "?";
  const x = d.dernier;
  const derniere = x ? [`${recit(d, null, { Sujet: nom(x.id) })}.`, ""] : [];
  return {
    embeds: [
      {
        title: `${TITRE} · ${nom("joueur")} contre ${nom("bot")}`,
        description: [
          ...derniere,
          ...corpsPublic(d, nom, `Au tour de **${nom(d.actif)}**${d.dernierTour ? " (dernier tour)" : ""}, limite <t:${echeanceDe(partie, config)}:R>`),
        ]
          .join("\n")
          .slice(0, 4096),
        color: FRISE_COLOR,
      },
    ],
    components: [{ type: 1, components: [BOUTON_MA_VUE, BOUTON_REGLES] }],
  };
}

const titreGagnant = (g, nom) =>
  g === "nul" ? `${nom("joueur")} contre ${nom("bot")}` : `${nom(g)} contre ${nom(adversaire(g))}`;

function messageFinal(partie) {
  const d = partie.duel;
  const nom = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const resultat =
    partie.raisonFin === "abandon"
      ? `🏳️ ${nom(adversaire(g))} abandonne : ${nom(g)} remporte le duel.`
      : g === "nul"
        ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")} : mains vidées au même tour.`
        : partie.raisonFin === "delai"
          ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
          : `🏆 ${nom(g)} bat ${nom(adversaire(g))} (il lui restait ${cartes(d.mains[adversaire(g)].length)}) !`;
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
        description: [resultat, "", ...lignesFrise(d), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: FRISE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul.
async function diffuserPvp(partie, config, discordId, webhookUrl, texte) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
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
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte)),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id))),
  ]);
  await messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config));
  await rattraperPvp(partie, config);
}

// PATCH concurrents dans n'importe quel ordre : relit la partie après la
// diffusion et rééditer vues et message public si elle a changé.
const empreinte = ({ webhooks, ...etat }) => JSON.stringify(etat);

async function rattraperPvp(partie, config) {
  const fraiche = await readPvp();
  if (fraiche?.statut !== "enCours" || empreinte(fraiche) === empreinte(partie)) return;
  await Promise.all([
    ...Object.values(fraiche.sieges).map((id) => patchOriginal(webhookValide(fraiche, id), vuePvp(fraiche, config, id))),
    messageSalon("PATCH", fraiche.channelId, fraiche.messageId, messagePublic(fraiche, config)),
  ]);
}

// Fin au délai sans attendre un clic (voir Tourneboule).
async function surveillerDelai(partie, config, discordId, webhookUrl) {
  if (partie.statut !== "enCours") return;
  await pause(Math.max(0, partie.dernierCoupAt + config.delai_tour_minutes * 60_000 - Date.now()) + 1000);
  const r = await agirPvp(() => ({}));
  if (r.partie && r.resultat.vientDeFinir) await diffuserPvp(r.partie, r.config, discordId, webhookUrl, null);
}

const AUCUNE_PARTIE_PVP = {
  embeds: [
    {
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/frise` (1v1) !",
      color: FRISE_COLOR,
    },
  ],
  components: boutonsFin(),
};

export async function handleFrisePvpCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({ channelId: body.channel_id, lanceur: discordId, nom: username });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, {
        content: `Un duel 1v1 est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.`,
      });
      return;
    }
    if (r.ancienne?.messageId) await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messagePublic(r.partie, config));
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    const vue = vuePvp(r.partie, config, discordId, "🗓️ Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Frise] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa vue.
export async function handleFriseOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    let ancienneVue = null;
    const { partie, config, resultat } = await agirPvp((p, cfg) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, discordId, username, cfg);
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/frise\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      await supprimerOriginal(ancienneVue);
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.`
        : null;
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      if (resultat.rejoint) await surveillerDelai(partie, config, discordId, webhookUrl);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
    await supprimerOriginal(ancienneVue);
    await rattraperPvp(partie, config);
  } catch (err) {
    console.error("[Frise] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, creneau, vue) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionPlacer(p.duel, moi, creneau, vue);
    return r.erreur ? r : { texte: `${recit(p.duel, moi, nomsAdv(p, moi))}.`, coup: true };
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

async function choisirPvp(webhookUrl, discordId, index, vue) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    return actionChoisir(p.duel, moi, index, vue);
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
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, resultat.erreur ? avertissement(resultat.erreur) : null));
}

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
  if (resultat.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, null);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, avertissement("termine")));
}

// [🏳️] (`etape` "demande") : question de confirmation à la place des
// menus ; "non" : retour à la vue ; "ok" : abandon.
export async function handleFriseAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
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
    console.error("[Frise] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

// Menu « Où placer ? » : `creneau` choisi, `vue` affichée par la vue.
export async function handleFrisePlacer(webhookUrl, discordId, creneau, vue, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (!Number.isInteger(creneau) || creneau < 0) return;
    if (pvp) await executerPvp(webhookUrl, discordId, creneau, vue);
    else await executerSolo(webhookUrl, discordId, creneau, vue, { channelId, pseudo });
  } catch (err) {
    console.error("[Frise] Échec placer:", err.message);
  }
}

// Menu « Carte à placer » : `index` dans la main.
export async function handleFriseChoisir(webhookUrl, discordId, index, vue, { pvp = false } = {}) {
  try {
    if (!Number.isInteger(index) || index < 0) return;
    if (pvp) await choisirPvp(webhookUrl, discordId, index, vue);
    else await choisirSolo(webhookUrl, discordId, index, vue);
  } catch (err) {
    console.error("[Frise] Échec choix de carte:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleFriseRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Frise] Échec Règles:", err.message);
  }
}
