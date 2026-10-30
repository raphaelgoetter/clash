// ============================================================
// sixDuel.js (handler) — Six (`/six`), deux modes :
// - contre Kévina, le bot (`/six adversaire:bot`) : plateau public
//   dans le salon (suivi par tous) et vue éphémère du joueur (plateau et
//   boutons de coup), édités en place à chaque coup ; Kévina joue aussitôt après
//   le joueur ; résultat publié dans un nouveau message en fin de partie ;
// - 1v1 (`/six adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; plateau visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque coup du joueur). Une seule
//   partie à la fois, comme Quatre à la suite.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : sixduel_jouer:<colonne>:<coup> (contre Kévina),
// sixduel_jouer:<colonne>:<coup>:pvp (1v1 ; <colonne> 0 à 3, <coup> =
// d.coups à l'affichage,
// un clic sur une vue dépassée est refusé), sixduel_ouvrir (bouton Jouer du
// message public), sixduel_regles, sixduel_abandon[:pvp] (🏳️, demande
// confirmation), sixduel_abandon_ok[:pvp] / sixduel_abandon_non[:pvp].
//
// Service : jeux/services/sixDuel.js (Redis),
// règles : jeux/services/sixRules.js, cartes : jeux/services/puntoCartes.js.
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
} from "../../services/sixDuel.js";
import {
  LIMITE,
  NB_COLONNES,
  PENALITE_MAUDITE,
  SEUIL,
  adversaire,
  choixKevina,
  coupsPossibles,
  jouer,
  prochaine,
} from "../../services/sixRules.js";
import { formatCarte } from "../../services/puntoCartes.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

// Bleu canard
const SIX_COLOR = 0x16a085;
const TITRE = "6️⃣ Six";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Cartes de Punto, communes aux deux joueurs ; indice = couleur de la
// carte (0 à 3) dans le moteur, le rouge est la couleur maudite
// (COULEUR_MAUDITE)
const COULEURS = ["bleu", "vert", "rouge", "orange"];
const NOMS_COLONNES = ["A", "B", "C", "D"];
// En-têtes des colonnes, à la largeur des cartes
const ENTETES = ["🇦", "🇧", "🇨", "🇩"];
// Emplacement vide de la 6e carte (celle qui fait ramasser)
const SIXIEME = "💀";
// Étape d'explosion (6e carte, comme La Grille) : les 5 cartes ramassées
// remplacées par 💥 sous la carte posée, affichées un court instant avant
// le plateau suivant
const EXPLOSION = "💥";
const DELAI_EXPLOSION_MS = 900;
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
      accent_color: embed.color ?? SIX_COLOR,
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
    if (!res.ok) console.error(`[Six] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Six] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Six] Échec DELETE:", err.message);
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
      console.error(`[Six] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Six] Échec followup:", err.message);
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
      console.warn(`[Six] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Six] Erreur réseau (${method} message public):`, err.message);
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

// Carte en emoji (couleurs de Punto)
const carteTexte = (carte) => formatCarte(COULEURS[carte.k], carte.v);
const pts = (n) => plural(n, "point");

// Plateau : les 4 colonnes à la verticale sous leurs en-têtes, la plus
// ancienne carte en haut ; emplacements libres gris, 6e emplacement 💀
// (la carte qui y tomberait fait ramasser). Une rangée par ligne, en titre
// H1 dans la vue du joueur (plus grande taille d'emoji possible, comme La
// Grille), H3 dans les messages publics (`titre`).
function plateau(d, titre = "#") {
  const rangees = [`${titre} ${ENTETES.join(" ")}`];
  for (let r = 0; r < LIMITE; r++) {
    const cases = d.colonnes.map((col) =>
      col[r] === EXPLOSION ? EXPLOSION : col[r] ? carteTexte(col[r]) : r === LIMITE - 1 ? SIXIEME : formatCarte("vide"),
    );
    rangees.push(`${titre} ${cases.join(" ")}`);
  }
  return rangees;
}

