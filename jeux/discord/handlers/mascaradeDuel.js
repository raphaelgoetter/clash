// ============================================================
// mascaradeDuel.js (handler) — Mascarade (`/mascarade`), deux modes :
// - contre Kévina, le bot (`/mascarade adversaire:bot`) : table publique
//   dans le salon (suivie par tous) et vue éphémère du joueur (sa main et
//   ses boutons), éditées en place à chaque coup ; Kévina joue aussitôt
//   après le joueur ; résultat publié dans un nouveau message en fin de partie ;
// - 1v1 (`/mascarade adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; table visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque coup du joueur). Une seule
//   partie à la fois, comme Tourneboule.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : mascaradeduel_jouer:<carte>:<vue>[:pvp] (Boule de feu : ouvre
// le choix du coût), mascaradeduel_bdf:<coût>:<vue>[:pvp],
// mascaradeduel_retour:<vue>[:pvp] (quitte le choix du coût),
// mascaradeduel_choix:<laisser|dessous|0|1>:<vue>[:pvp] (Squelettes, Méga
// chevalier), mascaradeduel_ouvrir (bouton Jouer du message public),
// mascaradeduel_regles, mascaradeduel_abandon[:pvp] (🏳️, demande
// confirmation), mascaradeduel_abandon_ok[:pvp] / mascaradeduel_abandon_non[:pvp].
// <vue> = d.vue à l'affichage : un clic sur une vue dépassée est refusé.
//
// Service : jeux/services/mascaradeDuel.js (Redis), règles :
// jeux/services/mascaradeRules.js, image de la table :
// jeux/services/mascaradeImage.js (route /api/mascarade/table).
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
} from "../../services/mascaradeDuel.js";
import {
  CARTES,
  COUTS_ANNONCE,
  MANCHES_GAGNANTES,
  adversaire,
  cartesJouables,
  choisir,
  choixAttenteKevina,
  choixKevina,
  cout,
  jouer,
} from "../../services/mascaradeRules.js";
import { encodeResultat, encodeTable } from "../../services/mascaradeImage.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";

