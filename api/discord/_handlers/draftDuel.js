// ============================================================
// draftDuel.js — Handlers Discord du jeu Duel « Draft » (1 à 3 joueurs,
// 7 manches), lancé à la demande via /draft. Version duel du Draft Royale
// (mêmes règles : carré de 4 cartes identiques, échange au marché).
//
// Même structure que _handlers/gobeletDuel.js : message public ÉDITÉ EN
// PLACE à chaque avancée (marché de la manche en image), main éphémère par
// joueur (menus de l'échange, Fin de tour). En fin de partie, le
// récapitulatif est reposté dans un nouveau message et l'original
// supprimé. custom_id préfixés `draftduel_*`, état Redis dans
// backend/services/draftDuel.js (`draftduel:*`).
// ============================================================

import {
  readState,
  writeState,
  startGame,
  joinGame,
  choisir,
  choisirJoker,
  finirTour,
  checkAndResolveManche,
  readPlayers,
  readActions,
  readHighScore,
  readPlayerView,
  readHandWebhooks,
  expireIfStale,
  loadDraftDuelConfig,
  BOTS,
  isBot,
} from "../../../backend/services/draftDuel.js";
import { loadCatalog } from "../../../backend/services/draftroyale.js";
import { compterCartes, pointsMain, trierMain } from "../../../backend/services/draftRules.js";
import { echangeLigne, jokerButton, jokerPointsLabel, jokerStatutLigne, buildMagasin, jokerBilanLignes, JOKER_EMOJI } from "./draftJoker.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const DRAFTDUEL_COLOR = 0x2f5bd3;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// ── Emojis personnalisés (emojis d'application TrustRoyale) ─────────

function appEmoji(name, id) {
  return { text: `<:${name}:${id}>`, component: { name, id } };
}

const EMOJI = {
  trade: appEmoji("trade", "1493849418611294279"),
  cards: appEmoji("cards", "1493711279121104926"),
  stats: appEmoji("stats", "1499284927894650950"),
  members: appEmoji("members", "1506175789731811399"),
  check: appEmoji("check", "1504136472872222761"),
  late: appEmoji("late", "1504138659622948985"),
  trophy: appEmoji("trophy", "1498645869224792105"),
  topplayers: appEmoji("topplayers", "1493708397407899648"),
  scroll: appEmoji("scroll", "1493850130560847892"),
  bot: appEmoji("dragon", "1504136471408541706"),
  warning: appEmoji("warning", "1499002725965500577"),
};

// ── Cartes ──────────────────────────────────────────────────────────

function cardName(key, catalog) {
  return catalog.get(key)?.fr || key;
}

// « Princesse ×2 · Géant ×1 », les plus gros groupes d'abord.
function formatGroupes(keys, catalog) {
  return [...compterCartes(keys)]
    .sort((a, b) => b[1] - a[1] || cardName(a[0], catalog).localeCompare(cardName(b[0], catalog)))
    .map(([k, n]) => `${cardName(k, catalog)} ×${n}`)
    .join(" · ");
}

function groupOptions(keys, catalog, suffixe, selected) {
  return [...compterCartes(keys)]
    .sort((a, b) => cardName(a[0], catalog).localeCompare(cardName(b[0], catalog)))
    .slice(0, 25)
    .map(([k, n]) => ({
      label: cardName(k, catalog).slice(0, 100),
      description: `×${n} ${suffixe}`,
      value: k,
      default: k === selected || undefined,
    }));
}

