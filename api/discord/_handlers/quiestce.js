// ============================================================
// quiestce.js — Handlers Discord de Qui est-ce ? (jeu spécial de 7 jours).
// Un seul message officiel par jour (questions du jour, classement, tableau
// de chasse, révélations), réédité en direct après chaque action, avec
// trois boutons, chacun en éphémère : Jouer (l'enquête : sa carte secrète,
// sa cible, ses indices, et trois menus édités en place : question du
// jour, accusation, objet), Règles et Journal (ce qui concerne le joueur).
// Fenêtre d'inscription (comme Goblin Hunters) : boutons S'inscrire, Se
// désinscrire et Règles, rappel quotidien, prolongation si l'effectif
// minimum n'est pas atteint.
//
// La publication/clôture quotidienne passe uniquement par
// scripts/postQuiEstCe.js (postQuiEstCe).
//
// ⚠️ Les cartes restent secrètes : seul l'éphémère montre au joueur sa
// carte et ses indices. Un démasquage est public (qui a démasqué qui), la
// carte démasquée ne l'est pas ; toutes les cartes sont révélées à la fin.
// ============================================================

import {
  loadQuiEstCeConfig,
  readState,
  writeState,
  readPartie,
  initPartie,
  demarrerPartie,
  agir,
  desinscrireJoueur,
  previewCloture,
  closeDayAndAdvance,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/quiestce.js";
import {
  QUESTIONS,
  OBJETS,
  nomCarte,
  chasseurs,
  ciblesDisponibles,
  choisirCible,
  points,
  candidats,
  questionsPossibles,
  questionsRestantes,
  accusationsRestantes,
  poser,
  accuser,
  etatObjet,
  utiliserObjet,
  classement,
  texteJournal,
} from "../../../backend/services/quiestceRules.js";
import { encodeGrille } from "../../../backend/services/quiestceImage.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const QEC_COLOR = 0x8e44ad;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const JOURNAL_AFFICHE = 10;
// Heure de la clôture quotidienne (cron quiestce.yml, 8h20 UTC)
const CLOTURE_UTC = [8, 20];

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/quiestce/illustration?v=${Date.now()}`;
}

async function grilleUrl(partie, barrees = []) {
  return `${TRUST_ROYALE_URL}/api/quiestce/grille?d=${await encodeGrille(partie.grille, barrees)}`;
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;
}

function heureCloture() {
  return formatUtcTimeAsParis(...CLOTURE_UTC);
}

function questionLabel(q) {
  return `${QUESTIONS[q].emoji} ${QUESTIONS[q].nom}`;
}

function objetLabel(o) {
  return `${OBJETS[o].emoji} ${OBJETS[o].nom}`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

function nbCartes(n) {
  return `${n} carte${n > 1 ? "s" : ""} découverte${n > 1 ? "s" : ""}`;
}

// ── Embeds publics ───────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatDateFr(iso) {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "long",
    timeStyle: "short",
  });
}

// Message d'inscription (ouverture, rappel quotidien, prolongation) :
// inscrits, effectif requis, date de clôture.
function buildAnnonceEmbed(
  config,
  partie,
  closingAt,
  { prolongee = false } = {},
) {
  const inscrits = Object.values(partie.joueurs)
    .sort((a, b) => a.arrivee - b.arrivee)
    .map((j) => j.username);
  return {
    title: prolongee
      ? "🕵️ Qui est-ce ? (inscriptions prolongées)"
      : "🕵️ Qui est-ce ?",
    description: [
      ...(prolongee
        ? [
            `Seulement **${inscrits.length}** joueur${inscrits.length > 1 ? "s" : ""} inscrit${inscrits.length > 1 ? "s" : ""}, il en faut au moins **${config.effectif_min}** pour lancer la partie. Les inscriptions sont prolongées, parles-en autour de toi !`,
            "",
          ]
        : []),
      "Chaque joueur reçoit en secret **une carte Clash Royale**. Démasque celles des autres, une question par jour, avant qu'on ne démasque la tienne !",
      "",
      `📅 **${config.duree_jours} jours de jeu**, 1 question par jour. Effectif requis : **${config.effectif_min} à ${config.effectif_max} joueurs**.`,
      "",
      "Merci de t'inscrire uniquement si tu es sûr de pouvoir participer chaque jour au jeu, pour ne pas pénaliser les autres.",
      ...(inscrits.length
        ? [
            "",
            `**✋ Inscrits (${inscrits.length}/${config.effectif_max})**`,
            inscrits.join(" · "),
          ]
        : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: QEC_COLOR,
    image: { url: illustrationUrl() },
    footer: {
      text: `${prolongee ? "Nouvelle clôture" : "Clôture des inscriptions"} : ${formatDateFr(closingAt)}.`,
    },
  };
}

const INTRO_J1 =
  "Les cartes secrètes sont distribuées et chacun a reçu une première cible.";

function bilanVeilleLignes(partie) {
  const v = partie.veille;
  const n = (id) => `**${partie.joueurs[id]?.username ?? "?"}**`;
  const lignes = v.demasquages.length
    ? v.demasquages.map((d) => `🎯 ${n(d.s)} a démasqué ${n(d.v)}.`)
    : ["🎯 Personne n'a été démasqué."];
  if (v.desamorcages)
    lignes.push(`🧨 ${plural(v.desamorcages, "Désamorçage")}.`);
  if (v.deguisements)
    lignes.push(`🎭 ${plural(v.deguisements, "Déguisement")}.`);
  if (v.brouillards) lignes.push(`🌫️ ${plural(v.brouillards, "Brouillard")}.`);
  if (v.erreurs)
    lignes.push(
      `❌ ${plural(v.erreurs, "accusation")} ratée${v.erreurs > 1 ? "s" : ""}.`,
    );
  return lignes;
}

// Tableau de chasse, lu du point de vue du chasseur : « **Chasseur** →
// cible (questions posées) », trié par cible (les chasseurs d'une même
// cible côte à côte), 🌫️ pour une cible sous Brouillard, puis les joueurs
// sans cible et ceux que personne ne chasse.
function tableauChasseLignes(partie) {
  const joueurs = Object.entries(partie.joueurs).filter(([, j]) => j.carte);
  const lignes = joueurs
    .filter(([, j]) => j.cible)
    .sort(
      ([, a], [, b]) =>
        partie.joueurs[a.cible].username.localeCompare(
          partie.joueurs[b.cible].username,
        ) || a.username.localeCompare(b.username),
    )
    .map(([, j]) => {
      const c = partie.joueurs[j.cible];
      return `**${j.username}** → ${c.username}${c.brouillard ? " 🌫️" : ""} (${j.enquete.posees} ❓)`;
    });
  const sansCible = joueurs
    .filter(([, j]) => !j.cible)
    .map(([, j]) => j.username);
  if (sansCible.length)
    lignes.push(`En attente d'une cible : ${sansCible.join(", ")}`);
  const libres = joueurs
    .filter(([id]) => !chasseurs(partie, id).length)
    .map(([, j]) => j.username);
  if (libres.length)
    lignes.push(`Personne ne les chasse : ${libres.join(", ")}`);
  return lignes;
}

