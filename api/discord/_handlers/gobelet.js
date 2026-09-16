// ============================================================
// gobelet.js — Handlers Discord pour le Jeu du Gobelet (7 jours, dés façon
// Yahtzee, classement cumulé au Jour 7). Pas d'adversaire : chaque jour, le
// joueur lance 5 dés, peut en conserver 0 à 5 et relancer les autres, deux
// fois de suite (3 tirages au total), puis la meilleure combinaison
// possible sur le résultat final lui rapporte des points.
// Embed, boutons d'action (Jouer/dés à conserver/Relancer), Règles, Journal.
// La publication/suppression quotidienne passe uniquement par
// scripts/postGobelet.js (postGobelet) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadGobeletConfig,
  readState,
  writeState,
  rollDice,
  rerollKept,
  computeBestCombination,
  resolveJour,
  readHand,
  writeHand,
  listHands,
  readKept,
  setKeptField,
  resetKept,
  addPoints,
  readPoints,
  resetPoints,
  buildRanking,
  writeHistoriqueEntry,
  listHistorique,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/gobelet.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const GOBELET_COLOR = 0x9b59b6;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustrations statiques (frontend/public/images/gobelet/), même principe
// que BLACKJACK_*_IMAGE_URL dans _handlers/blackjack.js. gobelet.webp pour
// le lancement (Jour 1) et la révélation finale (Jour 8) ; dices.webp pour
// les jours intermédiaires (2 à 7).
//
// Suffixe ?v= : Discord met en cache une image par URL EXACTE, y compris
// après remplacement du fichier. Incrémenter IMAGE_VERSION force Discord à
// refaire un fetch à chaque remplacement de fichier.
const GOBELET_IMAGE_VERSION = 1;
const GOBELET_GAME_IMAGE_URL = `${TRUST_ROYALE_URL}/images/gobelet/dices.webp?v=${GOBELET_IMAGE_VERSION}`;
const GOBELET_START_IMAGE_URL = `${TRUST_ROYALE_URL}/images/gobelet/gobelet.webp?v=${GOBELET_IMAGE_VERSION}`;

const DAY1_INTRO =
  "**Le Gobelet est prêt !** Lance tes dés chaque jour pendant 7 jours pour cumuler des points — clique sur *Règles* pour le barème complet.";

// ── Dés — rendu texte ──────────────────────────────────────────────
// Chiffres "keycap" (1️⃣-6️⃣) plutôt que les glyphes Unicode de dés
// (⚀-⚅) : mêmes raisons que le choix rang+couleur pour les cartes de
// Blackjack (29/08) — les keycaps sont de vrais emoji couleur qui
// s'agrandissent normalement sous un titre H1, contrairement aux glyphes
// texte qui resteraient minuscules.
const DICE_FACES = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

function formatDie(value) {
  return DICE_FACES[value - 1];
}

function formatDice(dice) {
  return dice.map(formatDie).join(" ");
}

function formatDiceBlock(dice) {
  return [`# ${formatDice(dice)}`];
}

// ── Résolution d'un jour — rendu texte partagé (recap + révélation finale) ──
// Résumé plutôt que liste exhaustive (même principe que Blackjack, 29/08) :
// avec beaucoup de joueurs, détailler la main de chacun rendrait le message
// public illisible. Seuls les meilleurs scores sont nommés ; chacun
// retrouve le détail de SA propre main dans le bouton Journal.

async function formatResultsSection(results) {
  if (!results.length) return ["Personne n'a joué ce jour-là."];

  const lines = [`${results.length} joueur${results.length > 1 ? "s" : ""} ont joué.`];
  const maxPoints = Math.max(...results.map((r) => r.points));
  const winners = results.filter((r) => r.points === maxPoints);
  const names = await Promise.all(winners.map((r) => resolveDisplayName(r.discordId, r.username)));
  lines.push(
    `🏆 Meilleur${winners.length > 1 ? "s" : ""} score${winners.length > 1 ? "s" : ""} du jour (${maxPoints} pt${maxPoints > 1 ? "s" : ""}) : ${names.join(", ")}`,
  );

  return lines;
}

// ── Embed / composants du jour ────────────────────────────────────

function buildDayComponents(jour) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3, // vert (Success) — action principale du message
          label: "Jouer",
          emoji: { name: "🎲" },
          custom_id: `gobelet_jouer:${jour}`,
        },
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "gobelet_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "gobelet_regles",
        },
      ],
    },
  ];
}

