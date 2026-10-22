// ============================================================
// meow.js — Handlers Discord de Meow (jeu spécial de 7 jours) : trois
// bandes de chats squattent les coins d'une maison, en temps réel.
// Un seul message officiel par jour (classement des bandes et situation
// actuelle, faits du jour, carte), réédité après chaque action qui change la
// carte, avec quatre boutons, chacun en éphémère : Jouer (Appeler / Squatter
// / Déplacer, puis le crêpage de poils manche par manche), Ma bande
// (messagerie), Règles et Journal.
// Fenêtre d'inscription (comme Qui est-ce ?) : boutons S'inscrire, Se
// désinscrire et Règles, rappel quotidien. À l'heure de clôture (passage
// horaire du cron ou premier clic), inscriptions bloquées et message
// remplacé : partie annulée si l'effectif minimum n'est pas atteint.
//
// La publication quotidienne passe uniquement par scripts/postMeow.js
// (postMeow). Les événements horaires (distributions, décompte, sieste)
// sont rattrapés à chaque action (voir rattraper() dans meowRules.js).
// ============================================================

import {
  loadMeowConfig,
  readState,
  writeState,
  readPartie,
  initPartie,
  demarrerPartie,
  agir,
  desinscrireJoueur,
  rattraperPartie,
  avancerHorloge,
  marquerMercenairesNotifies,
  classementsFinaux,
  archiveManche,
  listManches,
} from "../../../backend/services/meow.js";
import { membresPartis } from "../../../backend/services/discordUsers.js";
import {
  BANDES,
  PIECES,
  PIECE_DE,
  compteRendu,
  COINS,
  ERRANTS,
  nomCoin,
  jourDe,
  enSieste,
  prochaineDistribution,
  coinsDe,
  coinsVerrouilles,
  piecesTenues,
  menace,
  squatsPossibles,
  squatsRestants,
  deplacementsPossibles,
  deplacementsRestants,
  deplacer,
  appeler,
  lancerSquat,
  jouerManche,
  jusquauBout,
  retraite,
  pVictoire,
  classementBandes,
  texteJournal,
  parisParts,
  posterMessage,
  messagesBande,
  messagesRestants,
  nouveauxMessages,
  marquerLus,
  estPnj,
  horloge,
} from "../../../backend/services/meowRules.js";
import { encodeCarte } from "../../../backend/services/meowImage.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";

const MEOW_COLOR = 0xe8812a;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const MEDALS = ["🥇", "🥈", "🥉"];

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/meow/illustration?v=${Date.now()}`;
}

function carteUrl(partie) {
  return `${TRUST_ROYALE_URL}/api/meow/carte?d=${encodeCarte(partie)}`;
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;
}

function chats(n) {
  return plural(n, "chat");
}

function nomBande(b) {
  return `${BANDES[b].emoji} ${BANDES[b].nom}`;
}

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

// « 2 h 15 », « 45 min »
function delai(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}`;
}

// « minuit » pour un décompte à 24 h (ou 0 h), sinon « 23h »
function heureDecompte(config) {
  return config.heure_decompte % 24 === 0 ? "minuit" : `${config.heure_decompte}h`;
}

function horairesDistribution(config) {
  return config.distributions
    .map((h) => `${h}h`)
    .join(", ")
    .replace(/, ([^,]*)$/, " et $1");
}

// ── Embeds publics ───────────────────────────────────────────────────

