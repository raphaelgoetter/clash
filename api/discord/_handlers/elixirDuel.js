// ============================================================
// elixirDuel.js — Handlers Discord du jeu Duel « Élixir » (1 à 3 joueurs,
// N manches), lancé à la demande via /elixir.
//
// Même structure que _handlers/gobeletDuel.js : message public ÉDITÉ EN
// PLACE à chaque avancée (jamais supprimé/reposté), main éphémère par
// joueur. custom_id préfixés `elixirduel_*`, état Redis dans
// backend/services/elixirDuel.js (`elixirduel:*`), règles pures dans
// backend/services/elixirRules.js.
//
// Main éphémère : un menu « Carte » puis un menu « Mise » (de la mise
// minimale jusqu'à 24 au-dessus, dans la limite du stock), puis Valider ou
// Passer. Les offres restent secrètes jusqu'à la résolution, où toutes les
// mises sont révélées dans le bilan public.
// ============================================================

import {
  readState,
  writeState,
  startGame,
  joinGame,
  selectCard,
  selectBid,
  validateOffer,
  passOffer,
  checkAndResolveManche,
  readPlayers,
  readOffers,
  readCurrentScores,
  readHighScore,
  readPlayerView,
  loadCatalog,
  mancheCards,
  expireIfStale,
  BOT_ID,
  BOT_NAME,
} from "../../../backend/services/elixirDuel.js";
import {
  STARTING_ELIXIR,
  ELIXIR_PER_MANCHE,
  ELIXIR_CAP,
  OBJECTIVES,
  MAJORITIES,
  SPECIALS,
  resolveCard,
  computeFinalScores,
} from "../../../backend/services/elixirRules.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const ELIXIRDUEL_COLOR = 0xd63bd6;
const MAX_BID_OPTIONS = 25;

// ── Emojis personnalisés (emojis d'application TrustRoyale) ─────────

// Goutte d'élixir : uploadée via `node scripts/uploadElixirEmojis.js`, qui
// affiche l'ID à reporter ici. Repli sur 💧 tant qu'elle n'existe pas.
const ELIXIR_EMOJI_ID = null;

function appEmoji(name, id) {
  return { text: `<:${name}:${id}>`, component: { name, id } };
}

const EMOJI = {
  elixir: ELIXIR_EMOJI_ID ? appEmoji("elixir", ELIXIR_EMOJI_ID) : { text: "💧", component: { name: "💧" } },
  cards: appEmoji("cards", "1493711279121104926"),
  stats: appEmoji("stats", "1499284927894650950"),
  members: appEmoji("members", "1506175789731811399"),
  check: appEmoji("check", "1504136472872222761"),
  late: appEmoji("late", "1504138659622948985"),
  trophy: appEmoji("trophy", "1498645869224792105"),
  topplayers: appEmoji("topplayers", "1493708397407899648"),
  victory: appEmoji("victory", "1504136468900352070"),
  boohoo: appEmoji("boohoo", "1493849412387209357"),
  bye: appEmoji("bye", "1493849413901222019"),
  scroll: appEmoji("scroll", "1493850130560847892"),
  battle: appEmoji("battle", "1493710671244689449"),
  exclamation: appEmoji("exclamation", "1493849415235014678"),
  question: appEmoji("question", "1493704366786482376"),
  bot: appEmoji("dragon", "1504136471408541706"),
  warning: appEmoji("warning", "1499002725965500577"),
};

const ELIXIR = EMOJI.elixir.text;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// ── Rendu des cartes ────────────────────────────────────────────────

const TYPE_LABELS = { troop: "Troupe", flying: "Volant", spell: "Sort", building: "Bâtiment" };
const FAMILY_LABELS = { goblin: "Gobelin", skeleton: "Squelette", human: "Humain", minion: "Gargouille" };
const RARITY_LABELS = {
  common: "Commune",
  rare: "Rare",
  epic: "Épique",
  legendary: "Légendaire",
  champion: "Champion",
};