function plural(n, word) {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

async function displayName(id, fallback) {
  if (isBot(id)) return BOTS.find((b) => b.id === id).name;
  return resolveDisplayName(id, fallback);
}

// Images rendues sans état à partir des clés passées dans l'URL.
function marcheImageUrl(marche) {
  if (!marche?.length) return null;
  return `${TRUST_ROYALE_URL}/api/draft/marche?${new URLSearchParams({ c: [...marche].sort().join("|") })}`;
}

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/draftroyale/illustration`;
}

function mainImageUrl(keys) {
  if (!keys?.length) return null;
  return `${TRUST_ROYALE_URL}/api/draftroyale/main?${new URLSearchParams({ c: keys.join("|") })}`;
}

// ── Membres et rôles ─────────────────────────────────────────────────

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick ||
    body.member?.user?.global_name ||
    body.member?.user?.username ||
    "Inconnu";
  return { discordId, username };
}

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

// ── Messages Discord ─────────────────────────────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[DraftDuel] Échec PATCH:", err.message);
  }
}

async function deleteOriginal(webhookUrl) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, { method: "DELETE" });
  } catch (err) {
    console.error("[DraftDuel] Échec DELETE:", err.message);
  }
}

// `files` : [{ buffer, filename }] envoyés en pièces jointes (multipart),
// référencés dans l'embed par `attachment://<filename>`
function buildMessageRequest(payload, files) {
  const headers = { Authorization: `Bot ${process.env.DISCORD_TOKEN}` };
  if (!files.length)
    return {
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  const body = new FormData();
  body.append(
    "payload_json",
    JSON.stringify({
      ...payload,
      attachments: files.map((f, i) => ({ id: i, filename: f.filename })),
    }),
  );
  files.forEach((f, i) =>
    body.append(
      `files[${i}]`,
      new Blob([f.buffer], { type: "image/png" }),
      f.filename,
    ),
  );
  return { headers, body };
}

async function patchPublicMessage(state, payload, files = []) {
  if (!process.env.DISCORD_TOKEN || !state?.channelId || !state?.messageId)
    return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        ...buildMessageRequest(payload, files),
      },
    );
    if (!res.ok)
      console.warn(
        `[DraftDuel] Échec édition du message public (${res.status}).`,
      );
  } catch (err) {
    console.warn(
      "[DraftDuel] Erreur réseau à l'édition du message public:",
      err.message,
    );
  }
}

async function postChannelMessage(channelId, payload, files = []) {
  if (!process.env.DISCORD_TOKEN || !channelId) return false;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        ...buildMessageRequest(payload, files),
      },
    );
    if (!res.ok)
      console.warn(`[DraftDuel] Échec envoi du récapitulatif (${res.status}).`);
    return res.ok;
  } catch (err) {
    console.warn(
      "[DraftDuel] Erreur réseau à l'envoi du récapitulatif:",
      err.message,
    );
    return false;
  }
}

async function deletePublicMessage(state) {
  if (!process.env.DISCORD_TOKEN || !state?.channelId || !state?.messageId)
    return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      },
    );
    if (!res.ok && res.status !== 404)
      console.warn(
        `[DraftDuel] Échec suppression du message de la partie (${res.status}).`,
      );
  } catch (err) {
    console.warn(
      "[DraftDuel] Erreur réseau à la suppression du message de la partie:",
      err.message,
    );
  }
}

function textPayload(content) {
  return { content, embeds: [], components: [] };
}

// ── Message public ──────────────────────────────────────────────────

// Jamais désactivé : Jouer sert aussi aux joueurs inscrits à rouvrir leur
// main à chaque manche (même principe que les autres duels).
function buildJoinComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Jouer",
          emoji: EMOJI.cards.component,
          custom_id: "draftduel_jouer",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: EMOJI.scroll.component,
          custom_id: "draftduel_regles",
        },
      ],
    },
  ];
}

function buildEndComponents(state) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: EMOJI.scroll.component,
          custom_id: "draftduel_regles",
        },
        {
          type: 2,
          style: 2,
          label: "Détails",
          emoji: EMOJI.stats.component,
          custom_id: `draftduel_details:${state.messageId}`,
        },
      ],
    },
  ];
}