function buildAnnonceEmbed(config, partie, closingAt) {
  const inscrits = Object.values(partie.joueurs)
    .sort((a, b) => a.arrivee - b.arrivee)
    .map((j) => j.username);
  return {
    title: "🐾 Meow : pousse-toi, c'est mon coussin !",
    description: [
      "Trois bandes de chats se disputent les meilleurs territoires de la maison. Appelle tes chats, squatte les territoires voisins et fais gagner ta bande !",
      "",
      `📅 **${config.duree_jours} jours de jeu** en équipe (bandes tirées au sort). Effectif requis : **${config.effectif_min} à ${config.effectif_max} joueurs**.`,
      `🐱 Des renforts de chats arrivent à ${horairesDistribution(config)} : passe quand tu veux dans la journée pour en profiter.`,
      "🤝 Inscris-toi seulement si tu peux jouer régulièrement chaque jour : un chat absent affaiblit toute sa bande.",
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
    color: MEOW_COLOR,
    image: { url: illustrationUrl() },
    footer: {
      text: `Clôture des inscriptions : ${formatDateFr(closingAt)}.`,
    },
  };
}

// Heure de clôture atteinte : plus d'inscription ni de désinscription.
function inscriptionsCloses(state) {
  return (
    state?.phase === "annonce" &&
    !!state.closingAt &&
    new Date(state.closingAt) <= new Date()
  );
}

// Ouverture des inscriptions (états antérieurs sans `openedAt` : déduite de
// la clôture).
function ouvertureInscriptions(state, config) {
  return (
    state.openedAt ||
    addDays(state.closingAt, -config.fenetre_inscription_jours).toISOString()
  );
}

// Clôture sous l'effectif minimum : partie annulée (sans prolongation).
function buildAnnulationEmbed(config, count, state) {
  return {
    title: "🐾 Meow : partie annulée",
    description: `🔒 Les inscriptions étaient ouvertes du ${formatDateFr(ouvertureInscriptions(state, config))} au ${formatDateFr(state.closingAt)}, il fallait être au minimum **${config.effectif_min}** participants : seulement **${count}** inscrit${count > 1 ? "s" : ""}. Rendez-vous à la prochaine !`,
    color: MEOW_COLOR,
  };
}

// Clôture avec l'effectif minimum : inscrits figés, le Jour 1 part au
// prochain cron du matin (7h22 UTC).
function buildClotureEmbed(config, partie, state) {
  const inscrits = Object.values(partie.joueurs)
    .sort((a, b) => a.arrivee - b.arrivee)
    .map((j) => j.username);
  const c = new Date(state.closingAt);
  const ceMatin = c.getUTCHours() * 60 + c.getUTCMinutes() < 7 * 60 + 22;
  return {
    title: "🐾 Meow : inscriptions closes",
    description: [
      `🔒 La partie commence ${ceMatin ? "ce matin" : "demain matin"} : chaque joueur recevra sa bande en message privé.`,
      "",
      `**✋ Inscrits (${inscrits.length})**`,
      inscrits.join(" · "),
    ].join("\n"),
    color: MEOW_COLOR,
    image: { url: illustrationUrl() },
  };
}

// Points cumulés et territoires tenus en ce moment (ce que rapportera le
// prochain décompte).
function classementLignes(partie) {
  return classementBandes(partie).map(
    (r, i) =>
      `${MEDALS[i]} **${nomBande(r.b)}** : ${plural(r.points, "pt")} (${plural(r.territoires, "territoire")})`,
  );
}

function bandesLignes(partie) {
  return BANDES.map((bd, b) => {
    const membres = Object.values(partie.joueurs)
      .filter((j) => j.bande === b)
      .map((j) => j.username)
      .sort((x, y) => x.localeCompare(y));
    return `${bd.emoji} **${bd.nom}** (${PIECES[bd.depart].nom}, ${membres.length}) : ${membres.join(", ")}`;
  });
}

function buildJourEmbed(jour, config, partie) {
  const m = partie.mercenaires;
  const lignes = [
    ...(m?.jour === jour ? [`⚔️ **Des mercenaires rejoignent les ${nomBande(m.b)}** : +${m.n} chats sur ${nomCoin(m.coin)} !`, ""] : []),
    ...(jour === 1
      ? [
          "Les bandes sont formées ! Chaque bande part de sa pièce, le Salon et le Grenier sont occupés par des chats errants.",
          "",
        ]
      : []),
    "**🏆 Classement des bandes**",
    ...classementLignes(partie),
  ];
  // Aujourd'hui : bilan des squats, puis territoires gagnés et perdus par
  // bande dans la journée (le détail est dans le Journal de chaque bande)
  const squats = partie.journal.filter((e) => e.k === "squat" && e.j === jour);
  if (squats.length) {
    const prises = squats.filter((e) => e.issue === "victoire");
    const rates = squats.filter((e) => e.issue === "defaite").length;
    const retraites = squats.length - prises.length - rates;
    const bilan = [
      `${prises.length} réussi${prises.length > 1 ? "s" : ""}`,
      rates ? `${rates} raté${rates > 1 ? "s" : ""}` : null,
      retraites ? `${plural(retraites, "retraite")}` : null,
    ].filter(Boolean);
    lignes.push(
      "",
      "**💥 Aujourd'hui**",
      `😼 ${plural(squats.length, "squat")} : ${bilan.join(", ")}.`,
      ...BANDES.map((bd, b) => {
        const gagnes = prises.filter((e) => e.b === b).length;
        const perdus = prises.filter((e) => e.def === b).length;
        return `${bd.emoji} ${bd.nom} : ${plural(gagnes, "territoire")} gagné${gagnes > 1 ? "s" : ""} / ${plural(perdus, "territoire")} perdu${perdus > 1 ? "s" : ""}`;
      }),
    );
  }
  return {
    title: `🐾 Meow (Jour ${jour}/${config.duree_jours})`,
    description: lignes.join("\n").slice(0, 4096),
    color: MEOW_COLOR,
    image: { url: carteUrl(partie) },
    footer: {
      text: `Chats distribués à ${horairesDistribution(config)} · Décompte à ${heureDecompte(config)} · Sieste de 0h à ${config.fin_sieste}h (pas de squat).`,
    },
  };
}

function formatMancheLine(record, isCurrent) {
  return `Manche ${record.manche} : victoire des **${record.vainqueur}** (${plural(record.points, "pt")}, ${plural(record.nbJoueurs, "joueur")})${isCurrent ? " *(cette manche)*" : ""}`;
}

function buildFinEmbed(bandes, caids, manches, currentManche, resume = []) {
  const [premier, second] = bandes;
  const titre =
    premier.points === second.points &&
    premier.territoires === second.territoires
      ? "🤝 Égalité parfaite en tête !"
      : `👑 Les **${nomBande(premier.b)}** remportent la partie avec ${plural(premier.points, "pt")} !`;
  return {
    title: "🏆 Meow : partie terminée !",
    description: [
      titre,
      "",
      "**Classement des bandes**",
      ...bandes.map(
        (r, i) =>
          `${MEDALS[i]} **${nomBande(r.b)}** : ${plural(r.points, "pt")}`,
      ),
      "",
      ...(resume.length ? ["**📰 La partie en bref**", resume.join(" "), ""] : []),
      "**🏅 Caïd des coussins**",
      ...caids
        .slice(0, 3)
        .map(
          (r, i) =>
            `${MEDALS[i] || `${i + 1}.`} **${r.username}** ${BANDES[r.bande].emoji} : ${plural(r.score, "pt")} (🚩 ${r.coinsPris} · 💨 ${r.chatsDeloges})`,
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
    footer: { text: "Légende : 🚩 territoires pris · 💨 chats délogés" },
    image: { url: illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles : Meow",
    description: [
      "Trois bandes de chats (🟠 Roux, ⚫ Chats noirs, 🔵 Chartreux) se disputent les 20 territoires de la maison. Ta bande est tirée au sort.",
      `🕐 **Tu peux jouer 3 fois par jour**, à chaque distribution (${horairesDistribution(config)}) : appeler tes chats, ${plural(config.squats_par_distribution, "squat")} et ${plural(config.deplacements_par_distribution, "déplacement")} à chaque fois.`,
      "",
      "**🐱 Tes chats**",
      `- Distribution à **${horairesDistribution(config)}** : ${chats(config.chats_par_distribution)} pour toi (${config.stock_max} en réserve maximum).`,
      "- **Appeler** : pose tous tes chats de réserve sur un territoire de ta bande.",
      `- **Déplacer** : ${config.deplacements_par_distribution} chat vers un autre territoire de ta bande, dans la même pièce ou par un passage 🐾, entre deux distributions (1 chat reste toujours sur place).`,
      "- À minuit, 1 de tes chats pas appelés s'installe tout seul sur le territoire le plus menacé, les autres restent en réserve.",
      "",
      "**😼 Squatter**",
      `- Depuis un territoire de ta bande avec au moins 2 chats, vers un territoire voisin : 1 chat reste garder, les autres y vont. **${plural(config.squats_par_distribution, "squat")}** entre deux distributions.`,
      "- Voisins : tous les territoires d'une même pièce, et ceux reliés par une 🐾 sur la carte.",
      "- **Crêpage de poils** à chaque manche : jusqu'à 3 dés contre 2, on compare les plus hauts dés, le plus petit perd un chat, **l'égalité profite au défenseur**.",
      "- Les chats et les territoires sont ceux de toute la bande : organisez-vous !",
      "- 🔒 Les **paniers** (anneau doré) sont imprenables.",
      `- 😴 Pas de squat pendant la sieste (0h à ${config.fin_sieste}h).`,
      `- 💬 **Ma bande** : messagerie réservée à ta bande (${config.messages_par_jour} messages par jour).`,
      "",
      "**🍖 Croquettes**",
      "- Ta bande tient toute une pièce : +1 chat à chaque distribution, posé tout seul sur le territoire le plus menacé de la pièce.",
      "",
      `**⚔️ Mercenaires** : au matin du jour ${config.mercenaires.jour}, la bande dernière reçoit ${plural(config.mercenaires.par_joueur, "chat")} par joueur.`,
      "",
      "**🏆 Points**",
      `- Chaque soir à **${heureDecompte(config)}**, chaque territoire tenu rapporte ${plural(config.points_territoire, "point")} à sa bande.`,
      `- 🏅 **Caïd des coussins** (classement individuel) : ${config.caid.coin} pts par territoire pris, ${config.caid.chat} par chat délogé. Classement révélé à la fin de la partie.`,
      `- Fin après le décompte du jour ${config.duree_jours} : la bande qui a le plus de points gagne.`,
    ].join("\n"),
    color: MEOW_COLOR,
  };
}

// ── Composants publics ───────────────────────────────────────────────

function bouton(label, emoji, custom_id, style = 2, disabled = false) {
  return {
    type: 2,
    style,
    label,
    emoji: { name: emoji },
    custom_id,
    ...(disabled ? { disabled: true } : {}),
  };
}

function reglesButton() {
  return bouton("Règles", "📖", "meow_regles");
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
          "meow_participer",
          3,
        ),
        bouton("Se désinscrire", "✖️", "meow_desinscrire", 4),
        reglesButton(),
      ],
    },
  ];
}