function cardTags(card) {
  const tags = [TYPE_LABELS[card.type]];
  if (card.family) tags.push(FAMILY_LABELS[card.family]);
  if (card.rarity === "champion" || card.rarity === "legendary") tags.push(RARITY_LABELS[card.rarity]);
  return tags.join(" · ");
}

// Illustrations, coût et nom sont sur l'image : le texte ne garde que ce
// qui compte pour les objectifs (type, famille, rareté notable)
function formatCardLine(card) {
  if (card.special) {
    const special = Object.values(SPECIALS).find((s) => s.key === card.key);
    return `**${card.fr}** · carte spéciale · ${special.description}`;
  }
  return `**${card.fr}** · ${cardTags(card)}`;
}

function shortCardName(key, catalog) {
  const card = resolveCard(key, catalog);
  if (!card) return key;
  return card.key === SPECIALS.joker.key ? `${EMOJI.question.text} Joker` : card.fr;
}

function formatCollection(keys, catalog) {
  return keys.length ? keys.map((k) => shortCardName(k, catalog)).join(" · ") : "*aucune carte*";
}

function plural(n, word) {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

async function displayName(id, fallback) {
  if (id === BOT_ID) return BOT_NAME;
  return resolveDisplayName(id, fallback);
}

// Image des cartes de la manche (+ aperçu de la suivante), rendue par
// backend/services/elixirImage.js. Les clés dans l'URL suffisent au rendu.
function cardsImageUrl(state, manche) {
  const current = state.deck?.[manche - 1];
  if (!current) return null;
  const next = state.deck?.[manche] ?? [];
  const params = new URLSearchParams({ c: current.join("|"), n: next.join("|") });
  return `${TRUST_ROYALE_URL}/api/elixir/image?${params}`;
}

// ── Résolution des rôles/utilisateurs ────────────────────────────────

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
  return { discordId, username };
}

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

// ── Édition en place (réponses aux interactions) ──────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[ElixirDuel] Échec PATCH:", err.message);
  }
}

async function deleteOriginal(webhookUrl) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, { method: "DELETE" });
  } catch (err) {
    console.error("[ElixirDuel] Échec DELETE:", err.message);
  }
}

async function patchPublicMessage(state, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId || !state?.messageId) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`[ElixirDuel] Échec édition du message public (${res.status}).`);
  } catch (err) {
    console.warn("[ElixirDuel] Erreur réseau à l'édition du message public:", err.message);
  }
}

function textPayload(content) {
  return { content, embeds: [], components: [] };
}

// ── Message public ──────────────────────────────────────────────────

// Jamais désactivé : Jouer sert aussi aux joueurs inscrits à rouvrir leur
// offre à chaque manche (même principe que les autres duels).
function buildJoinComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Jouer", emoji: EMOJI.elixir.component, custom_id: "elixirduel_jouer" },
        { type: 2, style: 2, label: "Règles", emoji: EMOJI.scroll.component, custom_id: "elixirduel_regles" },
      ],
    },
  ];
}

// Fin de partie : plus de bouton Jouer, seulement Règles et Détails des
// scores. L'ID du message dans le custom_id de Détails permet de refuser un
// clic sur une ancienne partie une fois la suivante lancée.
function buildEndComponents(state) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Règles", emoji: EMOJI.scroll.component, custom_id: "elixirduel_regles" },
        {
          type: 2,
          style: 2,
          label: "Détails",
          emoji: EMOJI.stats.component,
          custom_id: `elixirduel_details:${state.messageId}`,
        },
      ],
    },
  ];
}

// Image de la collection d'un joueur (vainqueur en fin de partie)
function collectionImageUrl(keys) {
  if (!keys?.length) return null;
  const params = new URLSearchParams({ mode: "collection", c: keys.join("|") });
  return `${TRUST_ROYALE_URL}/api/elixir/image?${params}`;
}

