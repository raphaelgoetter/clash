// ============================================================
// grilleDuel.js (handler) — La Grille (`/grille`), deux modes :
// - contre Kévina, le bot (`/grille adversaire:bot`) : plateau public
//   dans le salon (suivi par tous) et vue éphémère du joueur (plateau et
//   boutons), édités en place à chaque coup ; Kévina pose son dé aussitôt
//   après le joueur ; résultat publié dans un nouveau message en fin de
//   partie ;
// - 1v1 (`/grille adversaire:1v1`) : message public dans le salon (bouton
//   Jouer dans le lobby seulement : rejoindre ; plateaux visibles de tous) et
//   une vue éphémère par joueur, rééditée après chaque coup adverse (webhook
//   mémorisé, valable 15 min, renouvelé à chaque coup du joueur). Une seule partie à la
//   fois, comme Bang! Duel.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : grilleduel_poser:<colonne> (contre Kévina),
// grilleduel_poser:<colonne>:pvp (1v1), grilleduel_ouvrir (bouton Jouer du
// message public), grilleduel_regles.
//
// Service : jeux/services/grilleDuel.js (Redis),
// règles : jeux/services/grilleRules.js.
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  INACTIVITE_SECONDES,
  loadDuelConfig,
  majHighScore,
  nouveauDuel,
  ouvrirPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/grilleDuel.js";
import {
  HAUTEUR,
  adversaire,
  choixGlouton,
  poser,
  scoreColonne,
  scoreGrille,
} from "../../services/grilleRules.js";
import { formatDie } from "../../services/dices.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

const GRILLE_COLOR = 0x2f6fd6;
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

// Ses propres dés en bleu, ceux de l'adversaire en rouge (code couleur de
// Clash Royale)
const MOI = "bleu";
const ADV = "rouge";
const CASE_VIDE = "⬛";
// Même emoji que le high score du Gobelet Duel
const EMOJI_HIGHSCORE = "<:topplayers:1563107730397601792>";
// Dés détruits : affichés 💥, encore à leur place, le temps d'une étape
// avant leur disparition (plus lisible qu'un effacement brutal)
const EXPLOSION = "💥";
const DELAI_EXPLOSION_MS = 900;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Contre Kévina : délai avant d'afficher son coup (elle joue en quelques
// millisecondes, un coup instantané paraît mécanique), durée tirée au sort
// (comme Quatre à la suite)
const REFLEXION_MS = { min: 2000, max: 5000 };
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

