// ============================================================
// areneDuel.js (handler) — Arène (`/arene`), deux modes :
// - contre Kévina, le bot (`/arene adversaire:bot`) : un seul message
//   éphémère édité en place à chaque coup ; Kévina pose son dé aussitôt
//   après le joueur ; résultat publié dans le salon en fin de partie ;
// - 1v1 (`/arene adversaire:1v1`) : message public dans le salon (bouton
//   Jouer : rejoindre, puis afficher sa vue, plateaux visibles de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, Jouer la rouvre sinon). Une seule partie à la
//   fois, comme Bang! Duel.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : areneduel_poser:<colonne> (contre Kévina),
// areneduel_poser:<colonne>:pvp (1v1), areneduel_ouvrir (bouton Jouer du
// message public), areneduel_regles.
//
// Service : jeux/services/areneDuel.js (Redis),
// règles : jeux/services/areneRules.js.
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
} from "../../services/areneDuel.js";
import {
  HAUTEUR,
  adversaire,
  choixGlouton,
  poser,
  scoreColonne,
  scoreGrille,
} from "../../services/areneRules.js";
import { formatDie } from "../../services/dices.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

const ARENE_COLOR = 0x2f6fd6;
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Ses propres dés en bleu, ceux de l'adversaire en rouge (code couleur de
// Clash Royale)
const MOI = "bleu";
const ADV = "rouge";
const CASE_VIDE = "⬛";
// Libellé du bouton et position dans les récits (« Tu poses 5 à gauche »)
const COLONNES = [
  { nom: "Gauche", lieu: "à gauche" },
  { nom: "Centre", lieu: "au centre" },
  { nom: "Droite", lieu: "à droite" },
];

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
    console.error("[Arene] Échec PATCH:", err.message);
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
      console.warn(`[Arene] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Arene] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

// Désignation de l'adversaire dans les textes : Kévina (le bot) ou un joueur.
const BOT = { Sujet: "Kévina", de: "de Kévina", emoji: "🤖" };

function nomsJoueur(pseudo) {
  const elision = /^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo);
  return { Sujet: pseudo, de: `${elision ? "d'" : "de "}${pseudo}`, emoji: "⚔️" };
}

// Adversaire du siège `moi` dans une partie 1v1.
function nomsAdv(partie, moi) {
  return nomsJoueur(partie.noms[partie.sieges[adversaire(moi)]] ?? "?");
}

// Lignes d'une grille, en titre H1 (plus grande taille d'emoji possible).
// Chaque grille se remplit depuis le centre du plateau : celle du haut est
// lue à l'envers.
function lignesGrille(grille, couleur, { haut = false } = {}) {
  const rangs = haut ? [2, 1, 0] : [0, 1, 2];
  return rangs.map(
    (r) =>
      `# ${grille.map((col) => (col[r] ? formatDie(col[r], couleur) : CASE_VIDE)).join(" ")}`,
  );
}

function ligneScores(nom, grille) {
  const detail = grille.map((col) => scoreColonne(col)).join(" · ");
  return `**${nom} : ${scoreGrille(grille)} pts** (${detail})`;
}

// Plateau vu par le siège `moi` : l'adversaire en haut (rouge), soi en bas
// (bleu). `noms` : { moi, adv } libellés des deux camps.
function plateau(d, moi, noms) {
  const adv = adversaire(moi);
  return [
    ligneScores(noms.adv, d.grilles[adv]),
    ...lignesGrille(d.grilles[adv], ADV, { haut: true }),
    "",
    ...lignesGrille(d.grilles[moi], MOI),
    ligneScores(noms.moi, d.grilles[moi]),
  ];
}

// Plateau neutre (message public) : premier joueur en bas, en bleu.
function plateauPublic(d, nomJoueur, nomBot) {
  return plateau(d, "joueur", { moi: nomJoueur, adv: nomBot });
}

// Récit d'un coup : « Tu poses un 5 au centre et détruis 2 dés de Kévina ! »
const desDetruits = (n, de) => (n > 1 ? `${n} dés ${de}` : `un dé ${de}`);