// Étape d'explosion après une 6e carte (`d.dernier`), null sinon : copie
// du duel dont la colonne ramassée montre 💥 à la place des 5 cartes, la
// carte posée dessous ; ni carte à jouer ni fin (le récapitulatif suit).
function etatExplosion(d) {
  const x = d.dernier;
  if (x?.type !== "sixieme") return null;
  const etat = structuredClone(d);
  etat.colonnes[x.colonne] = [...x.ramassees.map(() => EXPLOSION), x.carte];
  return Object.assign(etat, { explosion: true, termine: false, carte: null });
}

// « 💥 Kévina ramasse la colonne B (−11) ! » (étape d'explosion, messages publics)
const ligneExplosion = (d, nom) =>
  `💥 ${nom(d.dernier.id)} ramasse la colonne ${NOMS_COLONNES[d.dernier.colonne]} (−${pts(d.dernier.penalite)}) !`;

// Plateau neutre (message public) : cartes plus petites que dans la vue du
// joueur, puis le score de la partie en cours (premier joueur d'abord).
function plateauPublic(d, nomJoueur, nomBot) {
  return [...plateau(d, "###"), `Score en cours : **${nomJoueur} ${d.points.joueur}** · ${nomBot} ${d.points.bot}`];
}

// Récit du dernier coup vu par `moi`, sans point final : « Tu joues 🟦7
// en A », « Kévina joue 🟥2 en B (💥 −5) » (6e carte, colonne ramassée).
function recit(d, moi, A) {
  const x = d.dernier;
  if (!x) return null;
  const toi = x.id === moi;
  return `${toi ? "Tu joues" : `${A.Sujet} joue`} ${carteTexte(x.carte)} en ${NOMS_COLONNES[x.colonne]}${x.type === "sixieme" ? ` (💥 −${x.penalite})` : ""}`;
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  interdite: "Ta carte ne peut pas aller dans cette colonne.",
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
  custom_id: "sixduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

// 🏳️ : abandon, après confirmation (défaite, la série est perdue)
const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `sixduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `sixduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `sixduel_abandon_non${sfx}` },
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
      : `${d.fin === "seuil" ? `${SEUIL} points atteints` : "La pioche est vide"} : tu perds ${pts(d.points[moi])}, ${A.Sujet} ${pts(d.points[adversaire(moi)])}.`;
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
        color: SIX_COLOR,
      },
    ],
    // Pas de bouton Règles : celui du message public posté au même moment suffit
    components: [],
  };
}

// Boutons de coup, à son tour seulement : toujours les 4 colonnes, celles
// où la carte ne peut pas aller désactivées (grisées) ; tous gris et sans
// indication de perte (le récit du coup la donne). Le numéro du coup dans
// le custom_id écarte un clic sur une vue dépassée (pendant la réflexion
// de Kévina, par exemple).
function boutonsCoups(d, monTour, sfx) {
  if (!monTour) return [];
  const permises = new Set(coupsPossibles(d).map((x) => x.c));
  return [
    {
      type: 1,
      components: NOMS_COLONNES.map((nom, c) => ({
        type: 2,
        style: 2,
        label: nom,
        disabled: !permises.has(c),
        custom_id: `sixduel_jouer:${c}:${d.coups}${sfx}`,
      })),
    },
  ];
}

// « Ta carte : 🟦7 » en titre H1 (carte agrandie) à son tour, avec la
// prochaine carte de la pioche (celle de l'adversaire) en petit dessous ;
// « Carte de Kévina : 🟥3 » en texte sinon.
function ligneCarte(d, moi, A) {
  if (!d.carte) return null;
  if (d.actif !== moi) return `Carte de ${A.Sujet} : ${carteTexte(d.carte)}`;
  const suivante = prochaine(d);
  return [`# Ta carte : ${carteTexte(d.carte)}`, ...(suivante ? [`-# (prochaine : ${carteTexte(suivante)})`] : [])].join("\n");
}