// Message officiel du jour : intro (J1) ou bilan de la veille, classement,
// tableau de chasse, faits du jour (les questions du jour sont dans
// l'enquête de chacun).
async function buildTableEmbed(jour, config, partie) {
  const lignes =
    jour === 1 || !partie.veille
      ? [INTRO_J1]
      : ["**📰 Hier**", ...bilanVeilleLignes(partie)];
  const ranking = classement(partie).filter(
    (r) => r.decouvertes || r.nbDemasque,
  );
  if (ranking.length) {
    lignes.push(
      "",
      "**🏆 Classement**",
      ...ranking
        .slice(0, 10)
        .map(
          (r, i) =>
            `${MEDALS[i] || `${i + 1}.`} **${r.username}** : ${plural(r.score, "pt")}`,
        ),
    );
  }
  const chasse = tableauChasseLignes(partie);
  if (chasse.length)
    lignes.push("", "**🎯 Tableau de chasse** (chasseur → cible)", ...chasse);
  const cruciaux = partie.journal
    .filter((e) => e.c && e.j === (partie.numeroJour ?? jour))
    .slice(-JOURNAL_AFFICHE);
  if (cruciaux.length)
    lignes.push(
      "",
      "**💥 Aujourd'hui**",
      ...cruciaux.map((e) => texteJournal(partie, e)),
    );
  return {
    title: `🕵️ Qui est-ce ? (Jour ${jour}/${config.duree_jours})`,
    description: lignes.join("\n").slice(0, 4096),
    color: QEC_COLOR,
    image: partie.grille.length ? { url: await grilleUrl(partie) } : undefined,
    footer: {
      text: `Nouvelles questions et nouvel objet chaque jour à ${heureCloture()}.`,
    },
  };
}

function formatMancheLine(record, isCurrent) {
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `Manche ${record.manche} : vainqueur **${record.vainqueur}** (${plural(record.scoreGagnant, "pt")}, ${plural(record.nbJoueurs, "joueur")})${suffix}`;
}