// Message visé : la réponse de l'interaction (`@original`), ou un followup
// si l'URL mémorisée désigne déjà un message (`…/messages/<id>`).
const urlMessage = (webhookUrl) => (webhookUrl.includes("/messages/") ? webhookUrl : `${webhookUrl}/messages/@original`);

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(urlMessage(webhookUrl), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "",
        embeds: [],
        components: [],
        ...payload,
      }),
    });
    // Refus de Discord (vue invalide, jeton expiré) : sinon le clic reste sans effet visible
    if (!res.ok) console.error(`[Grille] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Grille] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère de l'interaction. Vrai si c'est fait.
async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(urlMessage(webhookUrl), { method: "DELETE" });
    return res.ok;
  } catch (err) {
    console.error("[Grille] Échec DELETE:", err.message);
    return false;
  }
}

// Nouveau message éphémère de l'interaction (followup), posté après les
// messages déjà présents. Renvoie l'URL du followup (à mémoriser pour
// l'éditer), null en cas d'échec.
async function envoyerEphemere(webhookUrl, payload) {
  if (!webhookUrl) return null;
  try {
    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, flags: 64 }),
    });
    if (!res.ok) {
      console.error(`[Grille] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Grille] Échec followup:", err.message);
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
        ? { body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }) }
        : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[Grille] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Grille] Erreur réseau (${method} message public):`, err.message);
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

// Lignes d'une grille, en titre H1 (plus grande taille d'emoji possible),
// H3 dans les messages publics (dés un tiers plus petits). Chaque grille se
// remplit depuis le centre du plateau : celle du haut est lue à l'envers.
function lignesGrille(grille, couleur, { haut = false, titre = "#" } = {}) {
  const rangs = haut ? [2, 1, 0] : [0, 1, 2];
  return rangs.map(
    (r) =>
      `${titre} ${grille.map((col) => (col[r] === EXPLOSION ? EXPLOSION : col[r] ? formatDie(col[r], couleur) : CASE_VIDE)).join(" ")}`,
  );
}

function ligneScores(nom, grilleAffichee) {
  // Dés en explosion déjà hors du score
  const grille = grilleAffichee.map((col) => col.filter((v) => v !== EXPLOSION));
  const detail = grille.map((col) => scoreColonne(col)).join(" · ");
  return `**${nom} : ${scoreGrille(grille)} pts** (${detail})`;
}

// Plateau vu par le siège `moi` : l'adversaire en haut (rouge), soi en bas
// (bleu). `noms` : { moi, adv } libellés des deux camps, `titre` : niveau
// de titre des rangées.
function plateau(d, moi, noms, titre = "#") {
  const adv = adversaire(moi);
  return [
    ligneScores(noms.adv, d.grilles[adv]),
    ...lignesGrille(d.grilles[adv], ADV, { haut: true, titre }),
    "",
    ...lignesGrille(d.grilles[moi], MOI, { titre }),
    ligneScores(noms.moi, d.grilles[moi]),
  ];
}

// Plateau neutre (message public) : premier joueur en bas, en bleu, dés
// plus petits que dans la vue du joueur.
function plateauPublic(d, nomJoueur, nomBot) {
  return plateau(d, "joueur", { moi: nomJoueur, adv: nomBot }, "###");
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
  custom_id: "grilleduel_regles",
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

// Vue de fin : une phrase seulement, le plateau final et les scores sont
// déjà dans le message public posté au même moment.
function vueFin(d, { moi, A, raison }) {
  const fin =
    raison === "delai"
      ? d.gagnant === moi
        ? `${A.Sujet} n'a pas joué à temps.`
        : "Tu n'as pas joué à temps."
      : d.dernier?.id === moi
        ? "Tu poses le dernier dé et remplis ta grille."
        : `${A.Sujet} pose le dernier dé et remplit sa grille.`;
  const issue =
    d.gagnant === "nul"
      ? "c'est un match nul."
      : d.gagnant === moi
        ? "c'est une victoire pour toi !"
        : "c'est une défaite pour toi…";
  return {
    embeds: [
      {
        title: `▦ La Grille · ${titreFin(d, moi, A, raison)}`,
        description: `${fin} La partie est terminée, et ${issue}`,
        color: GRILLE_COLOR,
      },
    ],
    // Pas de bouton Règles : celui du message public posté au même moment suffit
    components: [],
  };
}

// Vue d'un joueur : résultat de la dernière action (`texte`), plateau, dé à
// poser et une colonne par bouton (à son tour), attente (1v1) ou fin.
// `ctx` : { moi (siège du moteur), A (adversaire), pvp, echeance, raison,
// grilles (étape d'explosion : plateau affiché à la place de d.grilles,
// dé à poser masqué et boutons grisés) }
function buildVue(
  d,
  { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null, grilles = null } = {},
) {
  if (d.termine) return vueFin(d, { moi, A, raison });
  const monTour = d.actif === moi;
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...plateau(grilles ? { ...d, grilles } : d, moi, { moi: "Toi", adv: `${A.emoji} ${A.Sujet}` }),
    "",
    ...(monTour
      ? [`# Ton dé : ${grilles ? "⏳" : formatDie(d.de, MOI)}`]
      : [
          `⏳ Au tour ${A.de}${echeance ? `, limite <t:${echeance}:R>` : ""}.`,
          // Dé adverse connu avant qu'il ne le pose (comme la carte dans Punto)
          ...(d.de && !grilles ? [`Dé ${A.de} : ${formatDie(d.de, ADV)}`] : []),
        ]),
  ];
  const titre = `▦ La Grille · ${pvp ? (monTour ? "À toi !" : `contre ${A.Sujet}`) : "contre Kévina"}`;
  const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), color: GRILLE_COLOR };
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
          custom_id: `grilleduel_poser:${c}${sfx}`,
          disabled: Boolean(grilles) || d.grilles[moi][c].length >= HAUTEUR,
        })),
      },
      { type: 1, components: [BOUTON_REGLES] },
    ],
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de La Grille",
    description: [
      "Chaque joueur a 3 colonnes de 3 cases (gauche, centre, droite). Tes dés sont bleus, ceux de ton adversaire rouges.",
      "",
      "**🎲 À ton tour** : un dé est lancé pour toi, pose-le dans une de tes colonnes non pleines.",
      "**✖️ Combos** : dans une colonne, des dés identiques se multiplient. Chaque valeur compte valeur × nombre de dés × nombre de dés : deux 4 valent (4 + 4) × 2 = 16, trois 3 valent 9 × 3 = 27.",
      "**💥 Destruction** : poser un dé détruit tous les dés de même valeur dans la colonne d'en face de ton adversaire. Les dés restants se resserrent vers le centre.",
      "**🏁 Fin** : dès qu'une grille est pleine. Le plus haut total gagne.",
      "",
      `⏰ En 1v1 : ${plural(config.delai_tour_minutes, "minute")} par coup, sinon défaite. Sans action pendant 1 h, la partie est abandonnée.`,
    ].join("\n"),
    color: GRILLE_COLOR,
  };
}