async function buildPlayersLines(state, players, actions) {
  const ids = [...state.players, ...BOTS.map((b) => b.id).filter((id) => players[id])];
  const lines = [`${EMOJI.members.text} **Joueurs**`];
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    const name = await displayName(id, p.username);
    const status = isBot(id) ? EMOJI.bot.text : actions[id]?.fini ? EMOJI.check.text : EMOJI.late.text;
    lines.push(`${status} **${name}** · ${plural(p.points || 0, "pt")}${p.carres ? ` · ${plural(p.carres, "quadruplé")}` : ""}`);
  }
  const missing = state.maxPlayers - state.players.length;
  if (missing > 0) lines.push(`${EMOJI.late.text} En attente de ${plural(missing, "joueur")}`);
  return lines;
}

async function buildTableEmbed(state) {
  const [config, players, actions] = await Promise.all([loadDraftDuelConfig(), readPlayers(), readActions(state.manche)]);
  // Infos générales uniquement : la manche en cours (main, marché, bilan
  // de la manche précédente) est dans la main éphémère
  const lines = [
    `Réunis ${config.taille_main} cartes identiques ! Clique sur **Jouer** pour voir ta main, le marché et la manche précédente.`,
    "",
    ...(await buildPlayersLines(state, players, actions)),
  ];
  return {
    title: `Draft · Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n").slice(0, 4096),
    color: DRAFTDUEL_COLOR,
    image: { url: illustrationUrl() },
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes, la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

async function buildFinalEmbed(state, { expired = false } = {}) {
  const highScore = await readHighScore();
  const ranking = state.finalRanking || [];
  const lines = expired
    ? [
        `${EMOJI.late.text} Partie expirée après ${state.staleHours ?? 2}h d'inactivité (manche ${state.manche}/${state.totalManches}).`,
        "",
      ]
    : [];
  lines.push(`${EMOJI.topplayers.text} **Classement final**`);
  for (const [i, r] of ranking.entries()) {
    const name = await displayName(r.discordId, r.username);
    lines.push(`${i === 0 ? `${EMOJI.trophy.text} ` : `${i + 1}. `}**${name}** · ${plural(r.score, "pt")}${r.carres ? ` · ${plural(r.carres, "quadruplé")}` : ""}`);
  }
  if (highScore && !expired) {
    const name = await resolveDisplayName(highScore.discordId, highScore.username);
    lines.push("", `${EMOJI.topplayers.text} High score : ${name} (${plural(highScore.points, "pt")})`);
  }
  return {
    title: "Draft · Partie terminée",
    description: lines.join("\n").slice(0, 4096),
    color: DRAFTDUEL_COLOR,
  };
}

// Fin de partie : récapitulatif dans un NOUVEAU post, puis suppression du
// message de la partie (`state.messageId` reste l'identifiant de la partie
// pour le bouton Détails). Une éventuelle image est jointe au message :
// par simple URL, le proxy Discord abandonnait parfois pendant le rendu à
// froid (voir l'historique du duel Élixir). Repli sur l'URL sinon.
async function postFinalMessage(state, embed) {
  const payload = { embeds: [embed], components: buildEndComponents(state) };
  const url = embed.image?.url;
  let files = [];
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const filename = "draft.png";
        files = [{ buffer: Buffer.from(await res.arrayBuffer()), filename }];
        payload.embeds = [
          { ...embed, image: { url: `attachment://${filename}` } },
        ];
      }
    } catch (err) {
      console.warn(
        "[DraftDuel] Image indisponible, repli sur l'URL:",
        err.message,
      );
    }
  }
  if (await postChannelMessage(state.channelId, payload, files))
    await deletePublicMessage(state);
  else await patchPublicMessage(state, payload, files);
}

async function closeIfStale() {
  const result = await expireIfStale();
  if (!result.expired) return false;
  await postFinalMessage(
    result.state,
    await buildFinalEmbed(result.state, { expired: true }),
  );
  return true;
}

async function replyIfExpired(webhookUrl) {
  if (!(await closeIfStale())) return false;
  await patchOriginal(
    webhookUrl,
    textPayload("Cette partie de Draft a expiré faute d'activité."),
  );
  return true;
}