function buildJourComponents() {
  return [
    {
      type: 1,
      components: [
        bouton("Jouer", "🐾", "meow_jouer", 1),
        bouton("Ma bande", "💬", "meow_bande"),
        reglesButton(),
        bouton("Journal", "📜", "meow_journal"),
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

// Image jointe au message (`attachment://`), carte comme illustration :
// confiée par URL, le proxy de Discord dépasse parfois son délai et affiche
// le message sans image (constaté le 16/10 sur l'illustration à la
// réédition de l'annonce). Repli sur l'URL si le téléchargement échoue.
const IMAGES_JOINTES = [
  { chemin: "/api/meow/carte", filename: "carte.jpg", type: "image/jpeg" },
  {
    chemin: "/api/meow/illustration",
    filename: "meow.webp",
    type: "image/webp",
  },
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
    console.warn("[Meow] Image non jointe:", err.message);
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
        `[Meow] Échec suppression du message officiel (${res.status}), publication quand même.`,
      );
  } catch (err) {
    console.warn(
      "[Meow] Erreur réseau à la suppression du message officiel:",
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
    openedAt = null,
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
    ...(openedAt ? { openedAt } : {}),
  });
  return { jour, embed, message, termine };
}

// Réédite le message officiel : liste des inscrits le jour de
// présentation, sinon le message du jour (carte comprise).
export async function rafraichirMessage(state, partie) {
  if (!state?.messageId || state.termine) return;
  try {
    const config = await loadMeowConfig();
    const annonce = state.phase === "annonce";
    const embed = !annonce
      ? buildJourEmbed(state.jour, config, partie)
      : state.cloture
        ? buildClotureEmbed(config, partie, state)
        : buildAnnonceEmbed(config, partie, state.closingAt);
    const components = !annonce
      ? buildJourComponents()
      : state.cloture
        ? [{ type: 1, components: [reglesButton()] }]
        : buildAnnonceComponents(config, partie);
    await editerMessage(state, embed, components);
  } catch (err) {
    console.error(
      "[Meow] Échec rafraîchissement du message officiel:",
      err.message,
    );
  }
}

async function editerMessage(state, embed, components) {
  const image = await joindreImage(embed);
  const res = await discordFetch(
    `/channels/${state.channelId}/messages/${state.messageId}`,
    {
      method: "PATCH",
      body: corpsMessage({ embeds: [embed], components }, image),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function desinscrirePartis() {
  const partis = await membresPartis(Object.keys((await readPartie()).joueurs));
  for (const id of partis) await desinscrireJoueur(id);
  if (partis.length) console.log(`[Meow] Désinscrits (ont quitté le serveur) : ${partis.join(", ")}`);
}

// Heure de clôture atteinte (passage horaire du cron, ou premier clic après
// la clôture) : le message officiel est remplacé sur place. Effectif
// minimum non atteint (salon public) : partie annulée ; sinon inscriptions
// closes, le Jour 1 part au cron du matin (postMeow).
export async function cloturerInscriptions({ dryRun = false } = {}) {
  const state = await readState();
  if (!inscriptionsCloses(state) || state.termine || state.cloture)
    return { skipped: true };
  const config = await loadMeowConfig();
  if (!dryRun) await desinscrirePartis();
  const partie = await readPartie();
  const count = Object.keys(partie.joueurs).length;
  const annulation = state.isPublic && count < config.effectif_min;
  const embed = annulation
    ? buildAnnulationEmbed(config, count, state)
    : buildClotureEmbed(config, partie, state);
  if (dryRun) return { dryRun: true, annulation, inscrits: count, embed };
  await editerMessage(
    state,
    embed,
    annulation ? [] : [{ type: 1, components: [reglesButton()] }],
  );
  await writeState({
    ...state,
    ...(annulation ? { termine: true } : { cloture: true }),
  });
  return { annulation, inscrits: count };
}

// Fin de partie : manche archivée (salon public), message final avec ping.
async function terminerPartie(state, partie, { dryRun = false } = {}) {
  const { bandes, caid: caids } = await classementsFinaux(partie);
  let currentManche = null;
  if (!dryRun && state.isPublic) {
    currentManche = await archiveManche({
      vainqueur: BANDES[bandes[0].b].nom,
      points: bandes[0].points,
      nbJoueurs: caids.length,
      bandes: bandes.map((r) => ({ bande: BANDES[r.b].id, points: r.points })),
      ranking: caids.map((r) => ({
        discordId: r.discordId,
        username: r.username,
        bande: BANDES[r.bande].id,
        score: r.score,
      })),
      resolvedAt: new Date().toISOString(),
    });
  }
  const manches = await listManches({ limit: 10 });
  const embed = buildFinEmbed(bandes, caids, manches, currentManche, compteRendu(partie));
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

// ── MP de lancement : sa bande et ses coéquipiers ────────────────────

async function envoyerMp(discordId, embed) {
  try {
    const dm = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dm.ok) return false;
    const { id } = await dm.json();
    const res = await discordFetch(`/channels/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    });
    return res.ok;
  } catch (err) {
    console.error("[Meow] Échec envoi MP:", err.message);
    return false;
  }
}

// Au lancement, chaque joueur (hors PNJ) reçoit sa bande et ses coéquipiers
// en MP, avec un lien vers le message du jour. Un MP refusé (MP fermés) ne
// bloque rien : l'info reste dans le message du jour et la vue Jouer.
async function envoyerBandesEnMp(partie) {
  for (const [id, j] of Object.entries(partie.joueurs)) {
    if (j.bande == null || estPnj(id)) continue;
    const bd = BANDES[j.bande];
    await envoyerMp(id, {
      title: `🐾 Meow : tu es chez les ${bd.nom} ${bd.emoji}`,
      description: [
        `Ta bande part ${PIECES[bd.depart].du.replace(PIECES[bd.depart].nom, `**${PIECES[bd.depart].nom}**`)} (panier imprenable : ${nomCoin(bd.panier)}).`,
        "",
        "**🐱 Les bandes**",
        ...bandesLignes(partie),
      ].join("\n"),
      color: MEOW_COLOR,
    });
  }
}

// MP aux joueurs (hors PNJ) de la bande qui reçoit les mercenaires.
async function envoyerMercenairesEnMp(partie) {
  const m = partie.mercenaires;
  for (const [id, j] of Object.entries(partie.joueurs)) {
    if (j.bande !== m.b || estPnj(id)) continue;
    await envoyerMp(id, {
      title: "⚔️ Meow : des mercenaires pour ta bande !",
      description: `Ta bande est dernière : **${m.n} chats mercenaires** arrivent en renfort sur **${nomCoin(m.coin)}**. À vous de jouer !`,
      color: MEOW_COLOR,
    });
  }
}

// ── Publication quotidienne (appelée uniquement par scripts/postMeow.js) ──

// Joueurs fictifs du salon de test, pour remplir les bandes (voir
// demarrerPartie) ; ils jouent tout seuls à chaque distribution (jouerPnj).
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

export async function postMeow(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
    forceClose = false,
    pnj = !isPublic,
    avancer = null,
  } = {},
) {
  const config = await loadMeowConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };
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
      openedAt: new Date().toISOString(),
    });
  }

  // 2) Fenêtre d'inscription : rappel tant qu'elle n'est pas close (sauf
  // effectif maximum atteint : lancement anticipé), partie annulée si
  // l'effectif minimum n'est pas atteint (PNJ du salon de test compris),
  // sinon Jour 1. Les inscrits ayant quitté le serveur sont d'abord
  // désinscrits. `forceClose` (tests uniquement) : ignore la date de clôture.
  if (state.phase === "annonce") {
    const now = new Date();
    if (!dryRun) await desinscrirePartis();
    const partieInscrits = await readPartie();
    const count = Object.keys(partieInscrits.joueurs).length;
    const pnjs = pnj && !isPublic ? tirerPnj(config.effectif_min - count) : [];
    if (
      !forceClose &&
      count < config.effectif_max &&
      new Date(state.closingAt) > now
    ) {
      const embed = buildAnnonceEmbed(config, partieInscrits, state.closingAt);
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
        openedAt: state.openedAt,
      });
    }
    if (count + pnjs.length < config.effectif_min) {
      const embed = buildAnnulationEmbed(config, count, state);
      if (dryRun)
        return { dryRun: true, phase: "annonce", annulation: true, embed };
      const r = await publishAndWriteState(channelId, state, {
        phase: "annonce",
        jour: null,
        embed,
        components: [],
        ping: true,
        termine: true,
        isPublic,
        noPing,
      });
      return { ...r, annulation: true };
    }
    if (dryRun)
      return {
        dryRun: true,
        phase: "jour",
        jour: 1,
        lancement: true,
        inscrits: count,
        pnj: pnjs,
      };
    const partie = await demarrerPartie({ pnj: pnjs });
    const r = await publishAndWriteState(channelId, state, {
      phase: "jour",
      jour: 1,
      embed: buildJourEmbed(1, config, partie),
      components: buildJourComponents(),
      ping: false,
      isPublic,
      noPing,
    });
    await envoyerBandesEnMp(partie);
    return r;
  }

  // 3) Jour suivant : événements rattrapés (décomptes compris), message du
  // jour, ou message de fin après le décompte du dernier jour.
  // Salon de test : `avancer` fait sauter l'horloge de la partie (un jour ou
  // une distribution par lancement) ; le salon public suit l'heure réelle.
  const partie =
    avancer && !dryRun && !isPublic
      ? await avancerHorloge(avancer)
      : await rattraperPartie({ dryRun });
  if (partie.termine)
    return terminerPartie({ ...state, isPublic, noPing }, partie, { dryRun });
  const jour = jourDe(partie, horloge(partie));
  if (jour === state.jour && !force)
    return { skipped: true, reason: "dejaPublie", jour };
  const embed = buildJourEmbed(jour, config, partie);
  const components = buildJourComponents();
  if (dryRun) return { dryRun: true, jour, embed, components };
  const r = await publishAndWriteState(channelId, state, {
    phase: "jour",
    jour,
    embed,
    components,
    ping: false,
    isPublic,
    noPing,
  });
  if (partie.mercenaires && !partie.mercenaires.notifie) {
    await envoyerMercenairesEnMp(partie);
    await marquerMercenairesNotifies();
  }
  return r;
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
    console.error("[Meow] Échec PATCH:", err.message);
  }
}

const ERREURS = {
  pasLancee: "La partie n'a pas encore commencé.",
  termine: "La partie est terminée.",
  inconnu: "Tu ne participes pas à cette partie.",
  pasTonCoin: "Ce territoire n'est plus à ta bande.",
  verrouille:
    "Un crêpage de poils est en cours sur ce territoire, réessaie dans un instant.",
  stockVide: "Tu n'as plus de chat à appeler.",
  combatEnCours: "Tu as déjà un crêpage de poils en cours.",
  sieste: "C'est la sieste : pas de squat avant 8h.",
  plafondSquats: "Tu as fait tes squats : attends la prochaine distribution.",
  squatImpossible: "Ce squat n'est plus possible (la carte a bougé).",
  plafondDeplacements:
    "Tu as déjà déplacé un chat : attends la prochaine distribution.",
  deplacementImpossible:
    "Ce déplacement n'est plus possible (la carte a bougé).",
  pasDeCombat: "Ce crêpage de poils est déjà terminé.",
};

function avertissement(code) {
  return `⚠️ ${ERREURS[code] || "Action impossible."}`;
}

function nomAdversaire(def, n) {
  if (def === ERRANTS)
    return `${n} chat${n > 1 ? "s" : ""} errant${n > 1 ? "s" : ""}`;
  return `${n} ${BANDES[def].nom}`;
}

function texteManche(manche, b, def) {
  const adv = def === ERRANTS ? "errant" : BANDES[def].nom;
  const pertes = [
    manche.pd
      ? `${manche.pd} ${adv}${manche.pd > 1 && def === ERRANTS ? "s" : ""}`
      : null,
    manche.pa ? `${manche.pa} ${BANDES[b].nom}` : null,
  ].filter(Boolean);
  return `🎲 Tes chats : **${manche.da.join("-")}** · En face : **${manche.dd.join("-")}** → ${pertes.join(" et ")} détale${manche.pa + manche.pd > 1 ? "nt" : ""}.`;
}

function texteFin(fin) {
  if (fin.issue === "victoire")
    return `🎉 **Territoire squatté !** ${chats(fin.a)} s'installe${fin.a > 1 ? "nt" : ""} sur ${nomCoin(fin.vers)}.`;
  if (fin.issue === "defaite")
    return `😿 **Échec** : tes chats ont tous détalé devant ${nomCoin(fin.vers)}.`;
  return `🏃 **Retraite** : ${chats(fin.a)} rentre${fin.a > 1 ? "nt" : ""} sur ${nomCoin(fin.de)}.`;
}

// Crêpage de poils en cours : dernière manche et trois boutons.
function buildCombatView(config, partie, discordId, { entete = null } = {}) {
  const c = partie.combats[discordId];
  const j = partie.joueurs[discordId];
  const derniere = c.manches.at(-1);
  const lignes = [
    ...(entete ? [entete, ""] : []),
    `${BANDES[j.bande].emoji} **${chats(c.a)}** (depuis ${nomCoin(c.s)}) contre **${nomAdversaire(c.def, c.d)}** sur ${nomCoin(c.t)}.`,
    ...(derniere ? [texteManche(derniere, j.bande, c.def)] : []),
    "",
    `Chances de réussite si tu finis la baston : **${Math.round(pVictoire(c.a, c.d) * 100)} %**.`,
  ];
  return {
    embeds: [
      {
        title: "💢 Crêpage de poils",
        description: lignes.join("\n"),
        color: MEOW_COLOR,
        footer: {
          text: `Sans réponse pendant ${config.delai_combat_minutes} minutes, tes chats battent en retraite.`,
        },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          bouton("Finir la baston", "💢", "meow_bout", 1),
          bouton("Battre en retraite", "🏃", "meow_retraite", 4),
        ],
      },
    ],
  };
}

// [🐾 Jouer] : bande, réserve, squats restants, coins de la bande, menus
// Appeler (toute la réserve), Squatter et Déplacer.
// Titre de la vue Jouer juste après la fin d'un squat
const TITRES_ISSUE = {
  victoire: "🎉 Victoire !",
  defaite: "😿 Raté",
  retraite: "🏃 Retraite",
  retraiteAuto: "🏃 Retraite",
};

function buildJouerView(
  config,
  partie,
  discordId,
  { entete = null, nouveau = false, issue = null } = {},
) {
  const j = partie.joueurs[discordId];
  if (!partie.demarree) {
    return {
      embeds: [
        {
          description: `${nouveau ? "✅ Inscription confirmée !" : "✅ Tu es déjà inscrit."} À la clôture des inscriptions, tu découvriras ta bande.`,
          color: MEOW_COLOR,
        },
      ],
    };
  }
  if (partie.termine)
    return {
      embeds: [
        { description: "🏁 La partie est terminée.", color: MEOW_COLOR },
      ],
    };
  if (partie.combats[discordId])
    return buildCombatView(config, partie, discordId, { entete });

  const now = horloge(partie);
  const bd = BANDES[j.bande];
  const sieste = enSieste(now, config);
  const suivante = prochaineDistribution(now, config);
  const quand =
    suivante && parisParts(suivante.t).date !== parisParts(now).date
      ? "demain "
      : "";
  const restants = squatsRestants(j, config);
  const verrous = coinsVerrouilles(partie);
  const mesCoins = coinsDe(partie, j.bande);
  const pieces = piecesTenues(partie, j.bande);
  const nouveaux = nouveauxMessages(partie, discordId);
  const lignes = [
    ...(entete ? [entete, ""] : []),
    `${bd.emoji} Tu es dans la bande des **${bd.nom}**.`,
    `🐱 **${chats(j.stock)}** à appeler (${config.stock_max} max) · 😼 Squats : **${restants}/${config.squats_par_distribution}**${suivante ? ` jusqu'à ${quand}${suivante.h}h` : ""}`,
    ...(suivante
      ? [
          `⏳ Prochaine distribution ${quand ? "demain " : ""}à **${suivante.h}h** (dans ${delai(suivante.t - now)})${j.stock >= config.stock_max ? " : ta réserve est pleine, appelle tes chats sinon le prochain sera perdu." : "."}`,
        ]
      : []),
    ...(sieste
      ? [
          `😴 C'est la sieste jusqu'à ${config.fin_sieste}h : pas de squat, mais tu peux appeler tes chats.`,
        ]
      : []),
    // Chat posé tout seul cette nuit (sieste), rappelé le jour même
    ...(j.nuit?.jour === jourDe(partie, now)
      ? [
          `😴 Cette nuit, 1 de tes chats s'est installé tout seul sur **${nomCoin(j.nuit.coin)}**.`,
        ]
      : []),
    ...(pieces.length
      ? [
          `🍖 Croquettes : ta bande tient ${pieces.map((p) => PIECES[p].le).join(", ")}.`,
        ]
      : []),
    ...(nouveaux
      ? [
          `💬 **${nouveaux} ${nouveaux > 1 ? "nouveaux messages" : "nouveau message"}** de ta bande.`,
        ]
      : []),
  ];

  const components = [];
  if (j.stock > 0) {
    const appelables = mesCoins.filter((c) => !verrous.has(c));
    if (appelables.length) {
      components.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "meow_appel_coin",
            placeholder: "🐱 Appeler",
            options: appelables.slice(0, 25).map((c) => ({
              label: `${nomCoin(c)} (${chats(partie.coins[c].n)})`,
              value: c,
              description: `${PIECES[PIECE_DE[c]].nom}${menace(partie, c) > 0 ? " · menacé" : ""}`,
            })),
          },
        ],
      });
    }
  }
  const squats = squatsPossibles(partie, j.bande);
  // Menus : intitulé court (emoji + verbe), grisé si l'action est impossible
  // (sieste, quota atteint, rien de possible : expliqué dans les règles).
  const squatBloque = sieste || restants <= 0 || !squats.length;
  components.push({
    type: 1,
    components: [
      {
        type: 3,
        custom_id: "meow_squat",
        placeholder: "😼 Squatter",
        disabled: squatBloque,
        options: (squats.length
          ? squats
          : [{ s: "aucun", t: "aucun", a: 0, d: 0, p: 0 }]
        )
          .slice(0, 25)
          .map((o) =>
            o.s === "aucun"
              ? { label: "Aucun squat possible", value: "aucun" }
              : {
                  label: `${nomCoin(o.s)} → ${nomCoin(o.t)}`,
                  value: `${o.s}>${o.t}`,
                  description: `${chats(o.a)} contre ${nomAdversaire(partie.coins[o.t].b, o.d)} · ${Math.round(o.p * 100)} % de réussite`,
                },
          ),
      },
    ],
  });

  // Déplacer : 1 chat vers un territoire voisin de sa bande
  // Ordre de la carte (départ, puis arrivée) : lisible pour un joueur ; le
  // tri « le plus utile d'abord » de deplacementsPossibles() sert aux PNJ.
  const rang = (c) => COINS.indexOf(c);
  const deps = deplacementsPossibles(partie, j.bande).sort((x, y) => rang(x.s) - rang(y.s) || rang(x.t) - rang(y.t));
  const deplacementBloque =
    deplacementsRestants(j, config) <= 0 || !deps.length;
  components.push({
    type: 1,
    components: [
      {
        type: 3,
        custom_id: "meow_deplacer",
        placeholder: "🚚 Déplacer",
        disabled: deplacementBloque,
        options: deps.length
          ? deps.slice(0, 25).map((o) => ({
              label: `${nomCoin(o.s)} (${o.ns}) → ${nomCoin(o.t)} (${o.nt})`,
              value: `${o.s}>${o.t}`,
              ...(o.menace > 0 ? { description: `⚠️ ${nomCoin(o.t)} est menacé` } : {}),
            }))
          : [{ label: "Aucun déplacement possible", value: "aucun" }],
      },
    ],
  });

  components.push({
    type: 1,
    components: [
      bouton(
        nouveaux ? `Ma bande (${nouveaux})` : "Ma bande",
        "💬",
        "meow_bande_vue",
        nouveaux ? 3 : 2,
      ),
    ],
  });

  return {
    embeds: [
      {
        title: TITRES_ISSUE[issue] ?? "🐾 Meow",
        description: lignes.join("\n").slice(0, 4096),
        color: MEOW_COLOR,
      },
    ],
    components,
  };
}

function heureMessage(partie, t) {
  const { h, min } = parisParts(t);
  return `J${jourDe(partie, t)} ${h}h${String(min).padStart(2, "0")}`;
}

// [💬 Ma bande] : derniers messages signés de la bande, bouton Écrire.
function buildBandeView(config, partie, discordId, { entete = null } = {}) {
  const j = partie.joueurs[discordId];
  if (!partie.demarree || j?.bande == null)
    return {
      embeds: [
        {
          description: "Les bandes seront formées au lancement de la partie.",
          color: MEOW_COLOR,
        },
      ],
    };
  const bd = BANDES[j.bande];
  const restants = messagesRestants(partie, discordId, { config });
  const messages = messagesBande(partie, j.bande).slice(
    -config.messages_affiches,
  );
  const lignes = [
    ...(entete ? [entete, ""] : []),
    ...(messages.length
      ? messages.map(
          (m) =>
            `**${partie.joueurs[m.p]?.username ?? "?"}** · ${heureMessage(partie, m.t)} : ${m.txt}`,
        )
      : ["Aucun message pour l'instant. Organisez-vous !"]),
  ];
  return {
    embeds: [
      {
        title: `💬 Bande des ${bd.nom} ${bd.emoji}`,
        description: lignes.join("\n").slice(0, 4096),
        color: MEOW_COLOR,
        footer: {
          text: `Visible uniquement par ta bande · ${plural(restants, "message")} possible${restants > 1 ? "s" : ""} aujourd'hui.`,
        },
      },
    ],
    components: partie.termine
      ? []
      : [
          {
            type: 1,
            components: [
              bouton("Écrire", "✍️", "meow_ecrire", 1, restants <= 0),
            ],
          },
        ],
  };
}

// Fenêtre « Écrire » (réponse synchrone type 9, voir le routage).
export function buildMessageModal() {
  return {
    custom_id: "meow_message_modal",
    title: "Message à ta bande",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "meow_message_input",
            style: 2,
            label: "Ton message (visible par ta bande)",
            placeholder:
              "Ex. : je prépare 6 chats sur le Carton, on prend le Canapé à 13h ?",
            required: true,
            max_length: 200,
          },
        ],
      },
    ],
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
        state?.phase !== "annonce"
          ? "Aucune partie de Meow en cours."
          : state.termine
            ? "🔒 Les inscriptions sont closes : la partie est annulée."
            : "La partie n'a pas encore commencé : inscris-toi avec le bouton *S'inscrire*.",
    });
    return null;
  }
  return state;
}