// ── Coups (communs aux deux modes) ───────────────────────────────────

// Pose le dé de `id` ; si des dés adverses sont détruits, `explosion` donne
// les grilles de l'étape intermédiaire (dés détruits en 💥, à leur place).
function poserAvecExplosion(d, id, colonne) {
  const cible = d.grilles[adversaire(id)][colonne];
  const avant = Array.isArray(cible) ? [...cible] : [];
  const r = poser(d, id, colonne);
  if (r.erreur || !r.desDetruits) return { r, explosion: null };
  const explosion = structuredClone(d.grilles);
  explosion[adversaire(id)][colonne] = avant.map((v) => (v === r.valeur ? EXPLOSION : v));
  return { r, explosion };
}

function actionPoser(d, moi, colonne, A) {
  const { r, explosion } = poserAvecExplosion(d, moi, colonne);
  if (r.erreur) {
    return { erreur: d.termine ? "termine" : d.actif !== moi ? "pasTonTour" : "pleine" };
  }
  return { texte: monCoup(r, A), explosion };
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleGrilleRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Plateau public d'une partie contre Kévina, en cours : suivi par le salon,
// le joueur joue depuis sa vue éphémère. `etape` : { grilles (explosion),
// actif (joueur au trait à cette étape) }. Expiration rappelée, sinon le
// message d'une partie abandonnée resterait figé sur « Au tour de X ».
function messageSolo(d, pseudo, { grilles = null, actif = d.actif } = {}) {
  const expiration = Math.floor(Date.now() / 1000) + INACTIVITE_SECONDES;
  return {
    embeds: [
      {
        title: `▦ La Grille · ${pseudo} contre Kévina`,
        description: [
          actif === "bot"
            ? `⏳ Kévina réfléchit…${d.de && !grilles ? ` Dé à poser : ${formatDie(d.de, ADV)}` : ""}`
            : `Au tour de **${pseudo}**${grilles ? "." : `, dé à poser : ${formatDie(d.de, MOI)}`}`,
          "",
          ...plateauPublic(grilles ? { ...d, grilles } : d, pseudo, "🤖 Kévina"),
          "",
          `⏰ Sans action, partie abandonnée <t:${expiration}:R>.`,
        ]
          .join("\n")
          .slice(0, 4096),
        color: GRILLE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Édite le plateau public (partie lancée avant ce message : rien).
async function majSalonSolo(d, pseudo, etape) {
  if (d.salon) await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, messageSolo(d, pseudo ?? "?", etape));
}

// Lance une nouvelle partie (remplace une éventuelle partie en cours) :
// plateau public dans le salon, puis vue éphémère du joueur EN DESSOUS. La
// réponse différée, créée dès la commande (au-dessus du plateau), est
// supprimée et la vue renvoyée en followup ; les clics éditent ensuite ce
// followup (message du bouton). Repli : vue dans la réponse différée.
export async function handleGrilleCommand(webhookUrl, body) {
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
    const vue = buildVue(enregistre?.duel ?? duel, { texte: "Nouvelle partie contre Kévina ! Tu commences." });
    if (enregistre && (await supprimerOriginal(webhookUrl)) && (await envoyerEphemere(webhookUrl, vue))) return;
    await patchOriginal(webhookUrl, vue);
  } catch (err) {
    console.error("[Grille] Échec lancement:", err.message);
  }
}

// Fin sur grille pleine, pour les messages publics : « Kévina pose le
// dernier dé, remplit sa grille et bat X 63 à 41 ». `nom(siege)` : libellé.
function recitFin(d, nom) {
  const auteur = d.dernier?.id ?? "joueur";
  const fin = `${nom(auteur)} pose le dernier dé, remplit sa grille`;
  const s = (siege) => scoreGrille(d.grilles[siege]);
  const g = d.gagnant;
  if (g === "nul") return `${fin} : match nul (${s("joueur")} à ${s("bot")})`;
  const issue = g === auteur ? ` et bat ${nom(adversaire(g))}` : `, mais ${nom(g)} gagne`;
  return `${fin}${issue} ${s(g)} à ${s(adversaire(g))}`;
}

// Fin d'une partie contre Kévina : message public (non éphémère) dans le
// salon, plateau final compris, seul message de fin (la vue éphémère est
// supprimée), high score compris. Pseudo en clair, jamais de mention.
function messageFinalSolo(d, pseudo, highScore = null) {
  const recit = recitFin(d, (siege) => (siege === "bot" ? "Kévina" : pseudo));
  const resultat =
    d.gagnant === "nul" ? `🤝 ${recit}.` : d.gagnant === "joueur" ? `🏆 ${recit} !` : `🤖 ${recit}.`;
  return {
    embeds: [
      {
        title: `▦ La Grille · ${pseudo} contre Kévina`,
        description: [
          resultat,
          "",
          ...plateauPublic(d, pseudo, "🤖 Kévina"),
          ...(highScore ? ["", `${EMOJI_HIGHSCORE} High score : ${highScore.username ?? "?"} (${plural(highScore.points, "pt")})`] : []),
        ].join("\n").slice(0, 4096),
        color: GRILLE_COLOR,
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
    // Étapes avant la vue finale : explosion du coup du joueur, réflexion
    // de Kévina (plateau après le coup du joueur, puis attente), explosion de son coup
    // (vue de fin sans plateau : aucune étape quand le coup du joueur
    // termine la partie, pas d'explosion quand celui de Kévina la termine)
    const etapes = r.explosion && !d.termine ? [{ texte: r.texte, grilles: r.explosion, actif: d.actif }] : [];
    // Kévina joue dans la foulée (sous le même verrou), son coup n'est
    // affiché qu'après sa réflexion
    if (!d.termine && d.actif === "bot") {
      etapes.push({ reflexion: true, texte: r.texte, duel: structuredClone(d) });
      const { explosion } = poserAvecExplosion(d, "bot", choixGlouton(d, "bot"));
      lignes.push(coupAdverse(d.dernier, BOT));
      if (explosion && !d.termine) etapes.push({ texte: lignes.join("\n"), grilles: explosion, actif: d.actif });
    }
    return { texte: lignes.join("\n"), vientDeFinir: d.termine, etapes };
  });
  if (!duel) {
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          description: "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/grille` !",
          color: GRILLE_COLOR,
        },
      ],
      components: boutonsFin(),
    });
    return;
  }
  for (const etape of resultat.etapes ?? []) {
    if (etape.reflexion) {
      // Coup du joueur affiché d'abord, celui de Kévina après sa réflexion
      await Promise.all([
        patchOriginal(webhookUrl, buildVue(etape.duel, { texte: etape.texte })),
        majSalonSolo(etape.duel, pseudo),
      ]);
      await pause(REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min));
      continue;
    }
    await Promise.all([patchOriginal(webhookUrl, buildVue(duel, etape)), majSalonSolo(duel, pseudo, etape)]);
    await pause(DELAI_EXPLOSION_MS);
  }
  if (resultat.vientDeFinir) {
    // Récapitulatif dans un NOUVEAU message (visible en bas du salon),
    // plateau public supprimé (repli : édité en récapitulatif), vue
    // éphémère supprimée (repli : vue de fin)
    const highScore = await majHighScore(discordId, pseudo, scoreGrille(duel.grilles.joueur));
    const final = messageFinalSolo(duel, pseudo ?? "?", highScore);
    const { salon } = duel;
    const ok = await messageSalon("POST", salon?.channelId ?? channelId, null, final);
    if (salon) {
      if (ok) await messageSalon("DELETE", salon.channelId, salon.messageId);
      else await messageSalon("PATCH", salon.channelId, salon.messageId, final);
    }
    if (ok && (await supprimerOriginal(webhookUrl))) return;
  }
  await Promise.all([
    patchOriginal(webhookUrl, buildVue(duel, { texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte })),
    // Fin (repli) : plateau public déjà remplacé par le récapitulatif
    ...(resultat.erreur || duel.termine ? [] : [majSalonSolo(duel, pseudo)]),
  ]);
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
// dernier coup adverse est raconté. `grilles` : étape d'explosion.
function vuePvp(partie, config, discordId, texte = null, grilles = null) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: "▦ La Grille · 1v1",
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: GRILLE_COLOR,
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
    grilles,
  });
}