// Résout la manche si tout le monde a fini son tour, puis rafraîchit le
// message public en place.
async function refreshPublicMessage() {
  const outcome = await checkAndResolveManche();
  if (outcome.inactive) return outcome;
  if (outcome.resolved && outcome.final) {
    await postFinalMessage(outcome.state, await buildFinalEmbed(outcome.state));
    return outcome;
  }
  await patchPublicMessage(outcome.state, {
    embeds: [await buildTableEmbed(outcome.state)],
    components: buildJoinComponents(),
  });
  return outcome;
}

// ── Commande /draft ─────────────────────────────────────────────────

export async function handleDraftCommand(webhookUrl, body, { maxPlayers }) {
  try {
    const channelId = body.channel_id;
    await closeIfStale();
    const result = await startGame(channelId, { maxPlayers });
    if (result.alreadyActive) {
      await patchOriginal(
        webhookUrl,
        textPayload(
          `Une partie de Draft est déjà en cours dans <#${result.state.channelId}>. Attends qu'elle se termine (ou qu'elle expire faute d'activité).`,
        ),
      );
      return;
    }
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          embeds: [await buildTableEmbed(result.state)],
          components: buildJoinComponents(),
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
    }
    const message = await res.json();
    await writeState({ ...result.state, messageId: message.id });
    await deleteOriginal(webhookUrl);
  } catch (err) {
    console.error("[DraftDuel] Échec lancement:", err.message);
    await patchOriginal(
      webhookUrl,
      textPayload(
        `${EMOJI.warning.text} Erreur lors du lancement de la partie.`,
      ),
    );
  }
}

export async function handleDraftRoleRejected(webhookUrl) {
  await patchOriginal(
    webhookUrl,
    textPayload(
      "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
    ),
  );
}

// ── Main éphémère du joueur ─────────────────────────────────────────

// Bilan de la manche qui vient de se résoudre : échanges de chacun (prise
// et dépôt), carrés, décompte et nouvelle donne.
// Noms des joueurs (bots compris), « Toi » pour le joueur qui regarde.
async function nomsJoueurs(players, discordId) {
  const entries = await Promise.all(Object.entries(players).map(async ([id, p]) => [id, id === discordId ? "Toi" : await displayName(id, p.username)]));
  return Object.fromEntries(entries);
}

function buildRecapLines(lastRecap, noms, discordId, config, catalog) {
  if (!lastRecap) return [];
  const nom = (id) => noms[id] || "?";
  const lines = [`${EMOJI.stats.text} **Manche ${lastRecap.manche}**`];
  for (const l of lastRecap.lignes.filter((x) => x.type === "prise" || x.type === "perdue")) {
    lines.push(`${EMOJI.trade.text} ${echangeLigne(l, nom(l.discordId), (k) => cardName(k, catalog), config)}`);
  }
  if (lines.length === 1) lines.push("Aucun échange.");
  lines.push(...jokerBilanLignes(lastRecap.lignes, discordId, noms, (k) => cardName(k, catalog), (keys) => formatGroupes(keys, catalog), config));
  for (const s of (lastRecap.scores || []).filter((x) => x.carre)) {
    const [key] = [...compterCartes(s.main)].sort((a, b) => b[1] - a[1])[0] || [];
    lines.push(`🎉 Quadruplé de **${nom(s.discordId)}** (${cardName(key, catalog)}) : +${s.points} pts`);
  }
  const mien = lastRecap.scores?.find((x) => x.discordId === discordId && !x.carre);
  if (mien) lines.push(`Ton décompte : +${plural(mien.points, "pt")}`);
  if (lastRecap.redistribution) lines.push("🔄 Nouvelle donne : toutes les cartes ont été redistribuées.");
  return [...lines, ""];
}