async function buildFinEmbed(ranking, partie, manches, currentManche) {
  const top = ranking[0];
  const titre = top
    ? `👑 **${top.username}** remporte la partie avec ${plural(top.score, "pt")} !`
    : "Personne n'a participé.";
  return {
    title: "🏆 Qui est-ce ? Partie terminée !",
    description: [
      titre,
      "",
      "**Classement final**",
      // Tous les joueurs (18 au plus) : chacun voit ses cartes révélées
      ...ranking.map(
        (r, i) =>
          `${MEDALS[i] || `${i + 1}.`} **${r.username}** : ${plural(r.score, "pt")} (${r.cartes.map((k) => nomCarte(partie, k)).join(", ")})`,
      ),
      ...(manches.length
        ? [
            "",
            "**📊 Manches précédentes**",
            ...manches.map((m) =>
              formatMancheLine(m, m.manche === currentManche),
            ),
          ]
        : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: 0xf1c40f,
    image: { url: illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  const n = config.pool["1"]?.length ?? 3;
  const objets = (famille) =>
    Object.keys(OBJETS)
      .filter((o) => OBJETS[o].famille === famille)
      .map(
        (o) =>
          `- ${objetLabel(o)} : ${OBJETS[o].effet.charAt(0).toLowerCase()}${OBJETS[o].effet.slice(1)}`,
      );
  return {
    title: "📖 Règles : Qui est-ce ?",
    description: [
      "Démasque les cartes secrètes des autres joueurs, avant qu'on ne démasque la tienne !",
      "",
      "**🗓️ Chaque jour**",
      `- 🔎 **${plural(config.questions_par_jour, "question")}** sur ta cible, parmi les ${n} questions du jour (${n + 1} avec la Loupe).`,
      "- 🎯 **1 accusation** si tu penses avoir trouvé sa carte.",
      `- 🎁 **1 objet** gratuit tiré au hasard (${config.inventaire_max} en réserve au plus, 1 utilisé par jour).`,
      "",
      "**🏆 Points**",
      `- Accusation juste : **+${config.points_carte} points**, puis tu choisis ta prochaine cible.`,
      `- Efficacité : **+${config.bonus_efficacite.join("/+")}** si tu démasques avec ${config.bonus_efficacite.map((_, i) => i + 1).join("/")} indices (indice de départ compris).`,
      `- Survie : **+${config.bonus_survie_jour}** par jour joué sans être démasqué.`,
      `- Être démasqué : **-${config.malus_demasque} points**.`,
      "- Accusation ratée : la carte est barrée de ta fiche.",
      "",
      "**👀 Cibles**",
      "- La première est tirée au sort, les suivantes sont choisies (le meneur t'est proposé).",
      `- ${config.chasseurs_max} chasseurs au plus par joueur, jamais un joueur que tu as déjà démasqué.`,
      "- À chaque nouvelle cible, un **indice de départ** : une caractéristique de sa carte.",
      "",
      "**⚔️ Objets contre ta cible**",
      ...objets("offensif"),
      "",
      "**🛡️ Objets contre ton chasseur**",
      ...objets("defensif"),
      "",
      "**❓ Questions**",
      "- 💎 Rareté : commune, rare, épique, légendaire ou champion",
      "- 💧 Élixir : 1 ou 2, 3, 4, 5 ou plus",
      "- 🧩 Type : troupe terrestre, troupe aérienne, sort, bâtiment",
      "- 👪 Famille : humain, gobelin, squelette, gargouille, aucune",
      "- 🏹 Portée : mêlée, distance (troupes seulement)",
      "- ❤️ Points de vie : moins de 500, 500 à 1500, plus de 1500 (troupes seulement)",
      "",
      `**🏁 Fin** au jour ${config.duree_jours} : classement aux points, puis le plus de cartes découvertes, puis le moins d'accusations ratées.`,
    ].join("\n"),
    color: QEC_COLOR,
  };
}

// ── Composants publics ───────────────────────────────────────────────

function bouton(label, emoji, custom_id, style = 2) {
  return { type: 2, style, label, emoji: { name: emoji }, custom_id };
}

function reglesButton() {
  return bouton("Règles", "📖", "quiestce_regles");
}

function buildAnnonceComponents(config, partie) {
  const n = Object.keys(partie.joueurs).length;
  return [
    {
      type: 1,
      components: [
        bouton(
          `S'inscrire (${n}/${config.effectif_max})`,
          "✅",
          "quiestce_participer",
          3,
        ),
        bouton("Se désinscrire", "✖️", "quiestce_desinscrire", 4),
        reglesButton(),
      ],
    },
  ];
}

function buildTableComponents() {
  return [
    {
      type: 1,
      components: [
        bouton("Jouer", "🔎", "quiestce_enqueter", 1),
        reglesButton(),
        bouton("Journal", "📜", "quiestce_journal"),
      ],
    },
  ];
}

// ── Messages Discord du salon ────────────────────────────────────────

async function discordFetch(url, init) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  const multipart = init?.body instanceof FormData;
  return fetch(`https://discord.com/api/v10${url}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...(multipart ? {} : { "Content-Type": "application/json" }),
    },
  });
}

// Image jointe au message (`attachment://`), grille comme illustration,
// comme le plateau de Bang! : confiée par URL, le proxy de Discord dépasse
// parfois son délai et affiche le message sans image (constaté sur Meow le
// 16/10 : illustration perdue à la réédition de l'annonce). Repli sur l'URL
// si le téléchargement échoue.
const IMAGES_JOINTES = [
  { chemin: "/api/quiestce/grille", filename: "grille.png", type: "image/png" },
  { chemin: "/api/quiestce/illustration", filename: "quiestce.webp", type: "image/webp" },
];

async function joindreImage(embed) {
  const url = embed?.image?.url;
  const cible = IMAGES_JOINTES.find((i) => url?.includes(i.chemin));
  if (!cible) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    embed.image = { url: `attachment://${cible.filename}` };
    return { buffer, ...cible };
  } catch (err) {
    console.warn("[QuiEstCe] Image non jointe:", err.message);
    return null;
  }
}

function corpsMessage(payload, image) {
  if (!image) return JSON.stringify({ ...payload, attachments: [] });
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: image.filename }],
    }),
  );
  form.append(
    "files[0]",
    new Blob([image.buffer], { type: image.type }),
    image.filename,
  );
  return form;
}