function monCoup(coup, A) {
  const fin = coup.desDetruits ? ` et détruis ${desDetruits(coup.desDetruits, A.de)} !` : ".";
  return `Tu poses ${formatDie(coup.valeur, MOI)} ${COLONNES[coup.colonne].lieu}${fin}`;
}

function coupAdverse(coup, A) {
  const fin = coup.desDetruits
    ? ` et détruit ${coup.desDetruits > 1 ? `${coup.desDetruits} de tes dés` : "un de tes dés"} !`
    : ".";
  return `${A.Sujet} pose ${formatDie(coup.valeur, ADV)} ${COLONNES[coup.colonne].lieu}${fin}`;
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
  custom_id: "areneduel_regles",
};

const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];

function titreFin(d, moi, A, raison) {
  const s = { moi: scoreGrille(d.grilles[moi]), adv: scoreGrille(d.grilles[adversaire(moi)]) };
  if (d.gagnant === "nul") return `🤝 Match nul (${s.moi} à ${s.adv})`;
  if (raison === "delai") {
    return d.gagnant === moi ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.` : "💀 Défaite… tu n'as pas joué à temps.";
  }
  return d.gagnant === moi ? `🏆 Victoire ${s.moi} à ${s.adv} !` : `💀 Défaite ${s.moi} à ${s.adv}…`;
}

// Vue d'un joueur : résultat de la dernière action (`texte`), plateau, dé à
// poser et une colonne par bouton (à son tour), attente (1v1) ou résultat.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison }
function buildVue(d, { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null } = {}) {
  const monTour = !d.termine && d.actif === moi;
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...plateau(d, moi, { moi: "Toi", adv: `${A.emoji} ${A.Sujet}` }),
    "",
    ...(d.termine
      ? []
      : monTour
        ? [`# Ton dé : ${formatDie(d.de, MOI)}`]
        : [`⏳ Au tour ${A.de}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
  ];
  const titre = d.termine
    ? `🏟️ Arène · ${titreFin(d, moi, A, raison)}`
    : `🏟️ Arène · ${pvp ? (monTour ? "À toi !" : `contre ${A.Sujet}`) : "contre Kévina"}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: ARENE_COLOR };
  if (!monTour) return { embeds: [embed], components: boutonsFin() };
  const sfx = pvp ? ":pvp" : "";
  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: COLONNES.map((col, c) => ({
          type: 2,
          style: 1,
          label: col.nom,
          custom_id: `areneduel_poser:${c}${sfx}`,
          disabled: d.grilles[moi][c].length >= HAUTEUR,
        })),
      },
      { type: 1, components: [BOUTON_REGLES] },
    ],
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de l'Arène",
    description: [
      "Chaque joueur a 3 colonnes de 3 cases (gauche, centre, droite). Tes dés sont bleus, ceux de ton adversaire rouges.",
      "",
      "**🎲 À ton tour** : un dé est lancé pour toi, pose-le dans une de tes colonnes non pleines.",
      "**✖️ Combos** : dans une colonne, des dés identiques se multiplient. Chaque valeur compte valeur × nombre de dés × nombre de dés : deux 4 valent (4 + 4) × 2 = 16, trois 3 valent 9 × 3 = 27.",
      "**💥 Destruction** : poser un dé détruit tous les dés de même valeur dans la colonne d'en face de ton adversaire.",
      "**🏁 Fin** : dès qu'une grille est pleine. Le plus haut total gagne.",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: ARENE_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

function actionPoser(d, moi, colonne, A) {
  const r = poser(d, moi, colonne);
  if (r.erreur) {
    return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : "pleine" };
  }
  return { texte: monCoup(r, A) };
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleAreneRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Lance une nouvelle partie (remplace une éventuelle partie en cours).
export async function handleAreneCommand(webhookUrl, discordId) {
  try {
    const { duel } = await nouveauDuel(discordId);
    await patchOriginal(webhookUrl, buildVue(duel, { texte: "Nouvelle partie contre Kévina ! Tu commences." }));
  } catch (err) {
    console.error("[Arene] Échec lancement:", err.message);
  }
}

// Fin d'une partie contre Kévina : message public (non éphémère) dans le
// salon, plateau final compris. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo) {
  const sj = scoreGrille(d.grilles.joueur);
  const sb = scoreGrille(d.grilles.bot);
  const resultat =
    d.gagnant === "nul"
      ? `🤝 Match nul entre ${pseudo} et Kévina (${sj} à ${sb}).`
      : d.gagnant === "joueur"
        ? `🏆 ${pseudo} bat Kévina ${sj} à ${sb} !`
        : `🤖 Kévina bat ${pseudo} ${sb} à ${sj}.`;
  return {
    embeds: [
      {
        title: "🏟️ Arène · contre Kévina",
        description: [resultat, "", ...plateauPublic(d, pseudo, "🤖 Kévina")].join("\n").slice(0, 4096),
        color: ARENE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

async function executerSolo(webhookUrl, discordId, colonne, { channelId, pseudo } = {}) {
  const { duel, resultat } = await agirDuel(discordId, (d) => {
    const r = actionPoser(d, "joueur", colonne, BOT);
    if (r.erreur) return r;
    const lignes = [r.texte];
    // Kévina pose son dé aussitôt
    if (!d.termine && d.actif === "bot") {
      poser(d, "bot", choixGlouton(d, "bot"));
      lignes.push(coupAdverse(d.dernier, BOT));
    }
    return { texte: lignes.join("\n"), vientDeFinir: d.termine };
  });
  if (!duel) {
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/arene` !",
          color: ARENE_COLOR,
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
          title: "🏟️ Arène · 1v1",
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: ARENE_COLOR,
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
  emoji: { name: "🏟️" },
  custom_id: "areneduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, délai).
function messagePublic(partie, config) {
  const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: "🏟️ Arène · 1v1",
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: ARENE_COLOR,
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
        title: `🏟️ Arène · ${nom("joueur")} contre ${nom("bot")}`,
        description: [
          ...plateauPublic(d, nom("joueur"), nom("bot")),
          "",
          `Au tour de **${nom(d.actif)}**, limite <t:${echeanceDe(partie, config)}:R>`,
          "Joueurs : clique sur **Jouer** pour afficher ta vue.",
        ].join("\n").slice(0, 4096),
        color: ARENE_COLOR,
      },
    ],
    components,
  };
}

// Fin du 1v1 : récapitulatif dans un NOUVEAU message (visible en bas du
// salon), puis suppression du message de la partie (comme Bang! Duel).
function messageFinal(partie) {
  const d = partie.duel;
  // Pseudos en clair, jamais de mention (pas de ping)
  const nom = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const s = { joueur: scoreGrille(d.grilles.joueur), bot: scoreGrille(d.grilles.bot) };
  const g = d.gagnant;
  const resultat =
    g === "nul"
      ? `🤝 Match nul entre ${nom("joueur")} et ${nom("bot")} (${s.joueur} à ${s.bot}).`
      : partie.raisonFin === "delai"
        ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
        : `🏆 ${nom(g)} bat ${nom(adversaire(g))} ${s[g]} à ${s[adversaire(g)]} !`;
  return {
    embeds: [
      {
        title: "🏟️ Arène · 1v1",
        description: [resultat, "", ...plateauPublic(d, nom("joueur"), nom("bot"))].join("\n").slice(0, 4096),
        color: ARENE_COLOR,
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
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/arene` (1v1) !",
      color: ARENE_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/arene adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleArenePvpCommand(webhookUrl, body) {
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
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, "🏟️ Défi lancé dans le salon !"));
  } catch (err) {
    console.error("[Arene] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [🏟️ Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour).
export async function handleAreneOuvrir(webhookUrl, body) {
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/arene\` (1v1) une fois qu'il est terminé !`,
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
    console.error("[Arene] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, colonne) {
  const { partie, config, resultat } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const r = actionPoser(p.duel, moi, colonne, nomsAdv(p, moi));
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

export async function handleArenePoser(webhookUrl, discordId, colonne, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (pvp) await executerPvp(webhookUrl, discordId, colonne);
    else await executerSolo(webhookUrl, discordId, colonne, { channelId, pseudo });
  } catch (err) {
    console.error("[Arene] Échec poser:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleAreneRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Arene] Échec Règles:", err.message);
  }
}