// Vue d'un joueur : plateau, résultat de la dernière action
// (`texte`), sa carte et les boutons de coup à son tour, ou fin.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison,
// confirmerAbandon (question à la place des boutons) }. Étape d'explosion
// (`d.explosion`) : ni tour, ni carte, ni boutons de coup.
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false } = {},
) {
  if (d.termine) return vueFin(d, { moi, A, raison });
  const monTour = d.actif === moi;
  const sfx = pvp ? ":pvp" : "";
  const lignes = [
    ...(confirmerAbandon ? ["🏳️ **Abandonner la partie ?** Ce sera une défaite.", ""] : []),
    ...plateau(d),
    ...(confirmerAbandon
      ? []
      : [
          ...(texte ? ["", texte] : []),
          ...(d.explosion
            ? []
            : [
                "",
                ...(monTour ? [] : [`⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
                ligneCarte(d, moi, A),
              ]),
        ]),
  ].filter((l) => l !== null);
  const titre = `${TITRE} · ${pvp ? (monTour ? "À toi !" : `contre ${A.Sujet}`) : "contre Kévina"}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: SIX_COLOR };
  if (confirmerAbandon) return { embeds: [embed], components: boutonsConfirmation(sfx) };
  if (d.explosion) return { embeds: [embed], components: boutonsFin() };
  // Contre Kévina, ce n'est jamais son tour qu'en pleine réflexion : pas d'abandon
  const regles = { type: 1, components: [BOUTON_REGLES, ...(monTour || pvp ? [boutonAbandon(sfx)] : [])] };
  return { embeds: [embed], components: [...boutonsCoups(d, monTour, sfx), regles] };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Six",
    description: [
      `${NB_COLONNES} colonnes et une pioche commune de 36 cartes (4 couleurs, de 1 à 9). But : perdre le moins de points.`,
      "",
      "**🃏 À ton tour**, tu retournes la carte du dessus de la pioche :",
      "• tu la poses sur une colonne dont la dernière carte est **plus faible** (au choix s'il y en a plusieurs) ;",
      "• plus forte nulle part : tu la poses où tu veux.",
      "La prochaine carte, celle de ton adversaire, est visible.",
      `• ${SIXIEME} **6ᵉ carte** d'une colonne : tu ramasses les 5 autres, ta carte reste.`,
      `**💸 Points perdus** : 1 par carte ramassée, ${1 + PENALITE_MAUDITE} par carte **rouge** (maudite).`,
      `**🏆 Fin** : dès qu'un joueur atteint ${SEUIL} points perdus, ou quand la pioche est vide. Le moins de points gagne, égalité : match nul.`,
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: SIX_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionJouer(d, moi, c, coup) {
  if (!d.termine && coup !== d.coups) return { erreur: "perime" };
  const r = jouer(d, moi, c);
  if (r.erreur) return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : "interdite" };
  return {};
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleSixRoleRejected(webhookUrl) {
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
          d.explosion
            ? ligneExplosion(d, (id) => (id === "bot" ? "Kévina" : pseudo))
            : d.actif === "bot"
              ? "⏳ Kévina réfléchit…"
              : `Au tour de **${pseudo}**, carte : ${carteTexte(d.carte)}`,
          "",
          ...plateauPublic(d, pseudo, "🤖 Kévina"),
          "",
          `⏰ Sans action, partie abandonnée <t:${expiration}:R>.`,
        ]
          .join("\n")
          .slice(0, 4096),
        color: SIX_COLOR,
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
export async function handleSixCommand(webhookUrl, body) {
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
    console.error("[Six] Échec lancement:", err.message);
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
  const { joueur, bot } = d.points;
  const resultat = d.abandon
    ? `🏳️ ${pseudo} abandonne face à Kévina.`
    : d.gagnant === "nul"
      ? `🤝 Match nul entre ${pseudo} et Kévina (${pts(joueur)} perdus chacun).`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} bat Kévina : ${pts(joueur)} perdus contre ${bot} !`
        : `🤖 Kévina bat ${pseudo} : ${pts(bot)} perdus contre ${joueur}.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, "", ...plateau(d, "###"), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: SIX_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function executerSolo(webhookUrl, discordId, c, coup, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(discordId, (d) => {
    const r = actionJouer(d, "joueur", c, coup);
    if (r.erreur) return r;
    const texteJoueur = `${recit(d, "joueur", BOT)}.`;
    const lignes = [recit(d, "joueur", BOT)];
    // Étapes avant la vue finale : explosion du coup du joueur, réflexion
    // de Kévina (plateau après le coup du joueur, puis attente), explosion
    // de son coup ; une explosion qui termine la partie est montrée avant
    // le récapitulatif
    const etapes = [];
    const explosionJoueur = etatExplosion(d);
    if (explosionJoueur) etapes.push({ duel: explosionJoueur, texte: texteJoueur, pause: DELAI_EXPLOSION_MS });
    // Kévina joue dans la foulée (sous le même verrou)
    if (!d.termine) {
      etapes.push({ duel: structuredClone(d), texte: texteJoueur, reflexion: true });
      jouer(d, "bot", choixKevina(d, "bot", { marge: config.marge_kevina }));
      lignes.push(recit(d, "joueur", BOT));
      const explosionKevina = etatExplosion(d);
      if (explosionKevina) etapes.push({ duel: explosionKevina, texte: `${lignes.join(", ")}.`, pause: DELAI_EXPLOSION_MS });
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
      description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/six` !",
      color: SIX_COLOR,
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
// dernier coup est raconté. `etat` : étape d'explosion à afficher.
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
          color: SIX_COLOR,
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
  custom_id: "sixduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, carte à
// jouer, délai, plateau neutre). `etat` : étape d'explosion à afficher.
function messagePublic(partie, config, etat = null) {
  if (partie.statut === "lobby") {
    const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: SIX_COLOR,
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
          d.explosion
            ? ligneExplosion(d, nom)
            : `Au tour de **${nom(d.actif)}**, carte : ${carteTexte(d.carte)}, limite <t:${echeanceDe(partie, config)}:R>`,
          "",
          ...plateauPublic(d, nom("joueur"), nom("bot")),
        ].join("\n").slice(0, 4096),
        color: SIX_COLOR,
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
      ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")} (${pts(d.points.joueur)} perdus chacun).`
      : partie.raisonFin === "delai"
        ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nom(g)} bat ${nom(adversaire(g))} : ${pts(d.points[g])} perdus contre ${d.points[adversaire(g)]} !`;
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
        description: [resultat, "", ...plateau(d, "###"), ...(series.length ? ["", ...series] : [])]
          .join("\n")
          .slice(0, 4096),
        color: SIX_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées). Avec `explosion` (6e carte), étape intermédiaire sur les
// vues et le message public d'abord, même si le coup termine la partie.
async function diffuserPvp(partie, config, discordId, webhookUrl, texte, explosion = null) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  if (explosion) {
    await Promise.all([
      patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte, { etat: explosion })),
      ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, null, { etat: explosion }))),
      messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config, explosion)),
    ]);
    await pause(DELAI_EXPLOSION_MS);
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
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/six` (1v1) !",
      color: SIX_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/six adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleSixPvpCommand(webhookUrl, body) {
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
    console.error("[Six] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour). L'ancienne vue du
// joueur est supprimée : seule la dernière est rééditée, une vue restée
// au-dessus afficherait sinon un tour figé.
export async function handleSixOuvrir(webhookUrl, body) {
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/six\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.`
        : null;
      // Le lanceur voit aussi l'arrivée de son adversaire
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      if (resultat.rejoint) await surveillerDelai(partie, config, discordId, webhookUrl);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[Six] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, c, coup) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionJouer(p.duel, moi, c, coup);
    return r.erreur ? r : { texte: `${recit(p.duel, moi, nomsAdv(p, moi))}.`, coup: true, explosion: etatExplosion(p.duel) };
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
    await diffuserPvp(partie, config, discordId, webhookUrl, texte, resultat.explosion);
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
export async function handleSixAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
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
    console.error("[Six] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

// `c` : colonne, `coup` : numéro du coup affiché par la vue cliquée (d.coups).
export async function handleSixJouer(webhookUrl, discordId, c, coup, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (!Number.isInteger(c) || c < 0 || c >= NB_COLONNES) return;
    if (pvp) await executerPvp(webhookUrl, discordId, c, coup);
    else await executerSolo(webhookUrl, discordId, c, coup, { channelId, pseudo });
  } catch (err) {
    console.error("[Six] Échec jouer:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleSixRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Six] Échec Règles:", err.message);
  }
}