async function supprimerMessage(state) {
  if (!state?.messageId || !state?.channelId) return;
  try {
    const res = await discordFetch(
      `/channels/${state.channelId}/messages/${state.messageId}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404)
      console.warn(
        `[QuiEstCe] Échec suppression du message officiel (${res.status}), publication quand même.`,
      );
  } catch (err) {
    console.warn(
      "[QuiEstCe] Erreur réseau à la suppression du message officiel:",
      err.message,
    );
  }
}

async function publishAndWriteState(
  channelId,
  previousState,
  {
    phase,
    jour,
    embed,
    components,
    ping,
    termine = false,
    isPublic,
    noPing,
    closingAt = null,
    prolongee = false,
  },
) {
  const image = await joindreImage(embed);
  await supprimerMessage(previousState);
  const roleId =
    ping && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: corpsMessage(
      { embeds: [embed], components, ...buildRolePingFields(roleId) },
      image,
    ),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();
  await writeState({
    phase,
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    isPublic,
    noPing,
    ...(closingAt ? { closingAt } : {}),
    ...(prolongee ? { prolongee } : {}),
  });
  return { jour, embed, message, termine };
}

// Réédite le message officiel (après chaque action) : liste des inscrits
// le jour de présentation, sinon le message du jour.
async function rafraichirMessage(state, partie) {
  if (!state?.messageId || state.termine) return;
  try {
    const config = await loadQuiEstCeConfig();
    const annonce = state.phase === "annonce";
    const embed = annonce
      ? buildAnnonceEmbed(config, partie, state.closingAt, {
          prolongee: state.prolongee,
        })
      : await buildTableEmbed(state.jour, config, partie);
    const image = await joindreImage(embed);
    const res = await discordFetch(
      `/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        body: corpsMessage(
          {
            embeds: [embed],
            components: annonce
              ? buildAnnonceComponents(config, partie)
              : buildTableComponents(),
          },
          image,
        ),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      "[QuiEstCe] Échec rafraîchissement du message officiel:",
      err.message,
    );
  }
}

// Fin de partie : manche archivée (salon public), message final avec ping.
async function terminerPartie(state, partie, final, { dryRun = false } = {}) {
  let currentManche = null;
  if (!dryRun && state.isPublic && final.length) {
    currentManche = await archiveManche({
      vainqueur: final[0].username,
      scoreGagnant: final[0].score,
      nbJoueurs: final.length,
      ranking: final.map((r) => ({
        discordId: r.discordId,
        username: r.username,
        score: r.score,
      })),
      resolvedAt: new Date().toISOString(),
    });
  }
  const manches = await listManches({ limit: 10 });
  const embed = await buildFinEmbed(final, partie, manches, currentManche);
  const components = [{ type: 1, components: [reglesButton()] }];
  if (dryRun) return { dryRun: true, final: true, embed };
  const result = await publishAndWriteState(state.channelId, state, {
    phase: "jour",
    jour: state.jour,
    embed,
    components,
    ping: true,
    termine: true,
    isPublic: state.isPublic,
    noPing: state.noPing,
  });
  return { ...result, final: true };
}

// ── Publication quotidienne (appelée uniquement par scripts/postQuiEstCe.js) ──

// Joueurs fictifs du salon de test (6 ou 7 tirés au sort, ou plus pour
// atteindre l'effectif minimum), voir demarrerPartie.
const PNJ = [
  "Kévina",
  "Josette",
  "Gérard",
  "Ginette",
  "Jean-Mi",
  "Bernadette",
  "Régis",
  "Huguette",
  "Raymonde",
  "Lucien",
  "Simone",
  "Marcel",
];

function tirerPnj(minimum = 0) {
  const noms = [...PNJ].sort(() => Math.random() - 0.5);
  return noms.slice(0, Math.max(minimum, 6 + Math.floor(Math.random() * 2)));
}

export async function postQuiEstCe(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
    forceClose = false,
    pnj = !isPublic,
  } = {},
) {
  const config = await loadQuiEstCeConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (
    state &&
    !dryRun &&
    !force &&
    isTooSoonSinceLastClosure(state.publishedAt)
  ) {
    return {
      skipped: true,
      reason: "tooSoonSinceLastClosure",
      publishedAt: state.publishedAt,
    };
  }
  if (state && state.channelId !== channelId)
    return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état → ouverture de la fenêtre d'inscription (ping)
  if (!state) {
    const partie = dryRun ? await readPartie() : await initPartie();
    const closingAt = addDays(
      new Date(),
      config.fenetre_inscription_jours,
    ).toISOString();
    const embed = buildAnnonceEmbed(config, partie, closingAt);
    const components = buildAnnonceComponents(config, partie);
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      embed,
      components,
      ping: true,
      isPublic,
      noPing,
      closingAt,
    });
  }

  // 2) Fenêtre d'inscription : rappel tant qu'elle n'est pas close (sauf
  // effectif maximum atteint : lancement anticipé), prolongation de la
  // même durée si l'effectif minimum n'est pas atteint (PNJ du salon de
  // test compris), sinon Jour 1. `forceClose` (tests uniquement) : ignore
  // la date de clôture.
  if (state.phase === "annonce") {
    const now = new Date();
    const partieInscrits = await readPartie();
    const count = Object.keys(partieInscrits.joueurs).length;
    const pnjs = pnj && !isPublic ? tirerPnj(config.effectif_min - count) : [];
    if (
      !forceClose &&
      count < config.effectif_max &&
      new Date(state.closingAt) > now
    ) {
      const embed = buildAnnonceEmbed(config, partieInscrits, state.closingAt, {
        prolongee: state.prolongee,
      });
      const components = buildAnnonceComponents(config, partieInscrits);
      if (dryRun)
        return {
          dryRun: true,
          phase: "annonce",
          rappel: true,
          embed,
          components,
        };
      return publishAndWriteState(channelId, state, {
        phase: "annonce",
        jour: null,
        embed,
        components,
        ping: false,
        isPublic,
        noPing,
        closingAt: state.closingAt,
        prolongee: state.prolongee,
      });
    }
    if (count + pnjs.length < config.effectif_min) {
      const closingAt = addDays(
        now,
        config.fenetre_inscription_jours,
      ).toISOString();
      const embed = buildAnnonceEmbed(config, partieInscrits, closingAt, {
        prolongee: true,
      });
      const components = buildAnnonceComponents(config, partieInscrits);
      if (dryRun)
        return {
          dryRun: true,
          phase: "annonce",
          prolongation: true,
          embed,
          components,
        };
      const r = await publishAndWriteState(channelId, state, {
        phase: "annonce",
        jour: null,
        embed,
        components,
        ping: true,
        isPublic,
        noPing,
        closingAt,
        prolongee: true,
      });
      return { ...r, prolongation: true };
    }
    const partie = dryRun
      ? partieInscrits
      : await demarrerPartie({ pnj: pnjs });
    const embed = await buildTableEmbed(1, config, partie);
    const components = buildTableComponents();
    if (dryRun)
      return { dryRun: true, phase: "jour", jour: 1, embed, components };
    return publishAndWriteState(channelId, state, {
      phase: "jour",
      jour: 1,
      embed,
      components,
      ping: false,
      isPublic,
      noPing,
    });
  }

  // 3) Clôture d'un jour (lecture seule en dry-run)
  const closure = dryRun
    ? await previewCloture(state.jour)
    : await closeDayAndAdvance(state.jour);
  if (closure.termine) {
    return terminerPartie(
      { ...state, isPublic, noPing },
      closure.partie,
      closure.final,
      { dryRun },
    );
  }
  const embed = await buildTableEmbed(
    closure.jourSuivant,
    config,
    closure.partie,
  );
  const components = buildTableComponents();
  if (dryRun)
    return { dryRun: true, jour: closure.jourSuivant, embed, components };
  return publishAndWriteState(channelId, state, {
    phase: "jour",
    jour: closure.jourSuivant,
    embed,
    components,
    ping: false,
    isPublic,
    noPing,
  });
}

