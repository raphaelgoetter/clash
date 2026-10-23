// ============================================================
// zoom2.js — Handlers Discord du jeu "Zoom logo" (devine une marque à partir
// d'un zoom sur son logo), groupe "Coup d'œil" du vendredi (voir
// jeux/services/refonte.js). Embed, bouton indice, Modal, DM : même parcours
// que Zoom carte (handlers/zoom.js), l'indice est une image dézoomée. En
// production, la publication passe par jeux/scripts/postJeuxVisuels.js
// (orchestrateur du groupe, seul à poster le récap de fin de saison).
// ============================================================

import {
  loadZoom2Catalog,
  resolveZoom2Entry,
  gameIdFor,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextZoom2Index,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
  markSolved,
  archiveSolve,
  computeSeasonRanking,
  getSeasonManches,
  getSeasonMancheNumber,
  getZoom2RoundLabel,
  previewSeasonManche,
  computeSeasonMancheTotal,
  findTiedRank,
  alreadyPostedThisWeek,
} from "../../services/zoom2.js";
import { nomSaison } from "../../services/saison.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const ZOOM2_COLOR = 0x16a085;

// gameId= épingle l'image de CETTE manche ; ?v= contourne le cache Discord.
function imageUrl(gameId, stage) {
  const stageParam = stage ? `&stage=${stage}` : "";
  return `${TRUST_ROYALE_URL}/api/zoom2/image?gameId=${gameId}${stageParam}&v=${Date.now()}`;
}

// ── Embed / composants du post ────────────────────────────────

function buildZoom2Embed({ seasonId, seasonManche, seasonMancheTotal, gameId }) {
  return {
    title: "🔍 Le jeu du vendredi : Zoom logo !",
    description: [
      `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      "Un logo vu de très près. Devine la marque !",
      "",
      "**Barème**",
      "- Réponse exacte du 1er coup sans indice : **10 pts**",
      "- Chaque tentative incorrecte : **-2 pts**",
      "- Indice utilisé : **-3 pts**",
      "",
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**",
    ].join("\n"),
    image: { url: imageUrl(gameId) },
    color: ZOOM2_COLOR,
    footer: { text: "Nouvelle manche : vendredi prochain. Bonne chance tout le monde !" },
  };
}

function buildZoom2Components(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "🔍 Indice", custom_id: `zoom2_hint:${gameId}` },
        { type: 2, style: 1, label: "📝 Répondre", custom_id: `zoom2_answer:${gameId}` },
      ],
    },
  ];
}

// Seule une Modal (type 9) permet un champ libre en réponse à un clic.
export function buildAnswerModal(gameId) {
  return {
    custom_id: `zoom2_answer_modal:${gameId}`,
    title: "Quelle est cette marque ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "zoom2_answer_input",
            style: 1,
            label: "Ta réponse",
            placeholder: "Nom de la marque",
            required: true,
            max_length: 60,
          },
        ],
      },
    ],
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Posté uniquement par l'orchestrateur du groupe (jeux/scripts/
// postJeuxVisuels.js) : sous l'alternance, lui seul sait quand récapituler
// la bonne saison.

const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

function buildSeasonRecapEmbed(seasonRanking, endedSeasonId, newSeasonId, manchesPlayed) {
  const nonZero = seasonRanking.filter((r) => r.totalScore > 0);
  const shown = nonZero.slice(0, SEASON_RECAP_MAX_PLAYERS);
  const hiddenCount = nonZero.length - shown.length;

  const lines = [
    "**Classement final :**",
    ...shown.map((entry) => {
      const rank = findTiedRank(shown, entry.discordId, "totalScore");
      const tiedCount = shown.filter((e) => e.totalScore === entry.totalScore).length;
      const label = tiedCount === 1 && rank <= 3 ? SEASON_RECAP_MEDALS[rank - 1] : `${rank}.`;
      return `${label} ${entry.pseudo} (${entry.totalScore} pts)`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(`... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`);
  }
  if (manchesPlayed?.length > 0) {
    lines.push("", "**Manches de la saison :**", ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`));
  }
  lines.push("", `Bravo à tous ! Rendez-vous juste après pour le lancement de la ${nomSaison(newSeasonId)}.`);

  return {
    title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « Zoom logo » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: ZOOM2_COLOR,
  };
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getZoom2RoundLabel(gameId),
    })),
  );
  return manches.filter((m) => m.seasonManche != null && m.label != null).sort((a, b) => a.seasonManche - b.seasonManche);
}

