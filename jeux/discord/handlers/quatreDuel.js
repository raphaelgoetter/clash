// ============================================================
// quatreDuel.js (handler) — Quatre à la suite (`/quatre`), deux modes :
// - contre Kévina, le bot (`/quatre adversaire:bot`) : un seul message
//   éphémère édité en place à chaque coup ; Kévina joue aussitôt après le
//   joueur ; résultat publié dans le salon en fin de partie ;
// - 1v1 (`/quatre adversaire:1v1`) : message public dans le salon (bouton
//   Jouer : rejoindre, puis afficher sa vue, plateau visible de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, Jouer la rouvre sinon). Une seule partie à la
//   fois, comme La Grille.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : quatreduel_poser:<colonne> (contre Kévina),
// quatreduel_poser:<colonne>:pvp (1v1), quatreduel_ouvrir (bouton Jouer du
// message public), quatreduel_regles.
//
// Service : jeux/services/quatreDuel.js (Redis),
// règles : jeux/services/quatreRules.js.
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  loadDuelConfig,
  nouveauDuel,
  ouvrirPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/quatreDuel.js";
import { HAUTEUR, NB_COLONNES, adversaire, choixKevina, poser } from "../../services/quatreRules.js";
import { formatPion } from "../../services/pions.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

const QUATRE_COLOR = 0x2f6fd6;
// ④ n'est pas un emoji Discord : symbole de titre seulement
const TITRE = "④ Quatre à la suite";
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Ses propres pions en bleu, ceux de l'adversaire en rouge (code couleur
// de Clash Royale), alignement gagnant en vert
const MOI = "bleu";
const ADV = "rouge";
const GAGNANT = "vert";
const CASE_VIDE = "⬛";
// Numéros des colonnes au-dessus du plateau, alignés sur les boutons
const NUMEROS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];

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

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "",
        embeds: [],
        components: [],
        ...payload,
      }),
    });
  } catch (err) {
    console.error("[Quatre] Échec PATCH:", err.message);
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
        ? { body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }) }
        : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[Quatre] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Quatre] Erreur réseau (${method} message public):`, err.message);
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

// Plateau vu par le siège `moi` (ses pions en bleu), en titres `##` : 7
// emojis par ligne tiennent sur mobile, pas en `#`. `noms` : { moi, adv }
// libellés des deux camps, en légende.
function plateau(d, moi, noms) {
  const gagnantes = new Set((d.alignement ?? []).map(([c, r]) => `${c},${r}`));
  const pion = (id, c, r) => {
    if (!id) return CASE_VIDE;
    if (gagnantes.has(`${c},${r}`)) return formatPion(GAGNANT);
    return formatPion(id === moi ? MOI : ADV);
  };
  const rangees = [];
  for (let r = HAUTEUR - 1; r >= 0; r--) {
    rangees.push(`## ${d.colonnes.map((col, c) => pion(col[r], c, r)).join(" ")}`);
  }
  return [
    `${formatPion(MOI)} **${noms.moi}** · ${formatPion(ADV)} **${noms.adv}**`,
    `## ${NUMEROS.join(" ")}`,
    ...rangees,
  ];
}

// Plateau neutre (message public) : premier joueur en bleu.
function plateauPublic(d, nomJoueur, nomBot) {
  return plateau(d, "joueur", { moi: nomJoueur, adv: nomBot });
}

// Récit d'un coup : « Tu joues en colonne 4. »
function monCoup(coup) {
  return `Tu joues en colonne ${coup.colonne + 1}.`;
}

function coupAdverse(coup, A) {
  return `${A.Sujet} joue en colonne ${coup.colonne + 1}.`;
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  pleine: "Cette colonne est pleine.",
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
  custom_id: "quatreduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

function titreFin(d, moi, A, raison) {
  if (d.gagnant === "nul") return "🤝 Match nul";
  if (raison === "delai") {
    return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.` : "💀 Défaite… tu n'as pas joué à temps.";
  }
  return d.gagnant === moi ? "🏆 Victoire !" : "💀 Défaite…";
}

// Vue de fin : une phrase seulement, le plateau final est déjà dans le
// message public posté au même moment.
function vueFin(d, { moi, A, raison }) {
  const fin =
    raison === "delai"
      ? d.gagnant === moi
        ? `${A.Sujet} n'a pas joué à temps.`
        : "Tu n'as pas joué à temps."
      : d.gagnant === "nul"
        ? "La grille est pleine."
        : d.gagnant === moi
          ? "Tu alignes 4 pions."
          : `${A.Sujet} aligne 4 pions.`;
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
        color: QUATRE_COLOR,
      },
    ],
    // Pas de bouton Règles : celui du message public posté au même moment suffit
    components: [],
  };
}