// ── Réponses éphémères ───────────────────────────────────────────────

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
    console.error("[QuiEstCe] Échec PATCH:", err.message);
  }
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasInscrit: "Tu n'es pas inscrit.",
  inconnu: "Tu ne participes pas à cette partie.",
  sansCible: "Choisis d'abord une cible.",
  dejaCible: "Tu as déjà une cible : démasque-la d'abord.",
  cible: "Cette cible n'est plus disponible.",
  plafondQuestion: "Tu as déjà posé ta question du jour.",
  question: "Cette question n'est pas disponible aujourd'hui.",
  plafondAccusation: "Tu as déjà accusé aujourd'hui.",
  carte: "Cette carte n'est plus possible.",
  objet: "Objet inconnu.",
  pasEnReserve: "Tu n'as pas cet objet.",
  objetJour: "Tu as déjà utilisé un objet aujourd'hui.",
  aucuneCarteLibre: "Aucune carte libre pour te déguiser.",
  pasDeLeader: "Personne n'a encore découvert de carte.",
  dejaActif: "Cet objet est déjà actif.",
  questionPosee:
    "Tu as déjà posé ta question du jour : la Loupe ne servirait à rien.",
  accusationsFaites:
    "Tu as déjà fait deux accusations sur cette cible aujourd'hui.",
  brouillard:
    "Ta cible est dans le brouillard : accusation impossible aujourd'hui.",
  dejaCible: "Tu as déjà une cible : démasque-la d'abord.",
  cible: "Cette cible n'est plus disponible.",
};

function avertissement(code) {
  return `⚠️ ${ERREURS[code] || "Action impossible."}`;
}

// Raison courte affichée à côté d'un objet indisponible.
const RAISONS_OBJET = {
  objetJour: "déjà un objet aujourd'hui",
  sansCible: "pas de cible pour l'instant",
  questionPosee: "question du jour déjà posée",
  accusationsFaites: "accusations déjà faites sur cette cible",
  dejaActif: "déjà actif",
  aucuneCarteLibre: "aucune carte libre",
};

// Statut : points, objets défensifs actifs (la réserve est dans le menu
// des objets), et chasseurs avec le nombre de questions déjà posées.
function statutLigne(partie, discordId) {
  const j = partie.joueurs[discordId];
  const actifs = [
    j.brouillard && "🌫️ Brouillard",
    j.miroir && "🪞 Miroir",
  ].filter(Boolean);
  const detail = [
    nbCartes(j.demasques.length),
    j.bonus ? `+${j.bonus} d'efficacité` : null,
    j.survie ? `+${j.survie} de survie` : null,
    `${j.nbDemasque}× démasqué`,
  ].filter(Boolean);
  const lignes = [`🏆 **${plural(points(j), "pt")}** (${detail.join(", ")})`];
  if (actifs.length)
    lignes.push(`🛡️ Actif jusqu'à la clôture : ${actifs.join(", ")}`);
  const hs = chasseurs(partie, discordId).map((h) => partie.joueurs[h]);
  if (hs.length === 1)
    lignes.push(
      `🕵️ Ton chasseur, **${hs[0].username}**, a déjà posé ${plural(hs[0].enquete.posees, "question")} sur toi.`,
    );
  else if (hs.length > 1)
    lignes.push(
      `🕵️ Tes chasseurs : ${hs.map((h) => `**${h.username}** (${plural(h.enquete.posees, "question")})`).join(", ")}.`,
    );
  return lignes.join("\n");
}

// Annonce de début de journée (objet reçu).
function lignesDebut(partie, debut) {
  const lignes = [];
  if (debut?.objetRecu)
    lignes.push(
      `🎁 Objet du jour : **${objetLabel(debut.objetRecu)}** (${OBJETS[debut.objetRecu].effet.charAt(0).toLowerCase()}${OBJETS[debut.objetRecu].effet.slice(1)})`,
    );
  return lignes;
}