// Bilan de la manche résolue : toutes les mises sont révélées
async function buildResultsLines(lastResults, players, catalog) {
  if (!lastResults) return [];
  const names = {};
  for (const id of Object.keys(players)) names[id] = await displayName(id, players[id]?.username);

  const lines = [`${EMOJI.stats.text} **Bilan de la manche ${lastResults.manche}**`];
  for (const r of lastResults.results) {
    const label = shortCardName(r.key, catalog);
    const bids = r.bidders.map((b) => `${names[b.id] ?? "?"} ${b.bid}${b.effective !== b.bid ? " (Rage x2)" : ""}`);
    if (r.winner) {
      const others = bids.slice(1);
      lines.push(
        `${EMOJI.victory.text} **${label}** pour **${names[r.winner]}** (${r.price} ${ELIXIR})${others.length ? ` · ${others.join(", ")}` : ""}`,
      );
    } else if (r.tie) {
      lines.push(`${EMOJI.boohoo.text} **${label}** : égalité (${bids.join(", ")}), carte défaussée`);
    }
  }
  const passers = Object.entries(lastResults.offers || {})
    .filter(([, o]) => o && o.card == null)
    .map(([id]) => names[id] ?? "?");
  if (passers.length) lines.push(`${EMOJI.bye.text} ${passers.length > 1 ? "Ont passé" : "A passé"} : ${passers.join(", ")}`);
  if (lines.length === 1) lines.push("Aucune carte remportée.");
  lines.push("");
  return lines;
}

async function buildPlayersLines(state, players, offers, scores, catalog) {
  const scoreById = Object.fromEntries(scores.map((s) => [s.id, s.total]));
  const ids = [...state.players, ...(players[BOT_ID] ? [BOT_ID] : [])];
  const lines = [`${EMOJI.members.text} **Joueurs**`];
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    const name = await displayName(id, p.username);
    // Statut de l'offre : le bot a toujours déjà joué
    const status = id === BOT_ID ? EMOJI.bot.text : offers[id] ? EMOJI.check.text : EMOJI.late.text;
    const rage = p.rageNext ? ` · ${EMOJI.exclamation.text} Rage` : "";
    lines.push(`${status} **${name}** · ${p.stock} ${ELIXIR} · ${plural(scoreById[id] ?? 0, "pt")}${rage}`);
    lines.push(`└ ${formatCollection(p.collection, catalog)}`);
  }
  const missing = state.maxPlayers - state.players.length;
  if (missing > 0) lines.push(`${EMOJI.late.text} En attente de ${plural(missing, "joueur")}`);
  return lines;
}