// Boutons des 7 colonnes : 5 boutons au plus par rangée Discord, d'où 4 + 3.
function boutonsColonnes(d, sfx) {
  const bouton = (c) => ({
    type: 2,
    style: 1,
    label: String(c + 1),
    custom_id: `quatreduel_poser:${c}${sfx}`,
    disabled: d.colonnes[c].length >= HAUTEUR,
  });
  const colonnes = Array.from({ length: NB_COLONNES }, (_, c) => c);
  return [
    { type: 1, components: colonnes.slice(0, 4).map(bouton) },
    { type: 1, components: colonnes.slice(4).map(bouton) },
  ];
}

// Vue d'un joueur : résultat de la dernière action (`texte`), plateau et
// une colonne par bouton (à son tour), attente (1v1) ou fin.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison }
function buildVue(d, { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null } = {}) {
  if (d.termine) return vueFin(d, { moi, A, raison });
  const monTour = d.actif === moi;
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...plateau(d, moi, { moi: "Toi", adv: `${A.emoji} ${A.Sujet}` }),
    ...(monTour ? [] : ["", `⏳ Au tour de ${A.Sujet}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
  ];
  const titre = `${TITRE} · ${pvp ? (monTour ? "À toi !" : `contre ${A.Sujet}`) : "contre Kévina"}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: QUATRE_COLOR };
  if (!monTour) return { embeds: [embed], components: boutonsFin() };
  return {
    embeds: [embed],
    components: [...boutonsColonnes(d, pvp ? ":pvp" : ""), { type: 1, components: [BOUTON_REGLES] }],
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Quatre à la suite",
    description: [
      "Une grille de 7 colonnes sur 6 rangées. Tes pions sont bleus, ceux de ton adversaire rouges.",
      "",
      "**⬇️ À ton tour** : choisis une colonne non pleine, ton pion tombe tout en bas.",
      "**🏆 Victoire** : le premier qui aligne 4 pions (horizontale, verticale ou diagonale) gagne.",
      "**🤝 Match nul** : la grille est pleine sans alignement.",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: QUATRE_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionPoser(d, moi, colonne) {
  const r = poser(d, moi, colonne);
  if (r.erreur) {
    return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : "pleine" };
  }
  return { texte: monCoup(r) };
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleQuatreRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Lance une nouvelle partie (remplace une éventuelle partie en cours).
export async function handleQuatreCommand(webhookUrl, discordId) {
  try {
    const { duel } = await nouveauDuel(discordId);
    await patchOriginal(webhookUrl, buildVue(duel, { texte: "Nouvelle partie contre Kévina ! Tu commences." }));
  } catch (err) {
    console.error("[Quatre] Échec lancement:", err.message);
  }
}

// Fin d'une partie contre Kévina : message public (non éphémère) dans le
// salon, plateau final compris. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
  const resultat =
    d.gagnant === "nul"
      ? `🤝 Match nul entre ${pseudo} et Kévina, la grille est pleine.`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} aligne 4 pions et bat Kévina !`
        : `🤖 Kévina aligne 4 pions et bat ${pseudo}.`;
  return {
    embeds: [
      {
        title: `${TITRE} · contre Kévina`,
        description: [resultat, "", ...plateauPublic(d, pseudo, "🤖 Kévina")].join("\n").slice(0, 4096),
        color: QUATRE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function executerSolo(webhookUrl, discordId, colonne, { channelId, pseudo } = {}) {
  const config = await loadDuelConfig();
  const { duel, resultat } = await agirDuel(discordId, (d) => {
    const r = actionPoser(d, "joueur", colonne);
    if (r.erreur) return r;
    const lignes = [r.texte];
    // Kévina joue aussitôt
    if (!d.termine && d.actif === "bot") {
      poser(d, "bot", choixKevina(d, "bot", { profondeur: config.profondeur_kevina }));
      lignes.push(coupAdverse(d.dernier, BOT));
    }
    return { texte: lignes.join("\n"), vientDeFinir: d.termine };
  });
  if (!duel) {
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/quatre` !",
          color: QUATRE_COLOR,
        },
      ],
      components: boutonsFin(),
    });
    return;
  }
  if (resultat.vientDeFinir) await messageSalon("POST", channelId, null, messageFinalSolo(duel, pseudo ?? "?"));
  await patchOriginal(
    webhookUrl,
    buildVue(duel, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte }),
  );
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
// dernier coup adverse est raconté.
function vuePvp(partie, config, discordId, texte = null) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: QUATRE_COLOR,
        },
      ],
      // Pas de bouton Règles : celui du message public suffit
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  const A = nomsAdv(partie, moi);
  const d = partie.duel;
  const recit = texte ?? (d.dernier && d.dernier.id !== moi ? coupAdverse(d.dernier, A) : null);
  return buildVue(d, {
    texte: recit,
    moi,
    A,
    pvp: true,
    echeance: echeanceDe(partie, config),
    raison: partie.raisonFin,
  });
}