function texteNouvelleCible(partie, r) {
  const indice = r.depart
    ? ` Indice de départ : ${QUESTIONS[r.depart.q].nom.toLowerCase()} **${r.depart.valeur}**.`
    : "";
  return `🎯 Nouvelle cible : **${partie.joueurs[r.cible].username}**.${indice}`;
}

// Menu « Utiliser un objet » de l'enquête : objets de la réserve (Discord
// ne permet pas de griser une option : effet si utilisable, sinon 🔒 et la
// raison) ; menu grisé si aucun n'est utilisable, absent si la réserve est
// vide.
function objetsRow(partie, discordId, config) {
  const j = partie.joueurs[discordId];
  const enReserve = Object.keys(OBJETS).filter((o) => j.objets.includes(o));
  if (!enReserve.length) return null;
  const etats = Object.fromEntries(
    enReserve.map((o) => [o, etatObjet(partie, discordId, o, { config })]),
  );
  const utilisable = enReserve.some((o) => etats[o].ok);
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: "quiestce_objet",
        placeholder: utilisable
          ? "🎒 Utiliser un objet (1 par jour)"
          : "🔒 Aucun objet utilisable pour l'instant",
        disabled: !utilisable,
        options: enReserve.map((o) => {
          const n = j.objets.filter((x) => x === o).length;
          return {
            label: `${OBJETS[o].nom}${n > 1 ? ` (×${n})` : ""}`,
            value: o,
            emoji: { name: etats[o].ok ? OBJETS[o].emoji : "🔒" },
            description: (etats[o].ok
              ? OBJETS[o].effet
              : `Indisponible : ${RAISONS_OBJET[etats[o].raison]}`
            ).slice(0, 100),
          };
        }),
      },
    ],
  };
}

const SOURCES = { miroir: " (Miroir)", depart: " (indice de départ)" };

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// [🔎 Enquêter] : carte secrète, statut, cible (ou choix de la cible),
// indices, question du jour et accusation ; fiche d'enquête en image.
async function buildEnqueteView(
  config,
  partie,
  discordId,
  { entete = null, nouveau = false, debut = null } = {},
) {
  const j = partie.joueurs[discordId];
  if (!partie.demarree) {
    return {
      embeds: [
        {
          description: `${nouveau ? "✅ Inscription confirmée !" : "✅ Tu es déjà inscrit."} À la clôture des inscriptions, tu recevras ta carte secrète et ta première cible.`,
          color: QEC_COLOR,
        },
      ],
    };
  }
  if (partie.termine)
    return {
      embeds: [{ description: "🏁 La partie est terminée.", color: QEC_COLOR }],
    };
  const annonces = [...lignesDebut(partie, debut), ...(entete ? [entete] : [])];
  const lignes = [
    ...(annonces.length ? [...annonces, ""] : []),
    `🃏 Ta carte secrète : **${nomCarte(partie, j.carte)}**`,
    statutLigne(partie, discordId),
    "",
  ];
  const components = [];
  let barrees = [j.carte, ...j.demasques.map((d) => partie.joueurs[d]?.carte)];

  if (!j.cible) {
    const dispo = ciblesDisponibles(partie, discordId, { config });
    if (!dispo.length) {
      lignes.push(
        "🎯 Aucune cible disponible pour l'instant (2 chasseurs au plus par joueur) : reviens un peu plus tard.",
      );
    } else {
      // Meneur disponible proposé par défaut, menu pour les autres
      const [top, ...autres] = dispo;
      const libelle = (id) =>
        `${plural(points(partie.joueurs[id]), "pt")} · ${plural(chasseurs(partie, id).length, "chasseur")}`;
      lignes.push(
        "🎯 **Choisis ta prochaine cible.** Le meneur disponible t'est proposé (le démasquer lui retire un point), ou choisis quelqu'un d'autre.",
      );
      components.push({
        type: 1,
        components: [
          bouton(
            `Viser ${partie.joueurs[top].username} (${plural(points(partie.joueurs[top]), "pt")})`.slice(
              0,
              80,
            ),
            "🎯",
            `quiestce_cible:${top}`,
            1,
          ),
        ],
      });
      if (autres.length) {
        components.push({
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "quiestce_cible_menu",
              placeholder: "Ou choisis une autre cible",
              options: autres.slice(0, 25).map((id) => ({
                label: partie.joueurs[id].username.slice(0, 100),
                value: id,
                description: libelle(id),
              })),
            },
          ],
        });
      }
    }
  } else {
    const cible = partie.joueurs[j.cible];
    const rivaux = chasseurs(partie, j.cible).filter((id) => id !== discordId);
    if (rivaux.length)
      lignes.push(
        `👥 ${rivaux.map((id) => `**${partie.joueurs[id].username}**`).join(", ")} chasse${rivaux.length > 1 ? "nt" : ""} aussi ${cible.username}.`,
      );
    if (cible.brouillard)
      lignes.push(
        `🌫️ Ta cible est dans le brouillard jusqu'à la clôture : tes questions restent sans réponse${config.brouillard_bloque_accusation ? " et l'accusation est impossible" : ""}.`,
      );
    const infos = j.enquete.ordre.map(
      (q) =>
        `${questionLabel(q)} : **${j.enquete.infos[q]}**${SOURCES[j.enquete.sources[q]] ?? ""}`,
    );
    lignes.push(
      "",
      `**Ce que tu sais sur ${cible.username}**`,
      ...(infos.length ? infos : ["Rien pour l'instant."]),
    );
    const cs = candidats(partie, discordId);
    barrees = partie.grille.filter((k) => !cs.includes(k));
    lignes.push("");
    // Quota quotidien, toutes cibles confondues (une question posée sur la
    // cible précédente compte aussi)
    lignes.push(
      `❓ Question du jour : **${j.questionsJour}/${config.questions_par_jour}**${j.loupe ? ` · 🔍 Loupe : 4e question débloquée (${QUESTIONS[config.pool_loupe[String(partie.numeroJour)]].nom})` : ""}`,
    );
    const possibles = questionsPossibles(partie, discordId, { config });
    if (questionsRestantes(j, config) > 0 && possibles.length) {
      components.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "quiestce_question",
            placeholder: "🔎 Pose ta question du jour",
            options: possibles.map((q) => ({
              label: QUESTIONS[q].nom,
              value: q,
              emoji: { name: QUESTIONS[q].emoji },
            })),
          },
        ],
      });
    }
    const accusationBloquee =
      cible.brouillard && config.brouillard_bloque_accusation;
    if (accusationsRestantes(j) > 0 && cs.length && !accusationBloquee) {
      const groupes = chunk(cs, 25).slice(0, 4 - components.length);
      groupes.forEach((groupe, n) => {
        components.push({
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `quiestce_accuser:${n}`,
              placeholder:
                `🎯 Accuser : la carte de ${cible.username} est…${groupes.length > 1 ? ` (${n + 1}/${groupes.length})` : ""}`.slice(
                  0,
                  150,
                ),
              options: groupe.map((k) => ({
                label: nomCarte(partie, k).slice(0, 100),
                value: k,
              })),
            },
          ],
        });
      });
    } else if (accusationsRestantes(j) < 1) {
      const double = j.doubleCible === j.cible;
      lignes.push(
        double
          ? `✅ Accusations du jour faites (Double accusation sur ${cible.username}).`
          : "✅ Accusation du jour faite.",
      );
    }
  }
  const objets = objetsRow(partie, discordId, config);
  if (objets) components.push(objets);
  return {
    embeds: [
      {
        title: "🔎 Enquête",
        description: lignes.join("\n").slice(0, 4096),
        color: QEC_COLOR,
        image: { url: await grilleUrl(partie, barrees.filter(Boolean)) },
        footer: {
          text: "Cartes barrées : impossibles pour ta cible (ou déjà connues).",
        },
      },
    ],
    components,
  };
}