// Action commune : sous verrou (meow.js), puis vue éphémère et, si la
// carte a changé, message officiel réédité.
async function executer(
  webhookUrl,
  discordId,
  username,
  action,
  { rafraichir = false, annonce = false, inscription = false, vue = {} } = {},
) {
  const state = await guardActive(webhookUrl, { annonce });
  if (!state) return;
  if (inscription && inscriptionsCloses(state)) {
    const dejaInscrit = !!(await readPartie()).joueurs[discordId];
    await patchOriginal(webhookUrl, {
      content: dejaInscrit
        ? "🔒 Les inscriptions sont closes : tu es bien inscrit."
        : "🔒 Les inscriptions sont closes : tu ne participes pas à cette partie. Rendez-vous à la prochaine !",
    });
    await cloturerInscriptions();
    return;
  }
  const config = await loadMeowConfig();
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
  const builder = vue.ecran === "bande" ? buildBandeView : buildJouerView;
  await patchOriginal(
    webhookUrl,
    builder(config, r.partie, discordId, {
      ...vue,
      ...(r.resultat || {}),
      nouveau: r.nouveau,
    }),
  );
  if (rafraichir || r.resultat?.rafraichir || r.nouveau)
    await rafraichirMessage(state, r.partie);
}

// ── Boutons du message officiel (nouvel éphémère) ────────────────────