function buildTodaySection() {
  return [
    "## 🎲 À toi de jouer",
    "Clique sur **Jouer** pour lancer tes 5 dés. Tu pourras ensuite conserver les dés de ton choix et relancer les autres — deux fois de suite.",
    "",
    "Consulte **Règles** pour le barème complet des combinaisons.",
  ];
}

async function buildDayEmbed(jour, config, { estPremierJour, previousResults }) {
  const lines = [];
  if (estPremierJour) {
    lines.push(DAY1_INTRO, "");
  } else {
    lines.push(`**📊 Bilan du Jour ${jour - 1}**`, ...(await formatResultsSection(previousResults)), "");
  }
  lines.push(...buildTodaySection());

  return {
    title: `🎲 Jeu du Gobelet — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: GOBELET_COLOR,
    image: { url: estPremierJour ? GOBELET_START_IMAGE_URL : GOBELET_GAME_IMAGE_URL },
    footer: {
      text: estPremierJour
        ? "Lance tes dés chaque jour pendant 7 jours pour cumuler des points !"
        : `Joue avant ${formatUtcTimeAsParis(8)} demain pour ne pas manquer ta chance aujourd'hui.`,
    },
  };
}

// ── Embed de révélation finale (Jour 8) ───────────────────────────

function formatMancheHistoryLine(record) {
  const winners = record.winners?.length ? record.winners.join(", ") : "personne";
  return `Manche ${record.manche} : 🏆 ${winners} — ${record.maxPoints} pts`;
}

async function buildRevealEmbed(lastResults, ranking, manchesHistory) {
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({ ...r, username: await resolveDisplayName(r.discordId, r.username) })),
  );
  const maxPoints = resolvedRanking[0]?.points ?? 0;
  const winners = maxPoints > 0 ? resolvedRanking.filter((r) => r.points === maxPoints) : [];

  const lines = [
    `**📊 Bilan du dernier jour**`,
    ...(await formatResultsSection(lastResults)),
    "",
    "**Classement final :**",
    ...(resolvedRanking.length
      ? resolvedRanking.slice(0, 20).map((r, i) => `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`)
      : ["Personne n'a marqué de point cette manche."]),
  ];

  if (winners.length) {
    lines.push(
      "",
      `🏆 Vainqueur${winners.length > 1 ? "s" : ""} (${maxPoints} pt${maxPoints > 1 ? "s" : ""}) : ${winners.map((w) => w.username).join(", ")}`,
    );
  }

  if (manchesHistory.length) {
    lines.push("", "**Vainqueurs des manches précédentes :**", ...manchesHistory.map(formatMancheHistoryLine));
  }

  return {
    title: "🏁 Jeu du Gobelet — Révélation finale",
    description: lines.join("\n"),
    color: GOBELET_COLOR,
    image: { url: GOBELET_START_IMAGE_URL },
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postGobelet.js) ──