// Violet masqué
const MASCARADE_COLOR = 0x7d3c98;
const TITRE = "🎭 Mascarade";
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;
// Fin de manche affichée un instant avant la manche suivante
const DELAI_FIN_MANCHE_MS = 2500;
// Contre Kévina : délai avant d'afficher son coup (elle joue en quelques
// dizaines de millisecondes, un coup instantané paraît mécanique)
const REFLEXION_MS = { min: 1500, max: 3500 };
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
// en `###`, description, image de la table (galerie), puis boutons.
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
      accent_color: embed.color ?? MASCARADE_COLOR,
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
    if (!res.ok) console.error(`[Mascarade] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Mascarade] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Mascarade] Échec DELETE:", err.message);
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
      console.error(`[Mascarade] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Mascarade] Échec followup:", err.message);
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
      console.warn(`[Mascarade] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Mascarade] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

// Désignation de l'adversaire dans les textes : Kévina (le bot) ou un joueur.
const BOT = { Sujet: "Kévina", emoji: "🤖", image: "Kévina" };
const nomsJoueur = (pseudo) => ({ Sujet: pseudo, emoji: "⚔️", image: pseudo });
const nomsAdv = (partie, moi) => nomsJoueur(partie.noms[partie.sieges[adversaire(moi)]] ?? "?");

const nom = (carte) => CARTES[carte].nom;
const carteTxt = (carte) => `**${nom(carte)}** (${cout(carte)})`;
// Accord des verbes : « tu » ou l'adversaire
const sujet = (toi, A) => (toi ? "Tu" : A.Sujet);

// Image de la table vue par `moi` (adversaire en haut, `moi` en bas) ; sa
// main s'il en a une à montrer. `table` : manche terminée (historique).
function urlTable(d, moi, A, { avecMain = true, table = null, nomMoi = "toi" } = {}) {
  const adv = adversaire(moi);
  const t = table ?? { ecartees: d.ecartees, reserve: d.reserve, pioche: d.pioche.length, defausse: d.defausse };
  const main = d.attente?.type === "mega" && d.attente.id === moi ? d.attente.cartes : d.main[moi];
  const x = table ? null : d.dernier;
  const derniere = x && t.defausse[x.id].at(-1) === x.carte ? (x.id === moi ? 1 : 0) : -1;
  const param = encodeTable({
    ecartees: t.ecartees,
    reserve: t.reserve,
    pioche: t.pioche,
    joueesHaut: t.defausse[adv],
    joueesBas: t.defausse[moi],
    nomHaut: A.image,
    nomBas: nomMoi,
    main: avecMain && !table && main.length ? main : null,
    sommet: avecMain && !table && d.attente?.type === "squelettes" && d.attente.id === moi ? d.attente.carte : null,
    derniere,
  });
  return `${TRUST_ROYALE_URL}/api/mascarade/table?d=${param}`;
}

// Cartes qui ont décidé de la manche `h` : [du gagnant, du perdant] (null
// si inconnues).
function cartesDecisives(h) {
  const g = h.gagnant;
  const p = adversaire(g);
  const cartes = {
    bdf: ["bdf", h.mains[p]],
    comparaison: [h.mains[g], h.mains[p]],
    pioche: [h.mains[g], h.mains[p]],
    elixir: [h.mains[g], h.mains[p]],
    defausse: ["prince", "triple"],
    triple: ["gel", "triple"],
    sansCarte: ["prince", h.defausse?.[p]?.at(-1)],
  }[h.fin];
  return cartes && cartes.every((c) => CARTES[c]) ? cartes : null;
}

// Image du résultat final : une ligne par manche gagnée (manches nulles
// omises), cartes décisives côte à côte, vainqueur de la partie à gauche.
// null si la partie n'a pas fini sur une manche (abandon, délai).
function urlResultat(d, nomDe) {
  const cotes = [d.gagnant, adversaire(d.gagnant)];
  const manches = d.historique
    .map((h, i) => ({ ...h, numero: i + 1 }))
    .filter((h) => h.gagnant !== "nul")
    .map((h) => {
      const cartes = cartesDecisives(h);
      if (!cartes) return null;
      const gagnant = cotes.indexOf(h.gagnant);
      const [gauche, droite] = gagnant === 0 ? cartes : [cartes[1], cartes[0]];
      return { gauche, droite, gagnant, numero: h.numero };
    });
  if (!manches.length || manches.includes(null)) return null;
  const param = encodeResultat({ noms: cotes.map(nomDe), manches });
  return `${TRUST_ROYALE_URL}/api/mascarade/resultat?d=${param}`;
}

// Récit de la dernière action (`d.dernier`) vue par `moi`, sans point final.
// Rien de ce que `moi` ne doit pas savoir : la carte vue par des Gobelins
// adverses, la carte remise dans la Réserve par l'adversaire, etc.
function recit(d, moi, A) {
  const x = d.dernier;
  if (!x) return null;
  const toi = x.id === moi;
  const S = sujet(toi, A);
  const e = x.effet;
  const joue = `${S} ${toi ? "joues" : "joue"} ${carteTxt(x.carte)}`;
  if (e.protege) return `${joue} : sans effet, ${toi ? `${A.Sujet} est protégée` : "tu es protégé"} 🛡️`;
  switch (x.carte) {
    case "squelettes":
      if (d.attente?.id === x.id) return toi ? joue : `${joue} et regarde le sommet de la pioche`;
      if (e.dessous === undefined) return `${joue} : la pioche est vide`;
      return toi
        ? `${joue} et ${e.dessous ? "glisses la carte du sommet sous la pioche" : "laisses la carte au sommet"}`
        : `${joue} : ${e.dessous ? "elle glisse la carte du sommet sous la pioche" : "elle laisse la carte au sommet"}`;
    case "gobelins":
      return toi ? `${joue} : ${A.Sujet} a ${carteTxt(e.vu)} 👁️` : `${joue} et regarde ta carte 👁️`;
    case "prince":
      if (e.defaussee === "triple") return `${joue} : ${toi ? `${A.Sujet} défausse` : "tu défausses"} ${carteTxt("triple")} 🤴`;
      return `${joue} : ${toi ? `${A.Sujet} défausse` : "tu défausses"} ${carteTxt(e.defaussee)}${e.sansCarte ? ", et plus rien à piocher" : ""} 🤴`;
    case "chevalier":
      return `${joue} : ${toi ? "tu es protégé" : `${A.Sujet} est protégée`} jusqu'à ${toi ? "ton" : "son"} prochain tour 🛡️`;
    case "tornade":
      return `${joue} : vous échangez vos cartes, tu reçois ${carteTxt(e.recue[moi])} 🌪️`;
    case "bdf":
      return `${joue} sur ${x.cible} : ${e.touche ? `touché, ${toi ? A.Sujet : "tu"} ${toi ? "avait" : "avais"} ${carteTxt(e.carte)} 💥` : "raté"}`;
    case "gel":
      return `${joue} : ${toi ? `${A.Sujet} devra` : "tu devras"} jouer ${toi ? "sa" : "ta"} prochaine carte piochée 🧊`;
    case "buche": {
      const [a, b] = [e.cartes[moi], e.cartes[adversaire(moi)]];
      return `${joue} : toi ${carteTxt(a)} contre ${A.Sujet} ${carteTxt(b)}${cout(a) === cout(b) ? ", égalité" : ""} 🪵`;
    }
    case "mega":
      if (e.sansReserve) return `${joue} : la Réserve est vide`;
      if (d.attente?.id === x.id) return toi ? `${joue} et prends la Réserve` : `${joue} et prend la Réserve`;
      return toi
        ? `${joue} : tu ${e.echange ? "prends la carte de la Réserve et y remets la tienne" : "gardes ta carte et remets celle de la Réserve"}`
        : `${joue} : elle prend la Réserve et y remet une carte`;
    case "triple":
      return `${joue} 💀`;
    default:
      return joue;
  }
}