const BOUTON_JOUER = {
  type: 2,
  style: 3,
  // ▦ n'est pas un emoji Discord : refusé comme icône de bouton
  label: "Jouer",
  custom_id: "grilleduel_ouvrir",
};

// Message public : lobby, puis plateau en direct (au tour de qui, délai,
// plateau neutre à petits dés, explosions comprises).
function messagePublic(partie, config, grilles = null) {
  if (partie.statut === "lobby") {
    const components = [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }];
    return {
      embeds: [
        {
          title: "▦ La Grille · 1v1",
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: GRILLE_COLOR,
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
        title: `▦ La Grille · ${nom("joueur")} contre ${nom("bot")}`,
        // Plateau neutre à petits dés, suivi par le salon ; chaque joueur
        // joue depuis sa vue éphémère
        description: [
          `Au tour de **${nom(d.actif)}**${grilles ? "" : `, dé à poser : ${formatDie(d.de, d.actif === "joueur" ? MOI : ADV)}`}, limite <t:${echeanceDe(partie, config)}:R>`,
          "",
          ...plateauPublic(grilles ? { ...d, grilles } : d, nom("joueur"), nom("bot")),
        ].join("\n").slice(0, 4096),
        color: GRILLE_COLOR,
      },
    ],
    // Partie lancée : Jouer retiré, on joue depuis sa vue éphémère
    components: boutonsFin(),
  };
}