async function publishAndWriteState(channelId, previousState, { jour, embed, components, noPing, termine = false }) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(`[Gobelet] Échec suppression du message de la veille (${delRes.status}), publication quand même.`);
      }
    } catch (err) {
      console.warn("[Gobelet] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  // Ping à chaque post (Jour 1, jours suivants, révélation finale) — comme
  // Blackjack/Quiz : une action est attendue CHAQUE jour (lancer ses dés).
  const roleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();

  await writeState({
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
  });

  return { jour, embed, message, termine };
}

export async function postGobelet(
  channelId,
  { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false } = {},
) {
  const config = await loadGobeletConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  // Garde-fou anti-double-avancée (même pattern que Blackjack et les autres
  // jeux à cron du repo) : jamais appliqué en dry-run, contournable avec --force.
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }

  // Garde-fou : une partie active sur un AUTRE salon ne doit JAMAIS être
  // reprise ici (voir CONTRIBUTING.md — incident réel du 23/08/2026 sur Quiz).
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une partie déjà lancée manuellement.
  if (!state && requireActiveState) return { skipped: true };

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const embed = await buildDayEmbed(jour, config, { estPremierJour: true });
    const components = buildDayComponents(jour);

    if (dryRun) {
      const pingRoleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }

    await resetPoints();
    return publishAndWriteState(channelId, null, { jour, embed, components, noPing, termine: false });
  }

  // Résolution du jour actif (state.jour).
  const hands = await listHands(state.jour);
  const results = resolveJour(hands);
  const jourSuivant = state.jour + 1;
  const estFinDeManche = jourSuivant > config.duree_jours;

  if (dryRun) {
    if (estFinDeManche) {
      const pointsActuels = await readPoints();
      // Points simulés selon results[].points, sans écrire dans Redis —
      // pure projection pour npm run gobelet:status / --dry-run.
      for (const r of results) {
        pointsActuels[r.discordId] = (pointsActuels[r.discordId] || 0) + r.points;
      }
      const ranking = buildRanking(pointsActuels);
      const embed = await buildRevealEmbed(results, ranking, []);
      return { dryRun: true, final: true, embed };
    }
    const embed = await buildDayEmbed(jourSuivant, config, { estPremierJour: false, previousResults: results });
    return { dryRun: true, jour: jourSuivant, embed, components: buildDayComponents(jourSuivant) };
  }

  for (const r of results) {
    await addPoints(r.discordId, r.points);
  }
  await writeHistoriqueEntry(state.jour, { jour: state.jour, results, resolvedAt: new Date().toISOString() });

  if (estFinDeManche) {
    const points = await readPoints();
    const ranking = buildRanking(points);
    // Jamais archivé en dry-run NI sur le salon de test (isPublic) — seule
    // une vraie publication publique compte comme une manche réelle.
    let currentManche = null;
    if (isPublic) {
      const resolvedRanking = await Promise.all(
        ranking.map(async (r) => ({ ...r, username: await resolveDisplayName(r.discordId, r.username) })),
      );
      const maxPoints = resolvedRanking[0]?.points ?? 0;
      const winners = maxPoints > 0 ? resolvedRanking.filter((r) => r.points === maxPoints).map((r) => r.username) : [];
      currentManche = await archiveManche({
        resolvedAt: new Date().toISOString(),
        ranking: resolvedRanking,
        winners,
        maxPoints,
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = await buildRevealEmbed(results, ranking, manches);
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      embed,
      components: [],
      noPing,
      termine: true,
    });
    return { ...result, final: true, manche: currentManche };
  }

  const embed = await buildDayEmbed(jourSuivant, config, { estPremierJour: false, previousResults: results });
  const components = buildDayComponents(jourSuivant);

  return publishAndWriteState(channelId, state, { jour: jourSuivant, embed, components, noPing, termine: false });
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
    console.error("[Gobelet] Échec PATCH:", err.message);
  }
}

// ── Main du joueur — Jouer / conserver un dé / Relancer ────────────
// Tout se joue en éphémère (message privé au joueur) : le message public du
// jour n'est jamais repatché, il n'y a aucun compteur à y afficher — la
// main de chacun reste secrète jusqu'à la clôture du lendemain.

function buildHandStatusMessage(hand, kept) {
  if (hand.status === "termine") {
    return `🎯 Combinaison retenue : **${hand.category}**.\nTu gagnes **${hand.points} point${hand.points > 1 ? "s" : ""}** aujourd'hui !`;
  }
  const toReroll = kept.filter((k) => !k).length;
  const rerollsLeft = 3 - hand.tirage;
  return `Tirage ${hand.tirage}/3 — sélectionne les dés à conserver (🔒) puis clique sur **Relancer** pour relancer les ${toReroll} dé${toReroll > 1 ? "s" : ""} restant${toReroll > 1 ? "s" : ""}. Il te reste ${rerollsLeft} relance${rerollsLeft > 1 ? "s" : ""}.`;
}

function buildHandEmbed(jour, hand, kept) {
  return {
    title: `🎲 Ta main — Jour ${jour}`,
    description: [...formatDiceBlock(hand.dice), "", buildHandStatusMessage(hand, kept)].join("\n"),
    color: GOBELET_COLOR,
  };
}

function relancerLabel(kept) {
  const count = kept.filter((k) => !k).length;
  return count === 0 ? "Passer au tirage suivant" : `Relancer (${count} dé${count > 1 ? "s" : ""})`;
}

// Emoji d'application Discord uploadés une fois via `npm run gobelet:emojis`
// (voir scripts/uploadGobeletEmojis.js) et référencés par ID dans
// data/gobelet/gobelet.json (clé diceEmojis) — vraie face de dé sur le
// bouton plutôt qu'un simple 🔒/🎲. Repli automatique sur les emoji
// génériques tant que la config n'a pas encore été renseignée.
function buildDieEmoji(value, kept, diceEmojis) {
  const emojiId = diceEmojis?.[String(value)];
  if (emojiId) return { id: emojiId, name: `gobelet_dice_${value}` };
  return { name: kept ? "🔒" : "🎲" };
}