// Récit neutre pour le salon (aucune carte cachée révélée).
function recitPublic(d, nomDe) {
  const x = d.dernier;
  if (!x) return null;
  const e = x.effet;
  const joue = `${nomDe(x.id)} joue ${carteTxt(x.carte)}`;
  if (e.protege) return `${joue} : sans effet (protégé) 🛡️`;
  switch (x.carte) {
    case "squelettes":
      return `${joue} et regarde le sommet de la pioche`;
    case "gobelins":
      return `${joue} et regarde la carte de ${nomDe(adversaire(x.id))} 👁️`;
    case "prince":
      return `${joue} : ${nomDe(adversaire(x.id))} défausse ${carteTxt(e.defaussee)} 🤴`;
    case "chevalier":
      return `${joue} et se protège 🛡️`;
    case "tornade":
      return `${joue} : les cartes sont échangées 🌪️`;
    case "bdf":
      return `${joue} sur ${x.cible} : ${e.touche ? "touché 💥" : "raté"}`;
    case "gel":
      return `${joue} : ${nomDe(adversaire(x.id))} devra jouer sa prochaine carte piochée 🧊`;
    case "buche":
      return `${joue} : cartes comparées en secret 🪵`;
    case "mega":
      return e.sansReserve ? joue : `${joue} et échange avec la Réserve`;
    default:
      return joue;
  }
}

// « 🏁 Manche 2 : Kévina gagne (Boule de feu) » ; `nomDe(id)` désigne les joueurs.
function ligneManche(h, numero, nomDe) {
  if (h.gagnant === "nul") return `🏁 Manche ${numero} : égalité parfaite, manche nulle`;
  const g = nomDe(h.gagnant);
  const p = nomDe(adversaire(h.gagnant));
  // Une main peut être vide (Prince sans rien à repiocher)
  const main = (id) => (h.mains[id] ? carteTxt(h.mains[id]) : "aucune carte");
  const mains = () => `${g} ${main(h.gagnant)}, ${p} ${main(adversaire(h.gagnant))}`;
  const raisons = {
    bdf: () => `Boule de feu sur ${main(adversaire(h.gagnant))}`,
    comparaison: () => `Bûche : ${mains()}`,
    defausse: () => `${p} défausse les ${nom("triple")}`,
    triple: () => `${p} joue les ${nom("triple")}`,
    sansCarte: () => `${p} n'a plus rien à piocher`,
    pioche: () => `pioche vide : ${mains()}`,
    elixir: () => `pioche vide, égalité départagée à l'élixir dépensé : ${mains()}`,
  };
  return `🏁 Manche ${numero} pour ${g} (${raisons[h.fin]()})`;
}

const score = (d, moi, A) => `Toi ${d.manches[moi]} – ${d.manches[adversaire(moi)]} ${A.Sujet}`;

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  attente: "Termine d'abord ton choix.",
  pasEnMain: "Tu n'as pas cette carte.",
  gel: "Gelé : tu dois jouer la carte que tu viens de piocher.",
  triple: `Les ${CARTES.triple.nom} ne se jouent pas : tu perdrais la manche.`,
  cible: "Choisis un coût à annoncer.",
  choix: "Choix impossible.",
  perime: "La table a changé depuis : rejoue sur celle-ci.",
  pause: "Lance d'abord la manche suivante.",
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};

const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "mascaradeduel_regles" };
const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];
const boutonAbandon = (sfx) => ({ type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: `mascaradeduel_abandon${sfx}` });

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: `mascaradeduel_abandon_ok${sfx}` },
        { type: 2, style: 2, label: "Annuler", custom_id: `mascaradeduel_abandon_non${sfx}` },
      ],
    },
  ];
}