export async function handleParticiper(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => ({}), {
      annonce: true,
      inscription: true,
    });
  } catch (err) {
    console.error("[Meow] Échec inscription:", err.message);
  }
}

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
    if (inscriptionsCloses(state)) {
      await patchOriginal(webhookUrl, {
        content:
          "🔒 Les inscriptions sont closes, il n'est plus possible de se désinscrire.",
      });
      await cloturerInscriptions();
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
    console.error("[Meow] Échec désinscription:", err.message);
  }
}

// [🐾 Jouer] et bouton « Annuler » (retour à la vue).
export async function handleJouer(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => ({}));
  } catch (err) {
    console.error("[Meow] Échec Jouer:", err.message);
  }
}

// ── Composants de l'éphémère (édition en place) ──────────────────────

// Menu « Appeler tes chats sur… » : choix du nombre ensuite.
// Menu « Appeler tes chats sur… » : toute la réserve y va (décision du
// 16/10 : pas de quantité à choisir).
export async function handleAppelCoin(webhookUrl, discordId, username, coin) {
  try {
    await executer(webhookUrl, discordId, username, (partie) => {
      const r = appeler(
        partie,
        discordId,
        coin,
        partie.joueurs[discordId]?.stock ?? 0,
      );
      return r.erreur
        ? { entete: avertissement(r.erreur) }
        : {
            entete: `🐱 ${chats(r.n)} appelé${r.n > 1 ? "s" : ""} sur **${nomCoin(coin)}**.`,
            rafraichir: true,
          };
    });
  } catch (err) {
    console.error("[Meow] Échec appel:", err.message);
  }
}