// Le bouton Valider n'apparaît que si les dés COURANTS (indépendamment de
// ce qui est coché "à garder") forment déjà une combinaison — n'importe
// laquelle sauf "Aucune combinaison" — dès le 1ᵉʳ tirage. Permet de figer
// une bonne main tout de suite sans passer par les 2 relances obligatoires.
function buildHandComponents(jour, hand, kept, diceEmojis) {
  if (hand.status !== "en_cours") return [];
  const canValider = computeBestCombination(hand.dice).category !== "Aucune combinaison";
  const secondRow = [
    {
      type: 2,
      style: 1,
      label: relancerLabel(kept),
      emoji: { name: kept.every(Boolean) ? "➡️" : "🔁" },
      custom_id: `gobelet_relancer:${jour}`,
    },
  ];
  if (canValider) {
    secondRow.push({
      type: 2,
      style: 3,
      label: "Valider",
      emoji: { name: "👍" },
      custom_id: `gobelet_valider:${jour}`,
    });
  }
  return [
    {
      type: 1,
      components: hand.dice.map((value, i) => ({
        type: 2,
        style: kept[i] ? 3 : 2,
        label: String(value),
        emoji: buildDieEmoji(value, kept[i], diceEmojis),
        custom_id: `gobelet_toggle:${jour}:${i}`,
      })),
    },
    { type: 1, components: secondRow },
  ];
}

function isDayInactive(state, jour) {
  return !state || state.termine || String(state.jour) !== String(jour);
}

const NO_KEPT = [false, false, false, false, false];

export async function handleJouer(webhookUrl, jour, discordId, username) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();

    const existing = await readHand(jour, discordId);
    if (existing) {
      const kept = existing.status === "en_cours" ? await readKept(jour, discordId) : NO_KEPT;
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(jour, existing, kept)],
        components: buildHandComponents(jour, existing, kept, diceEmojis),
      });
      return;
    }

    const dice = rollDice(5);
    const hand = { dice, tirage: 1, status: "en_cours", category: null, points: null, username };
    await writeHand(jour, discordId, hand);
    await resetKept(jour, discordId);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, hand, NO_KEPT)],
      components: buildHandComponents(jour, hand, NO_KEPT, diceEmojis),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Jouer:", err.message);
  }
}

export async function handleToggle(webhookUrl, jour, index, discordId) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const hand = await readHand(jour, discordId);
    if (!hand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour lancer tes 5 dés !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (hand.status !== "en_cours") {
      await patchOriginal(webhookUrl, { embeds: [buildHandEmbed(jour, hand, NO_KEPT)], components: [] });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();
    const i = Number(index);
    const kept = await readKept(jour, discordId);
    await setKeptField(jour, discordId, i, !kept[i]);
    const updatedKept = kept.map((k, idx) => (idx === i ? !k : k));

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, hand, updatedKept)],
      components: buildHandComponents(jour, hand, updatedKept, diceEmojis),
    });
  } catch (err) {
    console.error("[Gobelet] Échec sélection de dé:", err.message);
  }
}

export async function handleRelancer(webhookUrl, jour, discordId) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const hand = await readHand(jour, discordId);
    if (!hand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour lancer tes 5 dés !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (hand.status !== "en_cours") {
      await patchOriginal(webhookUrl, { embeds: [buildHandEmbed(jour, hand, NO_KEPT)], components: [] });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();
    const kept = await readKept(jour, discordId);
    const dice = rerollKept(hand.dice, kept, Math.random);
    const tirage = hand.tirage + 1;
    let updated;
    let nextKept;
    if (tirage >= 3) {
      const { category, points } = computeBestCombination(dice);
      updated = { ...hand, dice, tirage, status: "termine", category, points };
      await resetKept(jour, discordId);
      nextKept = NO_KEPT;
    } else {
      updated = { ...hand, dice, tirage };
      // kept N'EST PAS réinitialisé (retour utilisateur, 16/09) : les dés
      // déjà cochés "à garder" le restent au tirage suivant — seuls les dés
      // qui viennent d'être relancés repartent "non gardés" par défaut
      // (déjà le cas, leur position n'a jamais été cochée).
      nextKept = kept;
    }
    await writeHand(jour, discordId, updated);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, updated, nextKept)],
      components: buildHandComponents(jour, updated, nextKept, diceEmojis),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Relancer:", err.message);
  }
}