function buildStatusLine(view) {
  const { state, action, me, complet, catalog } = view;
  if (!state.rosterLocked) return `${EMOJI.late.text} En attente des autres joueurs : le marché bouge encore à chaque arrivée.`;
  if (action.fini) return state.maxPlayers > 1 ? `${EMOJI.check.text} Tour terminé. En attente des autres joueurs.` : `${EMOJI.check.text} Tour terminé.`;
  if (complet) return `${EMOJI.trade.text} Tu prends **${cardName(action.prise, catalog)}** et tu déposes **${cardName(action.depot, catalog)}**. Valide avec Fin de tour.`;
  const prise = state.marche.includes(action.prise) ? action.prise : null;
  const depot = me.main.includes(action.depot) ? action.depot : null;
  if (prise) return `${EMOJI.trade.text} Tu prends **${cardName(prise, catalog)}** : choisis aussi la carte à déposer.`;
  if (depot) return `${EMOJI.trade.text} Tu déposes **${cardName(depot, catalog)}** : choisis aussi la carte à prendre.`;
  return `${EMOJI.trade.text} Choisis une carte à prendre au marché et une carte de ta main à déposer.`;
}

function buildHandEmbed(view, recap, noms) {
  const { state, me, config, catalog, action } = view;
  const main = trierMain(me.main);
  const lines = [
    ...recap,
    `**Ta main** : ${formatGroupes(main, catalog)}`,
    `Points au prochain décompte : ${plural(pointsMain(main, config), "pt")}`,
    `${EMOJI.trophy.text} Total : ${plural(me.points || 0, "pt")} · ${jokerPointsLabel(me.joker || 0)}`,
    "",
    buildStatusLine(view),
    jokerStatutLigne(action.joker, noms, (k) => cardName(k, catalog)),
  ].filter((l) => l !== null);
  const image = mainImageUrl(main);
  return {
    title: `Ton tour · Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n").slice(0, 4096),
    color: DRAFTDUEL_COLOR,
    image: image ? { url: image } : undefined,
  };
}

function buildHandComponents(view) {
  const { state, action, me, complet, catalog } = view;
  if (action.fini || !state.rosterLocked) return [];
  const manche = state.manche;
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `draftduel_prise:${manche}`,
          placeholder: "Carte à prendre au marché",
          options: groupOptions(state.marche, catalog, "au marché", action.prise),
        },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `draftduel_depot:${manche}`,
          placeholder: "Carte de ta main à déposer",
          options: groupOptions(me.main, catalog, "dans ta main", action.depot),
        },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Fin de tour",
          emoji: EMOJI.check.component,
          custom_id: `draftduel_fin:${manche}`,
          disabled: !complet,
        },
        jokerButton("draftduel", manche, me.joker || 0, action.joker),
      ],
    },
  ];
}

// Cartes du marché de la manche, visibles sans ouvrir les menus.
function buildMarcheEmbed(view) {
  const { state, catalog } = view;
  if (!state.marche?.length) return null;
  const image = marcheImageUrl(state.marche);
  return {
    title: "Marché",
    description: formatGroupes(state.marche, catalog),
    color: DRAFTDUEL_COLOR,
    image: image ? { url: image } : undefined,
  };
}

async function buildHandPayload(view) {
  const noms = await nomsJoueurs(view.players, view.discordId);
  const recap = buildRecapLines(view.state.lastRecap, noms, view.discordId, view.config, view.catalog);
  const embeds = [buildHandEmbed(view, recap, noms), buildMarcheEmbed(view)].filter(Boolean);
  return { content: "", embeds, components: buildHandComponents(view) };
}

// Réponses communes aux actions du tour. Renvoie true si l'action a abouti.
async function respondToAction(webhookUrl, result) {
  if (result.inactive) {
    await patchOriginal(
      webhookUrl,
      textPayload("Aucune partie de Draft en cours pour le moment."),
    );
    return false;
  }
  if (result.notSeated) {
    await patchOriginal(
      webhookUrl,
      textPayload("Clique d'abord sur **Jouer** pour rejoindre la partie !"),
    );
    return false;
  }
  await patchOriginal(webhookUrl, await buildHandPayload(result.view));
  return !result.alreadyDone && !result.invalid;
}

export async function handleJouer(webhookUrl, discordId, username) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    const result = await joinGame(discordId, username);
    if (result.inactive) {
      await patchOriginal(
        webhookUrl,
        textPayload("Aucune partie de Draft en cours pour le moment."),
      );
      return;
    }
    if (result.rosterLocked) {
      await patchOriginal(
        webhookUrl,
        textPayload(
          "Cette partie a déjà commencé (ou les places sont toutes prises), tu ne peux pas la rejoindre.",
        ),
      );
      return;
    }
    // Arrivée d'un joueur : le marché change, le message public d'abord
    if (result.isNew) await refreshPublicMessage();
    const view = await readPlayerView(result.state, discordId);
    await patchOriginal(webhookUrl, await buildHandPayload(view));
  } catch (err) {
    console.error("[DraftDuel] Échec Jouer:", err.message);
  }
}

// Magasin Joker : `champ` = ouvrir, retour, annuler, type, cible, carte
// ou maCarte (voir draftJoker.js). Hors tour (tour fini, joueurs en
// attente), la main s'affiche à la place.
export async function handleJoker(webhookUrl, discordId, champ, value) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    let result;
    if (champ === "retour" || champ === "ouvrir") {
      const state = await readState();
      if (!state || state.termine) result = { inactive: true };
      else if (!state.players.includes(discordId)) result = { notSeated: true };
      else result = { state, view: await readPlayerView(state, discordId) };
    } else {
      result = await choisirJoker(discordId, champ === "annuler" ? null : { [champ]: value });
    }
    const { view } = result;
    if (!view || champ === "retour" || view.action.fini || !view.state.rosterLocked) {
      await respondToAction(webhookUrl, result);
      return;
    }
    const noms = await nomsJoueurs(view.players, discordId);
    const vue = buildMagasin({
      prefixe: "draftduel",
      tour: view.state.manche,
      points: view.me.joker || 0,
      joker: view.action.joker,
      adversaires: Object.keys(view.players)
        .filter((id) => id !== discordId)
        .map((id) => ({ id, nom: noms[id] })),
      main: view.me.main,
      familles: view.state.familles,
      config: view.config,
      cardName: (k) => cardName(k, view.catalog),
      noms,
      color: DRAFTDUEL_COLOR,
    });
    if (result.invalid) vue.embeds[0].description = `${EMOJI.warning.text} Choix impossible.\n\n${vue.embeds[0].description}`;
    await patchOriginal(webhookUrl, vue);
  } catch (err) {
    console.error("[DraftDuel] Échec Joker:", err.message);
  }
}

// Menus de l'échange : `champ` = "prise" ou "depot".
export async function handleChoix(webhookUrl, discordId, champ, key) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    await respondToAction(webhookUrl, await choisir(discordId, champ, key));
  } catch (err) {
    console.error("[DraftDuel] Échec choix:", err.message);
  }
}

// Main d'un joueur juste après la résolution : bilan de la manche puis
// tour suivant (ou renvoi au classement final).
async function buildPostResolutionPayload(outcome, discordId, catalog) {
  if (outcome.final) {
    const players = await readPlayers();
    const recap = buildRecapLines(outcome.state.lastRecap, await nomsJoueurs(players, discordId), discordId, await loadDraftDuelConfig(), catalog);
    return {
      content: "",
      embeds: [
        {
          title: "Draft · Partie terminée",
          description: [
            ...recap,
            `${EMOJI.topplayers.text} Le classement final est affiché dans le salon.`,
          ].join("\n"),
          color: DRAFTDUEL_COLOR,
        },
      ],
      components: [],
    };
  }
  return buildHandPayload(await readPlayerView(outcome.state, discordId));
}

// Après une fin de tour : résout la manche si tout le monde a fini. Si
// c'est le cas, la main éphémère de CHAQUE joueur passe directement à la
// manche suivante (via le webhook de sa fin de tour, valable 15 min ; au
// delà, Jouer reste le recours).
async function continueAfterTurn(webhookUrl, discordId) {
  const outcome = await refreshPublicMessage();
  if (!outcome?.resolved) return;
  const [catalog, webhooks] = await Promise.all([
    loadCatalog(),
    readHandWebhooks(outcome.state.lastRecap.manche),
  ]);
  const targets = { ...webhooks, [discordId]: webhookUrl };
  await Promise.all(
    Object.entries(targets).map(async ([id, url]) =>
      patchOriginal(
        url,
        await buildPostResolutionPayload(outcome, id, catalog),
      ),
    ),
  );
}

export async function handleFinTour(webhookUrl, discordId) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    if (
      await respondToAction(webhookUrl, await finirTour(discordId, webhookUrl))
    )
      await continueAfterTurn(webhookUrl, discordId);
  } catch (err) {
    console.error("[DraftDuel] Échec fin de tour:", err.message);
  }
}

// ── Bouton [Détails] (fin de partie) ─────────────────────────────────

export async function handleDetails(webhookUrl, messageId) {
  try {
    const state = await readState();
    if (
      !state?.termine ||
      !state.finalRanking ||
      state.messageId !== messageId
    ) {
      await patchOriginal(
        webhookUrl,
        textPayload("Les détails de cette partie ne sont plus disponibles."),
      );
      return;
    }
    const lines = [];
    for (const [i, r] of state.finalRanking.entries()) {
      const name = await displayName(r.discordId, r.username);
      lines.push(
        `${i === 0 ? EMOJI.trophy.text : `${i + 1}.`} **${name}** · ${plural(r.score, "pt")}`,
      );
      lines.push(`• ${plural(r.carres || 0, "quadruplé")} · ${plural(r.joker || 0, "point")} Joker`);
      lines.push("");
    }
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: "Draft · Détail des scores",
          description: lines.join("\n").trim().slice(0, 4096),
          color: DRAFTDUEL_COLOR,
        },
      ],
      components: [],
    });
  } catch (err) {
    console.error("[DraftDuel] Échec Détails:", err.message);
  }
}

// ── Bouton [Règles] ──────────────────────────────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "Règles du jeu : Draft",
    description: [
      `Réunis **${config.taille_main} exemplaires d'une même carte** (un quadruplé) en ${config.duel.manches} manches, de 1 à 3 joueurs. Des bots complètent la table jusqu'à 3 joueurs.`,
      "",
      `Chaque carte en jeu existe en ${config.exemplaires} exemplaires. Tu reçois ${config.taille_main} cartes. Le marché contient une carte par joueur, visible par tous (les autres exemplaires restent à l'écart jusqu'à la prochaine donne).`,
      "",
      "**À chaque manche**",
      `${EMOJI.trade.text} **Échange** (obligatoire) : choisis une carte à prendre au marché et une carte de ta main à y déposer.`,
      `${EMOJI.check.text} **Fin de tour** : la manche se résout quand tous les joueurs ont validé. Les échanges ont lieu en même temps.`,
      "",
      `**Carte disputée** : si plusieurs joueurs veulent la même carte et qu'il n'y en a pas assez, celui qui a le plus de points Joker l'emporte (tirage au sort à égalité). Les autres reçoivent une autre carte du marché au hasard et gagnent +${config.joker.gain_perte} points Joker.`,
      "",
      `**${JOKER_EMOJI} Joker** : dépense tes points au magasin (une action par manche, résolue en fin de manche) : Priorité, Protéger, Voir main, Saboter, Échanger carte.`,
      "",
      `**Quadruplé** : dès qu'un joueur a ${config.taille_main} cartes identiques, il marque ${config.points_carre} pts, les autres 1, 2 ou 3 pts selon leur plus grand nombre de cartes identiques. Puis toutes les cartes sont redistribuées. À la dernière manche, tout le monde marque ses points.`,
    ].join("\n"),
    color: DRAFTDUEL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await closeIfStale();
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadDraftDuelConfig())],
      components: [],
    });
  } catch (err) {
    console.error("[DraftDuel] Échec Règles:", err.message);
  }
}