// État requis pour toute action ; null (et message) sinon. `annonce` :
// action permise pendant la fenêtre d'inscription (S'inscrire).
async function guardActive(webhookUrl, { annonce = false } = {}) {
  const state = await readState();
  const ok =
    state &&
    !state.termine &&
    (state.phase === "jour" || (annonce && state.phase === "annonce"));
  if (!ok) {
    await patchOriginal(webhookUrl, {
      content:
        state?.phase === "annonce"
          ? "La partie n'a pas encore commencé : inscris-toi avec le bouton *S'inscrire*."
          : "Aucune partie de Qui est-ce ? en cours.",
    });
    return null;
  }
  return state;
}

// Action commune : sous verrou (quiestce.js), puis vue éphémère (`vue`,
// éventuellement asynchrone) et message officiel réédité.
async function executer(
  webhookUrl,
  discordId,
  username,
  action,
  vue,
  { rafraichir = true, annonce = false, inscription = false } = {},
) {
  const state = await guardActive(webhookUrl, { annonce });
  if (!state) return;
  const config = await loadQuiEstCeConfig();
  const r = await agir(discordId, username, action, { inscription });
  const refus = {
    inscriptions:
      "🔒 Les inscriptions sont closes : tu ne participes pas à cette partie. Rendez-vous à la prochaine !",
    complet: `🔒 Désolé, l'effectif maximum (${config.effectif_max} joueurs) est atteint.`,
    pasInscrit: "Tu n'es pas inscrit : clique sur *S'inscrire*.",
  };
  if (refus[r.erreur]) {
    await patchOriginal(webhookUrl, { content: refus[r.erreur] });
    return;
  }
  await patchOriginal(
    webhookUrl,
    await vue(config, r.partie, discordId, {
      ...(r.resultat || {}),
      nouveau: r.nouveau,
      debut: r.debut,
    }),
  );
  if (rafraichir || r.nouveau)
    await rafraichirMessage(state, await readPartie());
}

function texteAccusation(r, partie, cibleId, cardKey) {
  const nom = partie.joueurs[cibleId]?.username ?? "?";
  if (r.erreur) return avertissement(r.erreur);
  if (!r.correct)
    return `❌ Raté : **${nom}** n'a pas la carte ${nomCarte(partie, cardKey)}.`;
  const efficacite = r.bonus
    ? ` et **+${r.bonus}** d'efficacité (${plural(r.nbIndices, "indice")})`
    : "";
  return `🎯 **Bravo !** **${nom}** avait bien la carte ${nomCarte(partie, cardKey)} : **+${plural(r.points, "point")}**${efficacite} !`;
}

// ── Boutons du message officiel (nouvel éphémère) ────────────────────

// [✅ S'inscrire] (fenêtre d'inscription).
export async function handleParticiper(webhookUrl, discordId, username) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      () => ({}),
      buildEnqueteView,
      { rafraichir: false, annonce: true, inscription: true },
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec inscription:", err.message);
  }
}