export async function handleValider(webhookUrl, jour, discordId) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const hand = await readHand(jour, discordId);
    if (!hand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour lancer tes 5 dés !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (hand.status !== "en_cours") {
      await patchOriginal(webhookUrl, { embeds: [buildHandEmbed(jour, hand, NO_KEPT)], components: [] });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();
    const { category, points } = computeBestCombination(hand.dice);
    if (category === "Aucune combinaison") {
      // Garde-fou : le bouton ne devrait normalement pas être cliquable
      // dans ce cas (voir buildHandComponents), mais un client Discord qui
      // affiche encore l'ancien message (avant un relance qui a changé les
      // dés) pourrait renvoyer ce clic — on ignore juste et on repeint l'état
      // réel plutôt que de figer une main sans combinaison.
      const kept = await readKept(jour, discordId);
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(jour, hand, kept)],
        components: buildHandComponents(jour, hand, kept, diceEmojis),
      });
      return;
    }

    const updated = { ...hand, status: "termine", category, points };
    await writeHand(jour, discordId, updated);
    await resetKept(jour, discordId);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, updated, NO_KEPT)],
      components: buildHandComponents(jour, updated, NO_KEPT, diceEmojis),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Valider:", err.message);
  }
}

// ── Bouton [📜 Journal] — lecture seule ─────────────────────────────

function formatHistoriqueLine(entry, discordId) {
  const mine = entry.results?.find((r) => r.discordId === discordId);
  const monResultat = !mine ? " — tu n'as pas joué" : ` — **${mine.category}** (${mine.points} pt${mine.points > 1 ? "s" : ""})`;
  return `Jour ${entry.jour}${monResultat}`;
}

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie du Jeu du Gobelet en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }

    const [config, hand, points, historique] = await Promise.all([
      loadGobeletConfig(),
      readHand(state.jour, discordId),
      readPoints(),
      listHistorique({ limit: 10 }),
    ]);

    const ranking = buildRanking(points);
    const resolvedRanking = await Promise.all(
      ranking.slice(0, 10).map(async (r) => ({ ...r, username: await resolveDisplayName(r.discordId, r.username) })),
    );

    const lines = [`**Jour ${state.jour}/${config.duree_jours}**`];
    if (hand) {
      const detail =
        hand.status === "termine"
          ? `**${hand.category}** (${hand.points} pt${hand.points > 1 ? "s" : ""})`
          : `en cours (tirage ${hand.tirage}/3)`;
      lines.push(`Ta main aujourd'hui : ${formatDice(hand.dice)} — ${detail}`);
    } else {
      lines.push("Tu n'as pas encore joué aujourd'hui — clique sur **Jouer** !");
    }

    lines.push(
      "",
      "**Classement cumulé :**",
      ...(resolvedRanking.length
        ? resolvedRanking.map((r, i) => `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`)
        : ["Personne n'a encore marqué de point."]),
    );

    if (historique.length > 0) {
      lines.push("", "**Jours précédents :**", ...historique.map((e) => formatHistoriqueLine(e, discordId)));
    }

    const embed = { title: "📜 Journal", description: lines.join("\n"), color: GOBELET_COLOR };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Gobelet] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du jeu — Jeu du Gobelet",
    description: [
      "Lance tes dés chaque jour pendant 7 jours pour cumuler des points.",
      "",
      "**Déroulement (1 partie par jour, définitive) :**",
      "🎲 **Jouer** — lance tes 5 dés.",
      "🔒 **Clique sur un dé** pour le conserver (ou le relâcher) avant la relance.",
      "🔁 **Relancer** — relance tous les dés non conservés. Possible 2 fois, donc 3 tirages au total.",
      "👍 **Valider** — dès que tes dés forment déjà une combinaison, fige ta main immédiatement sans attendre les relances restantes (n'apparaît que si une combinaison est atteinte).",
      "Ta combinaison finale est calculée automatiquement — pas besoin de choisir toi-même la catégorie.",
      "",
      "**Barème (la catégorie applicable la plus valorisée est toujours retenue) :**",
      "🎲 Aucune combinaison : somme des 5 dés",
      "🎯 Brelan (3 dés identiques) : 20 pts",
      "🎯 Carré (4 dés identiques) : 30 pts",
      "🎯 Full (3 + 2) : 40 pts",
      "🎯 Somme ≤ 7 : 45 pts",
      "🎯 Somme ≥ 28 : 45 pts",
      "🎯 Petite Suite (4 dés qui se suivent) : 30 pts",
      "🎯 Grande Suite (5 dés qui se suivent) : 50 pts",
      "🎯 Gobelet (5 dés identiques) : 60 pts",
      "",
      `Au Jour ${config.duree_jours}, le classement cumulé désigne le(s) vainqueur(s) de la manche.`,
      "",
      "📜 **Journal** — consulte ta main du jour, le classement cumulé et l'historique des jours précédents. Simple lecture, clique dessus autant de fois que tu veux.",
    ].join("\n"),
    color: GOBELET_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadGobeletConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Gobelet] Échec Règles:", err.message);
  }
}