// Boutons d'action selon l'état : cartes en main (grisées si injouables),
// choix du coût de la Boule de feu, choix des Squelettes ou du Méga chevalier.
function boutonsAction(d, moi, sfx, { choixCout = false } = {}) {
  const v = d.vue;
  const a = d.attente?.id === moi ? d.attente : null;
  if (a?.type === "squelettes") {
    return [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "Laisser au sommet", custom_id: `mascaradeduel_choix:laisser:${v}${sfx}` },
          { type: 2, style: 2, label: "Glisser dessous", custom_id: `mascaradeduel_choix:dessous:${v}${sfx}` },
        ],
      },
    ];
  }
  if (a?.type === "mega") {
    return [
      {
        type: 1,
        components: a.cartes.map((c, i) => ({ type: 2, style: 2, label: `Garder ${nom(c)}`, custom_id: `mascaradeduel_choix:${i}:${v}${sfx}` })),
      },
    ];
  }
  if (choixCout) {
    return [
      { type: 1, components: COUTS_ANNONCE.map((c) => ({ type: 2, style: 2, label: String(c), custom_id: `mascaradeduel_bdf:${c}:${v}${sfx}` })) },
      { type: 1, components: [{ type: 2, style: 2, label: "Retour", emoji: { name: "↩️" }, custom_id: `mascaradeduel_retour:${v}${sfx}` }] },
    ];
  }
  const jouables = new Set(cartesJouables(d, moi));
  const cartes = [...new Set(d.main[moi])];
  return [
    {
      type: 1,
      components: cartes.map((c) => ({
        type: 2,
        style: 2,
        label: nom(c),
        custom_id: `mascaradeduel_jouer:${c}:${v}${sfx}`,
        disabled: !jouables.has(c),
      })),
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
        color: MASCARADE_COLOR,
      },
    ],
    components: [],
  };
}

// Vue d'un joueur : score dans le titre, récit, informations (carte adverse
// connue, Gel), table et main en image, boutons. `ctx` : { moi, A, pvp,
// echeance, raison, confirmerAbandon, choixCout, nomMoi }. Étape de fin de
// manche (`d.etapeManche`) : texte et table de la manche terminée, sans
// boutons.
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, confirmerAbandon = false, choixCout = false } = {},
) {
  if (d.termine && !d.etapeManche) return vueFin(d, { moi, A, raison });
  if (d.pauseManche && !d.etapeManche && !confirmerAbandon) return vuePause(d, { texte, moi, A, pvp, echeance });
  const monTour = !d.etapeManche && (d.attente ? d.attente.id === moi : d.actif === moi);
  const sfx = pvp ? ":pvp" : "";
  const titre = `${TITRE} · ${score(d, moi, A)}${pvp && monTour ? " · À toi !" : ""}`;
  if (confirmerAbandon) {
    return {
      embeds: [{ title: titre, description: "🏳️ **Abandonner la partie ?** Ce sera une défaite.", color: MASCARADE_COLOR }],
      components: boutonsConfirmation(sfx),
    };
  }
  if (d.etapeManche) {
    const h = d.etapeManche;
    return {
      embeds: [
        {
          title: titre,
          description: [texte, "", ligneManche(h, d.etapeManche.numero, (id) => (id === moi ? "toi" : A.Sujet))].filter((l) => l !== null).join("\n"),
          image: { url: urlTable(d, moi, A, { table: h }) },
          color: MASCARADE_COLOR,
        },
      ],
      components: [],
    };
  }
  const infos = [];
  if (d.connu[moi] && !d.attente) infos.push(`👁️ ${A.Sujet} a ${carteTxt(d.connu[moi])}`);
  if (monTour && d.gele[moi]) infos.push(`🧊 ${ERREURS.gel}`);
  if (d.protege[moi]) infos.push("🛡️ Tu es protégé jusqu'à ton prochain tour.");
  const consigne = !monTour
    ? `⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`
    : d.attente?.type === "squelettes"
      ? "Sommet de la pioche : le laisser (l'adversaire le piochera) ou le glisser dessous ?"
      : d.attente?.type === "mega"
        ? "Quelle carte gardes-tu ? L'autre retourne face cachée dans la Réserve."
        : choixCout
          ? "🔥 Quel coût annonces-tu ? Si la carte adverse coûte autant, elle perd la manche."
          : "À toi : joue une de tes deux cartes.";
  const limite = monTour && echeance ? [`⏰ Limite <t:${echeance}:R>`] : [];
  const lignes = [`Manche **${d.numero}** · premier à ${MANCHES_GAGNANTES}`, ...(texte ? ["", texte] : []), ...(infos.length ? ["", ...infos] : []), "", consigne, ...limite];
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), image: { url: urlTable(d, moi, A) }, color: MASCARADE_COLOR };
  // Contre Kévina, ce n'est jamais son tour qu'en pleine réflexion : pas d'abandon
  const regles = { type: 1, components: [BOUTON_REGLES, ...(monTour || pvp ? [boutonAbandon(sfx)] : [])] };
  return { embeds: [embed], components: [...(monTour ? boutonsAction(d, moi, sfx, { choixCout }) : []), regles] };
}