async function buildTableEmbed(state) {
  const [players, offers, scores, catalog] = await Promise.all([
    readPlayers(),
    readOffers(state.manche),
    readCurrentScores(state),
    loadCatalog(),
  ]);
  const cards = mancheCards(state, state.manche, catalog);
  const isLast = state.manche >= state.totalManches;

  const lines = [
    ...(await buildResultsLines(state.lastResults, players, catalog)),
    `${EMOJI.cards.text} **Cartes aux enchères**${isLast ? " (dernière manche)" : ""}`,
    ...cards.map(formatCardLine),
    "",
    ...(await buildPlayersLines(state, players, offers, scores, catalog)),
  ];
  if (state.players.length === 0) lines.push("", "Clique sur **Jouer** pour t'inscrire.");

  return {
    title: `Élixir · Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n"),
    color: ELIXIRDUEL_COLOR,
    image: { url: cardsImageUrl(state, state.manche) },
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes, la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

async function buildRankingLines(ranking, players, catalog) {
  const lines = [];
  for (const [i, r] of ranking.entries()) {
    const name = await displayName(r.id, r.username);
    const medal = i === 0 ? `${EMOJI.trophy.text} ` : `${i + 1}. `;
    lines.push(`${medal}**${name}** · ${plural(r.total, "pt")}`);
    lines.push(`└ ${formatCollection(players[r.id]?.collection ?? [], catalog)}`);
  }
  return lines;
}

async function buildFinalEmbed(state, { expired = false } = {}) {
  const [players, catalog, highScore] = await Promise.all([readPlayers(), loadCatalog(), readHighScore(state.totalManches)]);
  const ranking = state.finalRanking ?? computeFinalScores(players, catalog, state.totalManches);
  const lines = expired
    ? [`${EMOJI.late.text} Partie expirée après 2h d'inactivité (manche ${state.manche}/${state.totalManches}).`, ""]
    : await buildResultsLines(state.lastResults, players, catalog);
  lines.push(`${EMOJI.topplayers.text} **Classement final**`, ...(await buildRankingLines(ranking, players, catalog)));
  const winnerImage = collectionImageUrl(players[ranking[0]?.id]?.collection);

  if (highScore && !expired) {
    const name = await resolveDisplayName(highScore.discordId, highScore.username);
    lines.push("", `${EMOJI.topplayers.text} High score : ${name} (${plural(highScore.points, "pt")})`);
  }
  return {
    title: `Élixir · Partie terminée (${state.totalManches} manches)`,
    description: lines.join("\n"),
    color: ELIXIRDUEL_COLOR,
    image: winnerImage ? { url: winnerImage } : undefined,
  };
}

// Clôture paresseuse, sans cron : une partie inactive depuis 2h est close
// et son message public repeint en "Partie terminée".
async function closeIfStale() {
  const result = await expireIfStale();
  if (!result.expired) return false;
  const embed = await buildFinalEmbed(result.state, { expired: true });
  await patchPublicMessage(result.state, { embeds: [embed], components: buildEndComponents(result.state) });
  return true;
}

async function replyIfExpired(webhookUrl) {
  if (!(await closeIfStale())) return false;
  await patchOriginal(webhookUrl, textPayload("Cette partie d'Élixir a expiré après 2h d'inactivité."));
  return true;
}

// Après une offre validée ou un passe : résout la manche si tout le monde a
// joué, puis rafraîchit le message public en place.
// Renvoie le résultat de checkAndResolveManche (pour enchaîner la main
// éphémère du joueur sur la manche suivante).
async function refreshPublicMessage() {
  const outcome = await checkAndResolveManche();
  if (outcome.inactive) return outcome;
  if (outcome.resolved && outcome.final) {
    const embed = await buildFinalEmbed(outcome.state);
    await patchPublicMessage(outcome.state, { embeds: [embed], components: buildEndComponents(outcome.state) });
    return outcome;
  }
  const embed = await buildTableEmbed(outcome.state);
  await patchPublicMessage(outcome.state, { embeds: [embed], components: buildJoinComponents() });
  return outcome;
}

// ── Commande /elixir ────────────────────────────────────────────────

export async function handleElixirCommand(webhookUrl, body, { maxPlayers, totalManches }) {
  try {
    const channelId = body.channel_id;
    // Repeint l'ancien message avant que startGame ne remplace la partie
    await closeIfStale();
    const result = await startGame(channelId, { maxPlayers, totalManches });

    if (result.alreadyActive) {
      await patchOriginal(
        webhookUrl,
        textPayload(
          `Une partie d'Élixir est déjà en cours dans <#${result.state.channelId}>. Attends qu'elle se termine (ou qu'elle expire après 2h d'inactivité).`,
        ),
      );
      return;
    }

    const embed = await buildTableEmbed(result.state);
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components: buildJoinComponents() }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
    }
    const message = await res.json();
    await writeState({ ...result.state, messageId: message.id });
    await deleteOriginal(webhookUrl);
  } catch (err) {
    console.error("[ElixirDuel] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, textPayload(`${EMOJI.warning.text} Erreur lors du lancement de la partie.`));
  }
}

export async function handleElixirRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, textPayload("Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie."));
}

// ── Main éphémère (offre du joueur) ─────────────────────────────────

