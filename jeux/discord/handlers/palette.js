// ============================================================
// palette.js — Handlers Discord pour le jeu "Palette" (devine la couleur
// dominante d'une carte parmi 4 propositions A/B/C/D), en alternance une
// saison sur deux avec Zoom carte (voir jeux/services/jeuxvisuels.js).
// Allégé par rapport à _handlers/zoom.js : pas de Modal, pas de bouton
// indice, pas de DM — un seul essai par joueur, verrouillé au premier clic
// (voir jeux/services/palette.js). Pas de
// `skipSeasonRecap` sur postPalette() (contrairement à Zoom/Anagram) : ce
// jeu n'a jamais eu de logique de récap interne à suppléer, seul
// l'orchestrateur (jeux/scripts/postJeuxVisuels.js) déclenche postSeasonRecap —
// même position que Pêle-mêle avant son unification avec Anagram.
// ============================================================

import {
  resolvePaletteEntry,
  loadPaletteCatalog,
  readState,
  writeState,
  startNewGame,
  getAnswerRank,
  getCorrectLetter,
  computeScore,
  recordAnswer,
  archiveAnswer,
  readParticipant,
  readRoundOrder,
  alreadyPostedThisWeek,
  getCurrentSeasonId,
  previewSeasonManche,
  computeSeasonMancheTotal,
  computeSeasonRanking,
  getSeasonManches,
  getSeasonMancheNumber,
  getPaletteRoundLabel,
  findTiedRank,
  LETTERS,
} from "../../services/palette.js";
import { nomSaison } from "../../services/saison.js";
import { HUE_MERGE_DEGREES } from "../../services/dominantColor.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const PALETTE_COLOR = 0x9b59b6;

function buildPaletteEmbed({
  gameId,
  entryFr,
  seasonId,
  seasonManche,
  seasonMancheTotal,
  cacheBust,
}) {
  return {
    title: "🎨 Le jeu du vendredi : Palette !",
    description: [
      `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      `**${entryFr}**`,
      "",
      "4 couleurs proposées (A, B, C, D) : laquelle est la **dominante**, c'est-à-dire celle qui recouvre la plus grande surface de l'illustration ?",
      "",
      "**Barème** : dominante = **4 pts**, 2e couleur = **2 pts**, 3e = **1 pt**, 4e = 0 pt.",
      "**Un seul essai** : ton premier clic est définitif !",
    ].join("\n"),
    image: {
      url: `${TRUST_ROYALE_URL}/api/palette/image?gameId=${gameId}&v=${cacheBust}`,
    },
    color: PALETTE_COLOR,
    footer: {
      text: "Nouvelle manche : vendredi prochain !",
    },
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Copie quasi identique de buildSeasonRecapEmbed dans zoom.js (mêmes
// règles : troncage à 20 joueurs, exclusion des 0 pt, gestion des ex-aequo
// pour les médailles). Contrairement à Pêle-mêle (tirage de lettres),
// getPaletteRoundLabel renvoie directement le nom français de la carte,
// comme getZoomRoundLabel — pas d'illustration dédiée de fin de saison
// (aucun asset créé pour ce jeu), `image` simplement omise.
//
// N'est PAS déclenché par postPalette() lui-même mais uniquement par
// jeux/scripts/postJeuxVisuels.js : sous l'alternance, ce n'est pas forcément
// Palette qui reprend la main juste après SA propre saison — seul
// l'orchestrateur partagé sait quand récapituler la bonne saison au bon
// moment (voir jeux/services/jeuxvisuels.js).

const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

function buildSeasonRecapEmbed(
  seasonRanking,
  endedSeasonId,
  newSeasonId,
  manchesPlayed,
) {
  const nonZero = seasonRanking.filter((r) => r.totalScore > 0);
  const shown = nonZero.slice(0, SEASON_RECAP_MAX_PLAYERS);
  const hiddenCount = nonZero.length - shown.length;

  const lines = [
    "**Classement final :**",
    ...shown.map((entry) => {
      const rank = findTiedRank(shown, entry.discordId, "totalScore");
      const tiedCount = shown.filter(
        (e) => e.totalScore === entry.totalScore,
      ).length;
      const label =
        tiedCount === 1 && rank <= 3
          ? SEASON_RECAP_MEDALS[rank - 1]
          : `${rank}.`;
      return `${label} ${entry.pseudo} (${entry.totalScore} pts)`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(
      `... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`,
    );
  }
  if (manchesPlayed?.length > 0) {
    lines.push(
      "",
      "**Manches de la saison :**",
      ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`),
    );
  }
  lines.push(
    "",
    `Bravo à tous ! Rendez-vous juste après pour le lancement de la ${nomSaison(newSeasonId)}.`,
  );

  return {
    title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « Palette » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: PALETTE_COLOR,
  };
}

async function resolveRankingPseudos(ranking) {
  return Promise.all(
    ranking.map(async (entry) => ({
      ...entry,
      pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
    })),
  );
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getPaletteRoundLabel(gameId),
    })),
  );
  return manches
    .filter((m) => m.seasonManche != null && m.label != null)
    .sort((a, b) => a.seasonManche - b.seasonManche);
}