// Menu « Squatter un coin voisin… » : première manche jouée aussitôt.
export async function handleSquat(webhookUrl, discordId, username, valeur) {
  try {
    const [s, t] = String(valeur ?? "").split(">");
    await executer(webhookUrl, discordId, username, (partie, config) => {
      const r = lancerSquat(partie, discordId, s, t, { config });
      if (r.erreur) return { entete: avertissement(r.erreur) };
      const j = partie.joueurs[discordId];
      if (!r.fin) return {};
      return {
        entete: `${texteManche(r.manche, j.bande, r.fin.def)}\n${texteFin(r.fin)}`,
        issue: r.fin.issue,
        rafraichir: true,
      };
    });
  } catch (err) {
    console.error("[Meow] Échec squat:", err.message);
  }
}

// Menu « Déplacer un chat… ».
export async function handleDeplacer(webhookUrl, discordId, username, valeur) {
  try {
    const [s, t] = String(valeur ?? "").split(">");
    await executer(webhookUrl, discordId, username, (partie, config) => {
      const r = deplacer(partie, discordId, s, t, { config });
      return r.erreur
        ? { entete: avertissement(r.erreur) }
        : {
            entete: `🚚 1 chat déplacé de **${nomCoin(s)}** vers **${nomCoin(t)}**.`,
            rafraichir: true,
          };
    });
  } catch (err) {
    console.error("[Meow] Échec déplacement:", err.message);
  }
}