function buildOfferStatus(view) {
  const { offer, draft, cards, state } = view;
  if (offer) {
    // En solo, le bot a déjà joué : la manche se résout aussitôt, pas
    // d'attente à annoncer
    const waiting = state.maxPlayers > 1 ? " En attente des autres joueurs." : "";
    if (offer.card == null) return `${EMOJI.bye.text} Tu passes cette manche.${waiting}`;
    return `${EMOJI.check.text} Offre envoyée : **${cards[offer.card].fr}** pour **${offer.bid}** ${ELIXIR}.${waiting}`;
  }
  if (draft.card == null) return "Choisis une carte, puis ta mise.";
  const card = cards[draft.card];
  if (draft.bid == null) return `**${card.fr}** : pas assez d'élixir (mise min ${card.minBid} ${ELIXIR}). Choisis une autre carte ou passe.`;
  return `Offre en préparation : **${card.fr}** pour **${draft.bid}** ${ELIXIR}. Clique sur **Valider** pour l'envoyer.`;
}

// Bilan de la manche qui vient de se résoudre, vu par le joueur : ce qu'il
// a remporté ou manqué, et ce que les autres ont remporté
async function buildMyRecap(lastResults, discordId, players, catalog) {
  if (!lastResults) return [];
  const lines = [`${EMOJI.stats.text} **Manche ${lastResults.manche}**`];
  const myOffer = lastResults.offers?.[discordId];
  if (!myOffer || myOffer.card == null) lines.push(`${EMOJI.bye.text} Tu as passé.`);
  for (const r of lastResults.results) {
    const label = shortCardName(r.key, catalog);
    const mine = myOffer?.card === r.index;
    if (r.winner === discordId) {
      lines.push(`${EMOJI.victory.text} Tu remportes **${label}** pour ${r.price} ${ELIXIR}.`);
    } else if (r.winner) {
      const name = await displayName(r.winner, players[r.winner]?.username);
      lines.push(`${mine ? EMOJI.boohoo.text : EMOJI.victory.text} **${label}** pour ${name} (${r.price} ${ELIXIR})${mine ? `, ta mise : ${myOffer.bid}` : ""}.`);
    } else if (r.tie) {
      lines.push(`${EMOJI.boohoo.text} Égalité sur **${label}**, carte défaussée.`);
    }
  }
  return [...lines, ""];
}