// [✖️ Se désinscrire] (fenêtre d'inscription).
export async function handleDesinscrire(webhookUrl, discordId) {
  try {
    const state = await guardActive(webhookUrl, { annonce: true });
    if (!state) return;
    if (state.phase !== "annonce") {
      await patchOriginal(webhookUrl, {
        content:
          "🔒 La partie est lancée, il n'est plus possible de se désinscrire.",
      });
      return;
    }
    const r = await desinscrireJoueur(discordId);
    await patchOriginal(webhookUrl, {
      content: r.erreur
        ? "Tu n'étais pas inscrit."
        : "✖️ Désinscription confirmée.",
    });
    if (!r.erreur) await rafraichirMessage(state, r.partie);
  } catch (err) {
    console.error("[QuiEstCe] Échec désinscription:", err.message);
  }
}

// [🔎 Enquêter].
export async function handleEnqueter(webhookUrl, discordId, username) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      () => ({}),
      buildEnqueteView,
      { rafraichir: false },
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec enquêter:", err.message);
  }
}

// ── Composants de l'éphémère (édition en place) ──────────────────────

// Menu « Pose ta question du jour ».
export async function handleQuestion(webhookUrl, discordId, username, q) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = poser(partie, discordId, q, { config });
        const cible = partie.joueurs[partie.joueurs[discordId]?.cible];
        return {
          entete: r.erreur
            ? avertissement(r.erreur)
            : `🔎 ${QUESTIONS[q].nom} de la carte de **${cible?.username}** : **${r.valeur}**.`,
        };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec question:", err.message);
  }
}

// Menu(s) « Accuser ».
export async function handleAccuser(webhookUrl, discordId, username, cardKey) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const cibleId = partie.joueurs[discordId]?.cible;
        const r = accuser(partie, discordId, cardKey, { config });
        return { entete: texteAccusation(r, partie, cibleId, cardKey) };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec accusation:", err.message);
  }
}

function texteObjet(r, partie) {
  if (r.erreur) return avertissement(r.erreur);
  if (r.objet === "loupe")
    return `🔍 Loupe : 4e question débloquée aujourd'hui (${QUESTIONS[r.q].nom}), à choisir ci-dessous.`;
  if (r.objet === "double")
    return `🎯 Double accusation : deux accusations aujourd'hui sur **${partie.joueurs[r.cible].username}**.`;
  if (r.objet === "desamorcage") {
    const nom = partie.joueurs[r.cible].username;
    return r.detruit
      ? `🧨 Désamorçage : tu détruis le ${objetLabel(r.detruit)} de **${nom}** !`
      : `🧨 Désamorçage : **${nom}** n'avait rien à désamorcer.`;
  }
  if (r.objet === "brouillard")
    return "🌫️ Brouillard : jusqu'à la clôture, les questions sur ta carte restent sans réponse et personne ne peut t'accuser.";
  if (r.objet === "miroir")
    return "🪞 Miroir posé (secret) : la prochaine question sur toi te révélera la même caractéristique de ton chasseur.";
  return `🎭 Déguisement : ta carte secrète est maintenant **${nomCarte(partie, r.carte)}**.${r.chasseurs ? ` ${r.chasseurs > 1 ? "Tes chasseurs perdent" : "Ton chasseur perd"} ses indices !` : ""}`;
}

// Bouton « Viser X » et menu « Ou choisis une autre cible ».
export async function handleCible(webhookUrl, discordId, username, cibleId) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = choisirCible(partie, discordId, cibleId, { config });
        return {
          entete: r.erreur
            ? avertissement(r.erreur)
            : texteNouvelleCible(partie, r),
        };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec cible:", err.message);
  }
}

// Menu « Utiliser un objet ».
export async function handleObjet(webhookUrl, discordId, username, objet) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => ({
        entete: texteObjet(
          utiliserObjet(partie, discordId, objet, { config }),
          partie,
        ),
      }),
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec objet:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) ───────────────────────────────────

// Ce qui concerne le joueur (ses actions, celles qui le visent, ses notes
// privées : réponses, accusations), regroupé par jour, du plus récent au
// plus ancien (jours anciens coupés au-delà de 4096 caractères).
export async function handleJournal(webhookUrl, discordId) {
  try {
    const [state, partie] = await Promise.all([readState(), readPartie()]);
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Qui est-ce ? en cours.",
      });
      return;
    }
    if (!partie.joueurs[discordId]) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne participes pas à cette partie.",
      });
      return;
    }
    const jours = new Map();
    for (const e of partie.journal) {
      if (e.p !== discordId && !e.ids?.includes(discordId)) continue;
      if (!jours.has(e.j)) jours.set(e.j, []);
      jours.get(e.j).push(texteJournal(partie, e, discordId));
    }
    let description = "";
    for (const [j, lignes] of [...jours.entries()].sort(
      (a, b) => b[0] - a[0],
    )) {
      const bloc = [`**Jour ${j}**`, ...lignes, ""].join("\n");
      if (description.length + bloc.length > 4000) {
        description += "*(jours précédents non affichés)*";
        break;
      }
      description += `${bloc}\n`;
    }
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: "📜 Ton journal",
          description: description.trim() || "Rien à signaler pour l'instant.",
          color: QEC_COLOR,
        },
      ],
    });
  } catch (err) {
    console.error("[QuiEstCe] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadQuiEstCeConfig())],
    });
  } catch (err) {
    console.error("[QuiEstCe] Échec Règles:", err.message);
  }
}