// Boutons du crêpage de poils.
export async function handleCombat(webhookUrl, discordId, username, action) {
  try {
    await executer(webhookUrl, discordId, username, (partie) => {
      const c = partie.combats[discordId];
      const def = c?.def;
      const r =
        action === "retraite"
          ? retraite(partie, discordId)
          : action === "bout"
            ? jusquauBout(partie, discordId)
            : jouerManche(partie, discordId);
      if (r.erreur) return { entete: avertissement(r.erreur) };
      if (!r.fin) return {};
      const j = partie.joueurs[discordId];
      const manche = r.manche ? `${texteManche(r.manche, j.bande, def)}\n` : "";
      return { entete: `${manche}${texteFin(r.fin)}`, issue: r.fin.issue, rafraichir: true };
    });
  } catch (err) {
    console.error("[Meow] Échec crêpage de poils:", err.message);
  }
}

// [💬 Ma bande] (message du jour ou vue Jouer) : messages marqués lus.
export async function handleBande(webhookUrl, discordId, username) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie) => (marquerLus(partie, discordId), {}),
      { vue: { ecran: "bande" } },
    );
  } catch (err) {
    console.error("[Meow] Échec Ma bande:", err.message);
  }
}

// Envoi de la fenêtre « Écrire » ; quota revérifié ici (le bouton grisé
// n'est qu'une aide visuelle).
export async function handleMessageSubmit(
  webhookUrl,
  discordId,
  username,
  texte,
) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = posterMessage(partie, discordId, texte, { config });
        if (r.erreur === "messageVide")
          return { entete: "⚠️ Message vide, rien n'a été envoyé." };
        if (r.erreur === "plafondMessages")
          return {
            entete: `⚠️ Tu as envoyé tes ${config.messages_par_jour} messages du jour, reviens demain.`,
          };
        if (r.erreur) return { entete: avertissement(r.erreur) };
        return { entete: "📬 Message envoyé à ta bande !" };
      },
      { vue: { ecran: "bande" } },
    );
  } catch (err) {
    console.error("[Meow] Échec envoi de message:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) ───────────────────────────────────

// Ce qui concerne le joueur et sa bande (ses squats, ceux qui visent sa
// bande, croquettes, décomptes), regroupé par jour, du plus récent au plus
// ancien.
export async function handleJournal(webhookUrl, discordId) {
  try {
    const [state, partie] = await Promise.all([readState(), readPartie()]);
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Meow en cours.",
      });
      return;
    }
    const j = partie.joueurs[discordId];
    if (j?.bande == null) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne participes pas à cette partie.",
      });
      return;
    }
    // Ce qui concerne sa bande (décision du 16/10) : territoires pris par la
    // bande, territoires perdus, retraites de la bande, croquettes regroupées
    // par jour ; aujourd'hui et hier seulement.
    const jourCourant = jourDe(partie, horloge(partie));
    const lignesDuJour = (jour) => {
      const evts = partie.journal.filter((e) => e.j === jour);
      const lignes = evts
        .filter(
          (e) =>
            e.k === "squat" &&
            ((e.b === j.bande &&
              (e.issue === "victoire" || e.issue.startsWith("retraite"))) ||
              (e.def === j.bande && e.issue === "victoire")),
        )
        .map((e) => {
          const { h, min } = parisParts(e.t);
          return `\`${h}h${String(min).padStart(2, "0")}\` ${texteJournal(partie, e)}`;
        })
        .reverse();
      lignes.push(...evts.filter((e) => e.k === "mercenaires" && e.b === j.bande).map((e) => texteJournal(partie, e)));
      const croquettes = evts.filter(
        (e) => e.k === "croquettes" && e.b === j.bande,
      );
      if (croquettes.length) {
        const parPiece = [...new Set(croquettes.map((e) => e.piece))].map(
          (p) => PIECES[p].nom,
        );
        lignes.push(
          `🍖 Croquettes : +${croquettes.reduce((t, e) => t + e.n, 0)} (${parPiece.join(", ")})`,
        );
      }
      return lignes;
    };
    const blocs = [jourCourant, jourCourant - 1]
      .filter((n) => n >= 1)
      .map((n) => ({ n, lignes: lignesDuJour(n) }))
      .filter((b) => b.lignes.length)
      .map((b) =>
        [
          `**${b.n === jourCourant ? "Aujourd'hui" : "Hier"}**`,
          ...b.lignes,
        ].join("\n"),
      );
    const description = blocs.join("\n\n").slice(0, 4000);
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: `📜 Journal des ${BANDES[j.bande].nom}`,
          description: description.trim() || "Rien à signaler pour l'instant.",
          color: MEOW_COLOR,
        },
      ],
    });
  } catch (err) {
    console.error("[Meow] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadMeowConfig())],
    });
  } catch (err) {
    console.error("[Meow] Échec Règles:", err.message);
  }
}