// Pause de fin de manche (`d.pauseManche`) : récit du dernier coup, résultat
// et table de la manche finie ; bouton « Manche suivante » pour celui qui la
// lance (sa limite d'action court).
function vuePause(d, { texte, moi, A, pvp, echeance }) {
  const lanceur = lanceurManche(d, moi);
  const sfx = pvp ? ":pvp" : "";
  const h = { ...d.historique[d.pauseManche - 1], numero: d.pauseManche };
  const attente = lanceur
    ? echeance
      ? [`⏰ Limite <t:${echeance}:R>`]
      : []
    : [`⏳ ${A.Sujet} lance la manche suivante${echeance ? `, limite <t:${echeance}:R>` : ""}.`];
  const lignes = [...(texte ? [texte, ""] : []), ligneManche(h, h.numero, (id) => (id === moi ? "toi" : A.Sujet)), ...(attente.length ? ["", ...attente] : [])];
  const suivante = { type: 2, style: 2, label: "Manche suivante", emoji: { name: "▶️" }, custom_id: `mascaradeduel_suivante:${d.vue}${sfx}` };
  return {
    embeds: [
      {
        title: `${TITRE} · ${score(d, moi, A)}${pvp && lanceur ? " · À toi !" : ""}`,
        description: lignes.join("\n").slice(0, 4096),
        image: { url: urlTable(d, moi, A, { table: h }) },
        color: MASCARADE_COLOR,
      },
    ],
    components: [{ type: 1, components: [...(lanceur ? [suivante] : []), BOUTON_REGLES, boutonAbandon(sfx)] }],
  };
}

function buildReglesEmbed(config) {
  const cartes = Object.values(CARTES)
    .map((c) => `- **${c.nom}** (${c.cout}, ×${c.nb}) : ${c.effet}`)
    .join("\n");
  return {
    title: "📖 Règles de Mascarade",
    description: [
      "Chacun garde **une carte secrète** en main. Valeur d'une carte : son coût en élixir.",
      "",
      "**🎴 Manche** : 1 carte est mise de côté face cachée (la **Réserve**), 2 sont écartées face visible, et chacun reçoit 1 carte. À ton tour, tu pioches, puis tu **joues l'une de tes deux cartes** : son effet s'applique.",
      `**🏁 Fin de manche** : un joueur est éliminé, ou la pioche est vide et la carte la plus chère en main l'emporte (égalité : le plus d'élixir dépensé). Le perdant commence la suivante. **Premier à ${MANCHES_GAGNANTES} manches.**`,
      "",
      cartes,
      "",
      "Un Prince alors qu'il ne reste rien à piocher (ni pioche ni Réserve) élimine l'adversaire.",
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
      "",
      `⏰ ${plural(config.delai_tour_minutes, "minute")} par action, sinon défaite.`,
    ].join("\n"),
    color: MASCARADE_COLOR,
  };
}

// ── Actions (communes aux deux modes) ────────────────────────────────

// Action `a` du siège `moi` : { type: "jouer", carte, cible } ou { type:
// "choix", choix } ; `vue` : numéro de la vue cliquée.
function agir(d, moi, a, vue) {
  if (!d.termine && vue !== d.vue) return { erreur: "perime" };
  if (a.type === "suivante") {
    if (d.termine || !d.pauseManche) return { erreur: d.termine ? "termine" : "perime" };
    if (!lanceurManche(d, moi)) return { erreur: "pasTonTour" };
    d.pauseManche = null;
    d.vue += 1;
    return {};
  }
  if (d.pauseManche) return { erreur: "pause" };
  const avant = d.historique.length;
  const r = a.type === "jouer" ? jouer(d, moi, a.carte, { cible: a.cible }) : choisir(d, moi, a.choix);
  if (r.erreur) return r;
  marquerPause(d, avant);
  return {};
}

// Manche terminée sans finir la partie : pause sur son résultat jusqu'au
// clic sur « Manche suivante » (`d.pauseManche` : numéro de la manche finie).
function marquerPause(d, avant) {
  if (d.historique.length > avant && !d.termine) d.pauseManche = d.historique.length;
}

// Qui lance la manche suivante : contre Kévina, toujours le joueur ; en 1v1,
// celui qui la commence (le perdant de la manche).
const lanceurManche = (d, moi) => (d.pvp ? d.actif === moi : moi === "joueur");