const BOUTON_JOUER = {
  type: 2,
  style: 3,
  label: "Jouer",
  custom_id: "quatreduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, délai).
function messagePublic(partie, config) {
  const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: QUATRE_COLOR,
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
        description: [
          ...plateauPublic(d, nom("joueur"), nom("bot")),
          "",
          `Au tour de **${nom(d.actif)}**, limite <t:${echeanceDe(partie, config)}:R>`,
          "Joueurs : clique sur **Jouer** pour afficher ta vue.",
        ].join("\n").slice(0, 4096),
        color: QUATRE_COLOR,
      },
    ],
    components,
  };
}

// Fin du 1v1 : récapitulatif dans un NOUVEAU message (visible en bas du
// salon), puis suppression du message de la partie (comme La Grille).
function messageFinal(partie) {
  const d = partie.duel;
  // Pseudos en clair, jamais de mention (pas de ping)
  const nom = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const resultat =
    g === "nul"
      ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")}, la grille est pleine.`
      : partie.raisonFin === "delai"
        ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nom(g)} aligne 4 pions et bat ${nom(adversaire(g))} !`;
  return {
    embeds: [
      {
        title: `${TITRE} · 1v1`,
        description: [resultat, "", ...plateauPublic(d, nom("joueur"), nom("bot"))].join("\n").slice(0, 4096),
        color: QUATRE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public (ou récapitulatif final).
async function diffuserPvp(partie, config, discordId, webhookUrl, texte) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte)),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id))),
  ]);
  if (partie.statut === "fini") {
    const ok = await messageSalon("POST", partie.channelId, null, messageFinal(partie));
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else await messageSalon("PATCH", partie.channelId, partie.messageId, messageFinal(partie));
    return;
  }
  await messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config));
}

const AUCUNE_PARTIE_PVP = {
  embeds: [
    {
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/quatre` (1v1) !",
      color: QUATRE_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/quatre adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleQuatrePvpCommand(webhookUrl, body) {
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
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, webhookUrl);
    });
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, "④ Défi lancé dans le salon !"));
  } catch (err) {
    console.error("[Quatre] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour).
export async function handleQuatreOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const { partie, config, resultat } = await agirPvp((p) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, discordId, username);
        memoriserWebhook(p, discordId, webhookUrl);
        return { rejoint: true, coup: true };
      }
      if (p.statut !== "lobby" && !siegeDe(p, discordId)) return { erreur: "pasJoueur" };
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/quatre\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${partie.noms[partie.sieges.joueur]} commence.`
        : null;
      // Le lanceur voit aussi l'arrivée de son adversaire
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[Quatre] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, colonne) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionPoser(p.duel, moi, colonne);
    return r.erreur ? r : { ...r, coup: true };
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
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte));
}

// ── Points d'entrée des composants ───────────────────────────────────

export async function handleQuatrePoser(webhookUrl, discordId, colonne, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (pvp) await executerPvp(webhookUrl, discordId, colonne);
    else await executerSolo(webhookUrl, discordId, colonne, { channelId, pseudo });
  } catch (err) {
    console.error("[Quatre] Échec poser:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleQuatreRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Quatre] Échec Règles:", err.message);
  }
}