// Fin du 1v1 : récapitulatif dans un NOUVEAU message (visible en bas du
// salon), puis suppression du message de la partie (comme Bang! Duel).
// Titre de fin du 1v1 : gagnant en premier (ordre des sièges si match nul)
const titreGagnant = (g, nom) =>
  g === "nul" ? `${nom("joueur")} contre ${nom("bot")}` : `${nom(g)} contre ${nom(adversaire(g))}`;

function messageFinal(partie) {
  const d = partie.duel;
  // Pseudos en clair, jamais de mention (pas de ping)
  const nom = (siege) => partie.noms?.[partie.sieges[siege]] ?? "?";
  const g = d.gagnant;
  const resultat =
    partie.raisonFin === "delai"
      ? `🏆 ${nom(g)} remporte le duel : ${nom(adversaire(g))} n'a pas joué à temps.`
      : g === "nul"
        ? `🤝 ${recitFin(d, nom)}.`
        : `🏆 ${recitFin(d, nom)} !`;
  return {
    embeds: [
      {
        title: `▦ La Grille · ${titreGagnant(g, nom)}`,
        description: [resultat, "", ...plateauPublic(d, nom("joueur"), nom("bot"))].join("\n").slice(0, 4096),
        color: GRILLE_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Après un coup : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public ; en fin de partie, récapitulatif seul (vues
// supprimées). Avec `explosion`
// (partie en cours), étape intermédiaire sur les deux vues d'abord.
async function diffuserPvp(partie, config, discordId, webhookUrl, texte, explosion = null) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  if (explosion && partie.statut === "enCours") {
    await Promise.all([
      patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte, explosion)),
      ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id, null, explosion))),
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
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/grille` (1v1) !",
      color: GRILLE_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/grille adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleGrillePvpCommand(webhookUrl, body) {
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
    const vue = vuePvp(r.partie, config, discordId, "▦ Défi lancé dans le salon !");
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, vue) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    // Adversaire arrivé entre-temps : sa diffusion n'a pas pu atteindre cette vue
    const aJour = partie && partie.statut !== "lobby" ? vuePvp(partie, config, discordId) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Grille] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour). L'ancienne vue du
// joueur est supprimée : seule la dernière est rééditée, une vue restée
// au-dessus afficherait sinon un tour figé.
export async function handleGrilleOuvrir(webhookUrl, body) {
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
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/grille\` (1v1) une fois qu'il est terminé !`,
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
    console.error("[Grille] Échec Jouer 1v1:", err.message);
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
    await diffuserPvp(partie, config, discordId, webhookUrl, texte, resultat.explosion);
    if (resultat.coup) await surveillerDelai(partie, config, discordId, webhookUrl);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte));
}

// ── Points d'entrée des composants ───────────────────────────────────

export async function handleGrillePoser(webhookUrl, discordId, colonne, { pvp = false, channelId, pseudo } = {}) {
  try {
    if (pvp) await executerPvp(webhookUrl, discordId, colonne);
    else await executerSolo(webhookUrl, discordId, colonne, { channelId, pseudo });
  } catch (err) {
    console.error("[Grille] Échec poser:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleGrilleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Grille] Échec Règles:", err.message);
  }
}