// Copie du duel pour l'étape de fin de manche `numero` (table et main
// figées de la manche terminée).
function etapeFinManche(d, numero) {
  const e = structuredClone(d);
  e.etapeManche = { ...d.historique[numero - 1], numero };
  return e;
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleMascaradeRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, { content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie." });
}

// Table publique d'une partie contre Kévina : suivie par le salon (sans les
// mains), le joueur joue depuis sa vue éphémère.
function messageSolo(d, pseudo, config, recitPub = null) {
  const nomDe = (id) => (id === "bot" ? "Kévina" : pseudo);
  const etat = d.etapeManche
    ? ligneManche(d.etapeManche, d.etapeManche.numero, nomDe)
    : (d.attente ? d.attente.id : d.actif) === "bot"
      ? "⏳ Kévina réfléchit…"
      : `Au tour de **${pseudo}**, limite <t:${echeanceSolo(d, config)}:R>.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [
          `Manche **${d.etapeManche?.numero ?? d.numero}** · Score : **${pseudo} ${d.manches.joueur}** – ${d.manches.bot} 🤖 Kévina`,
          ...(recitPub ? ["", recitPub] : []),
          "",
          etat,
        ]
          .join("\n")
          .slice(0, 4096),
        image: { url: urlTable(d, "joueur", { image: "Kévina" }, { avecMain: false, table: d.etapeManche ?? null, nomMoi: pseudo }) },
        color: MASCARADE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function majSalonSolo(d, pseudo, config) {
  if (d.pauseManche && !d.etapeManche && !d.termine) d = etapeFinManche(d, d.pauseManche);
  const recitPub = d.dernier?.manche === d.numero || d.etapeManche ? recitPublic(d, (id) => (id === "bot" ? "Kévina" : pseudo)) : null;
  if (d.salon) await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, messageSolo(d, pseudo ?? "?", config, recitPub));
}

// Lance une nouvelle partie : table publique dans le salon, puis vue
// éphémère du joueur EN DESSOUS (réponse différée supprimée, vue renvoyée
// en followup). Repli : vue dans la réponse différée.
export async function handleMascaradeCommand(webhookUrl, body) {
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
    console.error("[Mascarade] Échec lancement:", err.message);
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

// Fin d'une partie contre Kévina : message public (non éphémère), résultat
// et série. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
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
  const image = d.abandon || d.delai ? null : urlResultat(d, (id) => (id === "bot" ? "Kévina" : pseudo));
  const resultat = d.abandon
    ? `🏳️ ${pseudo} abandonne face à Kévina.`
    : d.delai
      ? `⏰ ${pseudo} n'a pas joué à temps : Kévina gagne.`
      : d.gagnant === "joueur"
      ? `🏆 ${pseudo} bat Kévina : ${j} manches à ${b} !`
      : `🤖 Kévina bat ${pseudo} : ${b} manches à ${j}.`;
  return {
    embeds: [
      {
        title: `${TITRE} · ${pseudo} contre Kévina`,
        description: [resultat, ...(series.length ? ["", ...series] : [])].join("\n").slice(0, 4096),
        ...(image ? { image: { url: image } } : {}),
        color: MASCARADE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Action du joueur contre Kévina, puis les coups de Kévina tant que c'est
// son tour (manche suivante comprise). Étapes affichées dans l'ordre :
// réflexion de Kévina, fins de manche.
async function executerSolo(webhookUrl, discordId, action, vue, { channelId, pseudo, choixCout = false } = {}) {
  const config = await loadDuelConfig();
  const reglages = { mondes: config.mondes_kevina, erreur: config.erreur_kevina };
  const { duel, resultat } = await agirDuel(
    discordId,
    (d) => {
      // Boule de feu cliquée : choix du coût, sans rien jouer
      if (choixCout) return d.termine || vue !== d.vue ? { erreur: d.termine ? "termine" : "perime" } : { choixCout: true };
      const avant = d.historique.length;
      const r = agir(d, "joueur", action, vue);
      if (r.erreur) return r;
      const etapes = [];
      const reflexion = () => REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min);
      // Récit du tour : coup du joueur puis ceux de Kévina (repart à zéro à chaque manche)
      let lignes = action.type === "suivante" ? [] : [recit(d, "joueur", BOT)];
      const texte = () => `${lignes.join(".\n")}.`;
      // Fin de partie : étape de la dernière manche avant le récapitulatif
      if (d.termine && d.historique.length > avant) {
        etapes.push({ duel: etapeFinManche(d, avant + 1), texte: texte(), pause: DELAI_FIN_MANCHE_MS });
        lignes = [];
      }
      // Kévina joue dans la foulée (sous le même verrou), y compris ses choix
      for (let k = 0; k < 20 && !d.termine && !d.pauseManche && !(d.attente?.id === "joueur") && (d.attente?.id === "bot" || (!d.attente && d.actif === "bot")); k++) {
        etapes.push({ duel: structuredClone(d), texte: lignes.length ? texte() : null, pause: reflexion() });
        const n = d.historique.length;
        if (d.attente) choisir(d, "bot", choixAttenteKevina(d, "bot", reglages));
        else {
          const c = choixKevina(d, "bot", reglages);
          jouer(d, "bot", c.carte, { cible: c.cible });
          if (d.attente?.id === "bot") choisir(d, "bot", choixAttenteKevina(d, "bot", reglages));
        }
        lignes.push(recit(d, "joueur", BOT));
        marquerPause(d, n);
        if (d.termine && d.historique.length > n) {
          etapes.push({ duel: etapeFinManche(d, n + 1), texte: texte(), pause: DELAI_FIN_MANCHE_MS });
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
  if (resultat.choixCout) {
    await patchOriginal(webhookUrl, vueSolo(duel, config, { choixCout: true }));
    return;
  }
  for (const etape of resultat.etapes ?? []) {
    await Promise.all([patchOriginal(webhookUrl, buildVue(etape.duel, { texte: etape.texte })), majSalonSolo(etape.duel, pseudo, config)]);
    await pause(etape.pause);
  }
  if ((resultat.vientDeFinir || resultat.delai) && (await publierFinSolo(webhookUrl, channelId, duel, pseudo))) return;
  await Promise.all([
    patchOriginal(webhookUrl, vueSolo(duel, config, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte })),
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
  embeds: [{ description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/mascarade` !", color: MASCARADE_COLOR }],
  components: boutonsFin(),
};

// Fin contre Kévina : récapitulatif dans un NOUVEAU message, table publique
// supprimée (repli : éditée en récapitulatif), vue éphémère supprimée. Faux
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
      Object.assign(d, { termine: true, gagnant: "bot", abandon: "joueur", attente: null });
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
// dernière action est racontée. `etat` : étape de fin de manche à afficher.
function vuePvp(partie, config, discordId, texte = null, { confirmerAbandon = false, etat = null, choixCout = false } = {}) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [...(texte ? [texte, ""] : []), "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi."].join("\n"),
          color: MASCARADE_COLOR,
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
    texte: texte ?? ((d.dernier?.manche === d.numero || d.pauseManche) && !d.etapeManche ? `${recit(d, moi, A)}.` : null),
    moi,
    A,
    pvp: true,
    echeance: echeanceDe(partie, config),
    raison: partie.raisonFin,
    confirmerAbandon,
    choixCout,
  });
}

const BOUTON_JOUER = { type: 2, style: 3, label: "Jouer", custom_id: "mascaradeduel_ouvrir" };

// Message public : lobby, puis table en direct (sans les mains).
function messagePublic(partie, config, etat = null) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: MASCARADE_COLOR,
        },
      ],
      components: [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }],
    };
  }
  let d = etat ?? partie.duel;
  if (d.pauseManche && !d.etapeManche && !d.termine) d = etapeFinManche(d, d.pauseManche);
  const nomDe = (siege) => partie.noms[partie.sieges[siege]] ?? "?";
  const qui = d.attente ? d.attente.id : d.actif;
  return {
    embeds: [
      {
        title: `${TITRE} · ${nomDe("joueur")} contre ${nomDe("bot")}`,
        description: [
          `Manche **${d.etapeManche?.numero ?? d.numero}** · Score : **${nomDe("joueur")} ${d.manches.joueur}** – ${d.manches.bot} ${nomDe("bot")}`,
          ...(d.dernier?.manche === d.numero && !d.etapeManche ? ["", recitPublic(d, nomDe)] : []),
          "",
          d.etapeManche ? ligneManche(d.etapeManche, d.etapeManche.numero, nomDe) : `Au tour de **${nomDe(qui)}**, limite <t:${echeanceDe(partie, config)}:R>`,
        ].join("\n").slice(0, 4096),
        image: { url: urlTable(d, "joueur", { image: nomDe("bot") }, { avecMain: false, table: d.etapeManche ?? null, nomMoi: nomDe("joueur") }) },
        color: MASCARADE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

const titreGagnant = (g, nomDe) => `${nomDe(g)} contre ${nomDe(adversaire(g))}`;

// Fin du 1v1 : récapitulatif dans un NOUVEAU message, puis suppression du
// message de la partie.
function messageFinal(partie) {
  const d = partie.duel;
  const nomDe = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const resultat =
    partie.raisonFin === "abandon"
      ? `🏳️ ${nomDe(adversaire(g))} abandonne : ${nomDe(g)} remporte le duel.`
      : partie.raisonFin === "delai"
        ? `🏆 ${nomDe(g)} remporte le duel : ${nomDe(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nomDe(g)} bat ${nomDe(adversaire(g))} : ${d.manches[g]} manches à ${d.manches[adversaire(g)]} !`;
  const image = partie.raisonFin === "jeu" ? urlResultat(d, nomDe) : null;
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
        title: `${TITRE} · ${titreGagnant(g, nomDe)}`,
        description: [resultat, ...(series.length ? ["", ...series] : [])].join("\n").slice(0, 4096),
        ...(image ? { image: { url: image } } : {}),
        color: MASCARADE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après une action : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées). `etape` : fin de manche, montrée d'abord.
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
  // Après une fin de manche, la nouvelle manche commence sans récit
  const suite = etape ? null : texte;
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, suite ?? (etape ? "Nouvelle manche !" : null))),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, etape ? "Nouvelle manche !" : null))),
  ]);
  await messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config));
}

// Fin au délai sans attendre un clic (voir Tourneboule).
async function surveillerDelai(partie, config, discordId, webhookUrl) {
  if (partie.statut !== "enCours") return;
  await pause(Math.max(0, partie.dernierCoupAt + config.delai_tour_minutes * 60_000 - Date.now()) + 1000);
  const r = await agirPvp(() => ({}));
  if (r.partie && r.resultat.vientDeFinir) await diffuserPvp(r.partie, r.config, discordId, webhookUrl, null);
}

const AUCUNE_PARTIE_PVP = {
  embeds: [{ description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/mascarade` (1v1) !", color: MASCARADE_COLOR }],
  components: boutonsFin(),
};

// `/mascarade adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleMascaradePvpCommand(webhookUrl, body) {
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
    const vue = vuePvp(r.partie, config, discordId, "🎭 Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Mascarade] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa vue
// (nouvel éphémère, mémorisé ; l'ancienne vue est supprimée).
export async function handleMascaradeOuvrir(webhookUrl, body) {
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/mascarade\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      const texte = resultat.rejoint ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.` : null;
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      if (resultat.rejoint) await surveillerDelai(partie, config, discordId, webhookUrl);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[Mascarade] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, action, vue, { choixCout = false } = {}) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    if (choixCout) return vue !== p.duel.vue ? { erreur: "perime" } : { choixCout: true };
    const avant = p.duel.historique.length;
    const r = agir(p.duel, moi, action, vue);
    if (r.erreur) return r;
    // Fin de partie : étape de la dernière manche avant le récapitulatif
    const etape = p.duel.termine && p.duel.historique.length > avant ? etapeFinManche(p.duel, avant + 1) : null;
    return { texte: action.type === "suivante" ? null : `${recit(p.duel, moi, nomsAdv(p, moi))}.`, coup: true, etape };
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (resultat.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  if (resultat.choixCout) {
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, null, { choixCout: true }));
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
    Object.assign(p.duel, { termine: true, gagnant: adversaire(moi), abandon: moi, attente: null });
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
export async function handleMascaradeAbandon(webhookUrl, discordId, etape, { pvp = false, channelId, pseudo } = {}) {
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
    console.error("[Mascarade] Échec abandon:", err.message);
  }
}

// ── Points d'entrée des composants ───────────────────────────────────

// Clic d'action : `type` "jouer" (arg = carte ; Boule de feu : choix du
// coût), "bdf" (arg = coût), "retour" (quitte le choix du coût), "choix"
// (arg = laisser | dessous | 0 | 1) ; `vue` : numéro de la vue cliquée.
export async function handleMascaradeAction(webhookUrl, discordId, type, arg, vue, { pvp = false, channelId, pseudo } = {}) {
  try {
    let action = null;
    let choixCout = false;
    if (type === "jouer") {
      if (!CARTES[arg]) return;
      if (arg === "bdf") choixCout = true;
      else action = { type: "jouer", carte: arg };
    } else if (type === "bdf") action = { type: "jouer", carte: "bdf", cible: Number(arg) };
    else if (type === "choix") action = { type: "choix", choix: ["0", "1"].includes(arg) ? Number(arg) : arg };
    else if (type === "suivante") action = { type: "suivante" };
    else if (type !== "retour") return;
    if (type === "retour") {
      // Retour à la vue normale, sans rien jouer
      if (pvp) {
        const partie = await readPvp();
        if (partie && siegeDe(partie, discordId)) await patchOriginal(webhookUrl, vuePvp(partie, await loadDuelConfig(), discordId));
      } else {
        const duel = await readDuel(discordId);
        await patchOriginal(webhookUrl, duel ? vueSolo(duel, await loadDuelConfig()) : AUCUNE_PARTIE_SOLO);
      }
      return;
    }
    if (pvp) await executerPvp(webhookUrl, discordId, action, vue, { choixCout });
    else await executerSolo(webhookUrl, discordId, action, vue, { channelId, pseudo, choixCout });
  } catch (err) {
    console.error("[Mascarade] Échec action:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleMascaradeRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Mascarade] Échec Règles:", err.message);
  }
}