// Exportée : appelée directement par jeux/scripts/postJeuxVisuels.js.
export async function postSeasonRecap(
  channelId,
  endedSeasonId,
  newSeasonId,
  { noPing = false } = {},
) {
  const token = process.env.DISCORD_TOKEN;
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

  const resolvedRanking = await resolveRankingPseudos(seasonRanking);
  const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
  const embed = buildSeasonRecapEmbed(
    resolvedRanking,
    endedSeasonId,
    newSeasonId,
    manchesPlayed,
  );
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

function buildPaletteComponents(gameId) {
  return [
    {
      type: 1,
      components: LETTERS.map((letter) => ({
        type: 2,
        style: 2,
        label: letter,
        custom_id: `palette_answer:${gameId}:${letter}`,
      })),
    },
  ];
}

// `force` ignore le garde-fou anti-double-post (alreadyPostedThisWeek) —
// utile pour rattraper un créneau manqué à la main, jamais depuis le cron.
export async function postPalette(
  channelId,
  { dryRun = false, force = false, noPing = false } = {},
) {
  if (dryRun) {
    const gameId = "preview";
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const entryFr = "(aperçu, carte réelle tirée à la publication)";
    const embed = buildPaletteEmbed({
      gameId,
      entryFr,
      seasonId,
      seasonManche,
      seasonMancheTotal,
      cacheBust: Date.now(),
    });
    const components = buildPaletteComponents(gameId);
    const pingRoleId = noPing
      ? null
      : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return {
      dryRun: true,
      entry: { fr: entryFr },
      embed,
      components,
      pingRoleId,
    };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const { state: newState, entry } = await startNewGame(channelId);
  const embed = buildPaletteEmbed({
    gameId: newState.gameId,
    entryFr: entry.fr,
    seasonId: newState.seasonId,
    seasonManche: newState.seasonManche,
    seasonMancheTotal: newState.seasonMancheTotal,
    cacheBust: Date.now(),
  });
  const components = buildPaletteComponents(newState.gameId);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [embed],
        components,
        ...buildRolePingFields(roleId),
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  newState.messageId = message.id;
  await writeState(newState);
  await deletePreviousRoundMessage(previousState, "Palette");

  return { state: newState, entry, message };
}

async function postEphemeral(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("[Palette] Échec PATCH réponse éphémère:", err.message);
  }
}

async function postEphemeralEmbed(webhookUrl, embed, components = []) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    console.error(
      "[Palette] Échec PATCH réponse éphémère (embed):",
      err.message,
    );
  }
}

// ── Bouton de réponse A/B/C/D ──────────────────────────────────────
// Contrairement à Zoom (Modal), un simple clic suffit : ACK immédiat
// (type 5, éphémère) côté routeur, tout le traitement se fait ici, en
// arrière-plan (voir le bloc quiz_vote de interactions.js pour le même
// principe d'ACK).

export async function handleAnswerButton(
  webhookUrl,
  gameId,
  letter,
  discordId,
  username,
) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(
        webhookUrl,
        "⚠️ Cette manche est terminée, une nouvelle a peut-être déjà commencé !",
      );
      return;
    }

    const existing = await readParticipant(gameId, discordId);
    if (existing) {
      await postEphemeral(
        webhookUrl,
        "Tu as déjà répondu à cette manche, une seule tentative autorisée !",
      );
      return;
    }

    const order = await readRoundOrder(gameId);
    const rank = getAnswerRank(order, letter);
    const correct = rank === 0;
    const score = computeScore(rank);

    const { participant, alreadyAnswered } = await recordAnswer(
      gameId,
      discordId,
      username,
      letter,
      correct,
      score,
      rank,
    );
    if (alreadyAnswered) {
      await postEphemeral(
        webhookUrl,
        "Tu as déjà répondu à cette manche, une seule tentative autorisée !",
      );
      return;
    }

    const catalog = await loadPaletteCatalog();
    const entry = resolvePaletteEntry(catalog, gameId);
    if (entry)
      await archiveAnswer(
        state,
        entry,
        discordId,
        username,
        score,
        participant.answeredAt,
        rank,
      );
    const correctLetter = getCorrectLetter(order);
    const resultLine = correct
      ? `✅ Bonne réponse ! **+${score} pts**`
      : `${score > 0 ? "🟡" : "❌"} Tu as choisi la ${rank + 1}e couleur (**${letter}**), la dominante était **${correctLetter}** : **+${score} pt${score > 1 ? "s" : ""}**`;

    // Détail des 4 couleurs (comme prévu à la conception) : le visuel de
    // l'image ne suffit pas seul à convaincre sur un petit écran mobile, le
    // texte reprend les mêmes chiffres en clair.
    const breakdown = entry
      ? order.map((colorIdx, i) => {
          const c = entry.colors[colorIdx];
          const marker = colorIdx === 0 ? "🏆" : "";
          const pts = computeScore(colorIdx);
          return `**${LETTERS[i]}** ${c.hex} : ${Math.round(c.share * 100)}% (${pts} pt${pts > 1 ? "s" : ""}) ${marker}`;
        })
      : [];

    await postEphemeralEmbed(webhookUrl, {
      description: [
        resultLine,
        "",
        "**Répartition des 4 couleurs :**",
        ...breakdown,
      ].join("\n"),
      image: {
        url: `${TRUST_ROYALE_URL}/api/palette/image?gameId=${gameId}&stage=result&v=${Date.now()}`,
      },
      color: PALETTE_COLOR,
      footer: {
        text: `ℹ️ Méthode : les teintes à moins de ${HUE_MERGE_DEGREES}° d'écart (même matériau sous des éclairages différents) sont regroupées en une seule couleur, pour n'avoir que 4 propositions vraiment distinctes.`,
      },
    });
  } catch (err) {
    console.error("[Palette] Échec traitement de la réponse:", err.message);
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