export async function postSeasonRecap(channelId, endedSeasonId, newSeasonId, { noPing = false } = {}) {
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

  const resolvedRanking = await Promise.all(
    seasonRanking.map(async (entry) => ({ ...entry, pseudo: await resolveDisplayName(entry.discordId, entry.pseudo) })),
  );
  const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
  const embed = buildSeasonRecapEmbed(resolvedRanking, endedSeasonId, newSeasonId, manchesPlayed);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

// ── Publication d'une manche ────────────────────────────────────
// `force` ignore le garde-fou anti-double-post — rattrapage manuel
// uniquement. `skipSeasonRecap` : accepté pour l'homogénéité avec
// l'orchestrateur, ignoré (pas de logique de récap interne).
export async function postZoom2(channelId, { dryRun = false, noPing = false, force = false, skipSeasonRecap = false } = {}) {
  void skipSeasonRecap;

  if (dryRun) {
    const catalog = await loadZoom2Catalog();
    const entry = catalog[pickNextZoom2Index(await readState(), catalog)];
    const gameId = gameIdFor(entry);
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const embed = buildZoom2Embed({
      seasonId,
      seasonManche,
      seasonMancheTotal: computeSeasonMancheTotal(seasonManche),
      gameId,
    });
    const pingRoleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return { dryRun: true, entry, embed, components: buildZoom2Components(gameId), pingRoleId };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const { state, entry } = await startNewGame(channelId);
  const embed = buildZoom2Embed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    gameId: state.gameId,
  });
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components: buildZoom2Components(state.gameId), ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);
  await deletePreviousRoundMessage(previousState, "Zoom logo");

  return { state, entry, message };
}

// ── Réponse éphémère (PATCH de la réponse différée) ─────────────

async function patchOriginal(webhookUrl, body) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[Zoom logo] Échec PATCH réponse éphémère:", err.message);
  }
}

function postEphemeral(webhookUrl, content) {
  return patchOriginal(webhookUrl, { content });
}

// ── Bouton indice ────────────────────────────────────────────
// L'indice est une image : réponse éphémère avec le crop dézoomé, jamais une
// modification du message public partagé par tout le salon.

export async function handleHintButton(webhookUrl, gameId, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    // Score déjà figé : l'indice ne coûte plus rien, le message le dit.
    const solved = (await readParticipant(gameId, discordId))?.solved;
    let suffix = "_Tu as déjà trouvé, cet indice ne change plus ton score._";
    if (!solved) {
      const { alreadyUsed } = await recordHintUsed(gameId, discordId, username);
      suffix = alreadyUsed ? "_Indice déjà révélé._" : "_Indice révélé (-3 pts)._";
    }

    await patchOriginal(webhookUrl, {
      embeds: [{ description: `🔍 Un peu moins zoomé...\n${suffix}`, image: { url: imageUrl(gameId, "hint") }, color: ZOOM2_COLOR }],
    });
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────
// Embed (et non un simple texte) pour inclure le logo entier.

function buildDmEmbed({ seasonId, seasonManche, seasonMancheTotal, gameId, answer, score, seasonScore }) {
  return {
    description: [
      `**Zoom logo : ${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      `🔍 **${answer}**, bien trouvé !`,
      `Score de cette manche : **${score} pts**`,
      `Score total de la saison : **${seasonScore} pts**`,
    ].join("\n"),
    image: { url: imageUrl(gameId, "reveal") },
    color: ZOOM2_COLOR,
  };
}

async function sendZoom2DM(discordId, embed) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return false;
  try {
    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dmRes.ok) return false;
    const { id: dmChannelId } = await dmRes.json();
    await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return true;
  } catch (err) {
    console.error("[Zoom logo] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la Modal (réponse du joueur) ──────────────────

export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    if ((await readParticipant(gameId, discordId))?.solved) {
      await postEphemeral(webhookUrl, "Tu as déjà trouvé la réponse !");
      return;
    }

    const entry = resolveZoom2Entry(await loadZoom2Catalog(), gameId);
    if (!checkAnswer(entry, rawAnswer)) {
      await recordAttempt(gameId, discordId, username);
      await postEphemeral(webhookUrl, "❌ Mauvaise réponse ! (-2 pts). Réessaye avec le bouton Répondre.");
      return;
    }

    const { participant, score } = await markSolved(gameId, discordId, username);
    await archiveSolve(state, entry, discordId, username, score, participant.solvedAt);

    const seasonRanking = await computeSeasonRanking(state.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);

    await postEphemeral(webhookUrl, `🎉 Bravo, c'était bien **${entry.answer}** !`);

    await sendZoom2DM(
      discordId,
      buildDmEmbed({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        gameId,
        answer: entry.answer,
        score,
        seasonScore: seasonEntry?.totalScore ?? score,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