function buildHandEmbed(view) {
  const { state, me, players, catalog, offer } = view;
  const scores = computeFinalScores(players, catalog, state.totalManches);
  const myScore = scores.find((s) => s.id === view.discordId);
  const lines = [
    ...(view.recap ?? []),
    `${ELIXIR} Ton élixir : **${me.stock}**${me.rageNext ? ` · ${EMOJI.exclamation.text} Rage active (ta mise compte double)` : ""}`,
    `${EMOJI.cards.text} Ta collection : ${formatCollection(me.collection, catalog)}`,
    `${EMOJI.stats.text} Score actuel : **${plural(myScore?.total ?? 0, "pt")}**${myScore?.achieved.length ? ` (${myScore.achieved.map((a) => a.label).join(", ")})` : ""}`,
    "",
    buildOfferStatus(view),
  ];
  return {
    title: `Ton offre · Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n"),
    color: ELIXIRDUEL_COLOR,
    image: offer ? undefined : { url: cardsImageUrl(state, state.manche) },
  };
}

function buildHandComponents(view) {
  const { state, offer, draft, cards, me } = view;
  if (offer) return [];
  const manche = state.manche;
  const rows = [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `elixirduel_carte:${manche}`,
          placeholder: "Choisis une carte",
          options: cards.map((c, i) => ({
            label: `${c.fr} (min ${c.minBid} élixir)`.slice(0, 100),
            description: (c.special ? "Carte spéciale" : `${RARITY_LABELS[c.rarity]} · ${cardTags(c)}`).slice(0, 100),
            emoji: EMOJI.elixir.component,
            value: String(i),
            default: draft.card === i,
          })),
        },
      ],
    },
  ];

  const card = draft.card != null ? cards[draft.card] : null;
  if (card && card.minBid <= me.stock) {
    const max = Math.min(me.stock, card.minBid + MAX_BID_OPTIONS - 1);
    const options = [];
    for (let bid = card.minBid; bid <= max; bid++) {
      options.push({ label: `${bid} élixir`, value: String(bid), default: draft.bid === bid });
    }
    rows.push({ type: 1, components: [{ type: 3, custom_id: `elixirduel_mise:${manche}`, placeholder: "Choisis ta mise", options }] });
  }

  rows.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Valider",
        emoji: EMOJI.check.component,
        custom_id: `elixirduel_valider:${manche}`,
        disabled: draft.card == null || draft.bid == null,
      },
      { type: 2, style: 2, label: "Passer", emoji: EMOJI.bye.component, custom_id: `elixirduel_passer:${manche}` },
    ],
  });
  return rows;
}

function buildHandPayload(view, discordId) {
  const v = { ...view, discordId };
  return { content: "", embeds: [buildHandEmbed(v)], components: buildHandComponents(v) };
}

// Réponses communes aux actions sur l'offre. Renvoie true si l'action a
// abouti (offre modifiée), false si un message d'erreur a été affiché.
async function respondToAction(webhookUrl, discordId, result) {
  if (result.inactive) {
    await patchOriginal(webhookUrl, textPayload("Aucune partie d'Élixir en cours pour le moment."));
    return false;
  }
  if (result.notSeated) {
    await patchOriginal(webhookUrl, textPayload("Clique d'abord sur **Jouer** pour rejoindre la partie !"));
    return false;
  }
  await patchOriginal(webhookUrl, buildHandPayload(result.view, discordId));
  return !result.alreadyDone && !result.invalid;
}

export async function handleJouer(webhookUrl, discordId, username) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    const result = await joinGame(discordId, username);
    if (result.inactive) {
      await patchOriginal(webhookUrl, textPayload("Aucune partie d'Élixir en cours pour le moment."));
      return;
    }
    if (result.rosterLocked) {
      await patchOriginal(webhookUrl, textPayload("Cette partie a déjà commencé (ou les places sont toutes prises), tu ne peux pas la rejoindre."));
      return;
    }

    const view = await readPlayerView(result.state, discordId);
    await patchOriginal(webhookUrl, buildHandPayload(view, discordId));
    if (result.isNew) await refreshPublicMessage();
  } catch (err) {
    console.error("[ElixirDuel] Échec Jouer:", err.message);
  }
}

export async function handleCarte(webhookUrl, discordId, value) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    await respondToAction(webhookUrl, discordId, await selectCard(discordId, Number(value)));
  } catch (err) {
    console.error("[ElixirDuel] Échec choix de carte:", err.message);
  }
}

export async function handleMise(webhookUrl, discordId, value) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    await respondToAction(webhookUrl, discordId, await selectBid(discordId, Number(value)));
  } catch (err) {
    console.error("[ElixirDuel] Échec choix de mise:", err.message);
  }
}

// Après une offre (ou un passe) : résout la manche si tout le monde a joué.
// Si c'est le cas, la main éphémère du joueur affiche directement le bilan
// et l'offre de la manche suivante (en solo, le bot a toujours déjà joué :
// sans ça, la main restait figée sur « Offre envoyée »).
async function continueAfterOffer(webhookUrl, discordId) {
  const outcome = await refreshPublicMessage();
  if (!outcome?.resolved) return;
  const [players, catalog] = await Promise.all([readPlayers(), loadCatalog()]);
  const recap = await buildMyRecap(outcome.state.lastResults, discordId, players, catalog);
  if (outcome.final) {
    await patchOriginal(webhookUrl, {
      content: "",
      embeds: [
        {
          title: "Élixir · Partie terminée",
          description: [...recap, `${EMOJI.topplayers.text} Le classement final est affiché dans le salon.`].join("\n"),
          color: ELIXIRDUEL_COLOR,
        },
      ],
      components: [],
    });
    return;
  }
  const view = await readPlayerView(outcome.state, discordId);
  await patchOriginal(webhookUrl, buildHandPayload({ ...view, recap }, discordId));
}

export async function handleValider(webhookUrl, discordId) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    if (await respondToAction(webhookUrl, discordId, await validateOffer(discordId))) await continueAfterOffer(webhookUrl, discordId);
  } catch (err) {
    console.error("[ElixirDuel] Échec Valider:", err.message);
  }
}

export async function handlePasser(webhookUrl, discordId) {
  try {
    if (await replyIfExpired(webhookUrl)) return;
    if (await respondToAction(webhookUrl, discordId, await passOffer(discordId))) await continueAfterOffer(webhookUrl, discordId);
  } catch (err) {
    console.error("[ElixirDuel] Échec Passer:", err.message);
  }
}

// ── Bouton [Règles] ──────────────────────────────────────────────

function buildReglesEmbed() {
  const objectiveLines = OBJECTIVES.map((o) => `• ${o.rulesLabel ?? o.label} : **+${o.points}**`);
  const majorityLines = MAJORITIES.map((m) => `• ${m.label} : **+${m.points}**`);
  const specialLines = Object.values(SPECIALS).map((s) => `• **${s.fr}** (mise min ${s.minBid}) : ${s.description}`);
  return {
    title: "Règles du jeu : Élixir",
    description: [
      "Enchères secrètes sur des cartes Clash Royale, de 1 à 3 joueurs (en solo, contre un bot).",
      "",
      `${ELIXIR} **Élixir :** ${STARTING_ELIXIR} au départ, +${ELIXIR_PER_MANCHE} à chaque nouvelle manche, ${ELIXIR_CAP} au maximum (le surplus est perdu).`,
      "",
      `${EMOJI.battle.text} **À chaque manche :**`,
      "• Des cartes sont mises aux enchères (une de plus que de joueurs). La manche suivante est visible.",
      "• Fais **une seule offre secrète** : une carte et une mise (au moins le coût de la carte), ou passe.",
      "• La meilleure offre remporte la carte et **seul le gagnant paie**. En cas d'égalité, la carte est défaussée et personne ne paie.",
      "• Toutes les mises sont révélées après la manche. Élixir et collections sont visibles par tous.",
      "",
      `${EMOJI.question.text} **Cartes spéciales** (à partir de la manche 4) :`,
      ...specialLines,
      "",
      `${EMOJI.trophy.text} **Score final :** 1 pt par carte, plus chaque objectif atteint (cumulables).`,
      ...objectiveLines,
      "Majorités (strictement plus que chaque adversaire) :",
      ...majorityLines,
      "",
      "Départage : élixir restant. Une partie inactive depuis plus de 2h est close automatiquement.",
    ].join("\n"),
    color: ELIXIRDUEL_COLOR,
  };
}

// ── Bouton [Détails] (fin de partie) — détail des scores, éphémère ──

export async function handleDetails(webhookUrl, messageId) {
  try {
    const state = await readState();
    if (!state?.termine || !state.finalRanking || state.messageId !== messageId) {
      await patchOriginal(webhookUrl, textPayload("Les détails de cette partie ne sont plus disponibles."));
      return;
    }
    const lines = [];
    for (const [i, r] of state.finalRanking.entries()) {
      const name = await displayName(r.id, r.username);
      lines.push(`${i === 0 ? EMOJI.trophy.text : `${i + 1}.`} **${name}** · ${plural(r.total, "pt")}`);
      lines.push(`• ${plural(r.cardPoints, "carte")} : **+${r.cardPoints}**`);
      for (const a of r.achieved) lines.push(`• ${a.label} : **+${a.points}**`);
      lines.push(`• Élixir restant : ${r.stock} ${ELIXIR}`, "");
    }
    await patchOriginal(webhookUrl, {
      embeds: [{ title: "Élixir · Détail des scores", description: lines.join("\n").trim(), color: ELIXIRDUEL_COLOR }],
      components: [],
    });
  } catch (err) {
    console.error("[ElixirDuel] Échec Détails:", err.message);
  }
}

export async function handleRegles(webhookUrl) {
  try {
    await closeIfStale();
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed()], components: [] });
  } catch (err) {
    console.error("[ElixirDuel] Échec Règles:", err.message);
  }
}
