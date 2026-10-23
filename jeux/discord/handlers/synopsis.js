// ============================================================
// synopsis.js — Handlers Discord du jeu "Synopsis éclaté" (devine le film
// ou la série à partir du pire synopsis possible), groupe "Ciné-club" du
// mercredi (voir jeux/services/refonte.js). Embed, boutons, Modal, DM :
// même parcours que Frame (handlers/frames.js) ; la variante du synopsis
// est affichée d'office, les deux indices sont l'année et la réalisation
// (réalisateur, studio d'animation ou « Série »). En production, la
// publication passe par jeux/scripts/postJeuxCulture.js (orchestrateur du
// groupe, qui poste aussi le récap de fin de saison).
// ============================================================

import {
  loadSynopsis,
  resolveSynopsis,
  getSynopsisLabel,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextSynopsisIndex,
  gameIdFor,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
  markSolved,
  archiveSolve,
  computeSeasonRanking,
  getSeasonManches,
  getSeasonMancheNumber,
  previewSeasonManche,
  computeSeasonMancheTotal,
  findTiedRank,
  alreadyPostedThisWeek,
} from "../../services/synopsis.js";
import { nomSaison } from "../../services/saison.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";

const SYNOPSIS_COLOR = 0x9b59b6;

// « Réalisation » plutôt que « Réalisateur » : la valeur peut être un
// studio d'animation ou « Série ».
const HINT_LABELS = {
  indice1: "Année",
  indice2: "Réalisation",
};

// Phrase affichée après la consigne : la variante n'est plus nommée, elle
// est décrite. Toute nouvelle variante du catalogue s'ajoute ici.
const VARIANTE_PHRASES = {
  "Enfant": "On dirait que c'est un enfant qui raconte.",
  "Djeunz": "On dirait que c'est un ado qui raconte à ses potes.",
  "Figurant": "On dirait que c'est un personnage secondaire qui raconte.",
  "Commentaire sportif": "On dirait un commentaire de match en direct.",
  "Une phrase": "Le tout résumé en une seule phrase.",
  "Ultra-littéral": "On dirait que quelqu'un raconte uniquement ce qu'il voit à l'écran.",
  "Leboncoin": "On dirait une annonce Leboncoin.",
  "Avis 1 étoile": "On dirait un avis client à 1 étoile.",
  "Recette de cuisine": "On dirait une recette de cuisine.",
  "Patch notes": "On dirait les notes de mise à jour d'un jeu vidéo.",
};

// ── Embed / composants du post ────────────────────────────────

function buildSynopsisEmbed({ variante, synopsis, seasonId, seasonManche, seasonMancheTotal }) {
  const consigne = ["Devine le film (ou la série) caché derrière ce synopsis raté.", VARIANTE_PHRASES[variante]];
  return {
    title: "🎬 Le jeu du mercredi : Synopsis éclaté !",
    description: [
      `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      consigne.filter(Boolean).join(" "),
      "",
      // Titre markdown dans la citation : seul moyen d'agrandir le texte
      // dans un embed Discord.
      `> ### ${synopsis}`,
      "",
      "**Barème**",
      "- Réponse exacte du 1er coup sans indice : **10 pts**",
      "- Chaque tentative incorrecte : **-2 pts**",
      "- Chaque indice utilisé : **-3 pts**",
      "",
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**",
    ].join("\n"),
    // Bannière fixe (frontend/public/images/synopsis/). Cache-buster (?v=) :
    // Discord met en cache l'aperçu d'un embed par URL, échecs compris.
    image: { url: `https://trustroyale.vercel.app/images/synopsis/synopsis-game.webp?v=${Date.now()}` },
    color: SYNOPSIS_COLOR,
    footer: { text: "Nouvelle manche : mercredi prochain. Bonne chance tout le monde !" },
  };
}

function buildSynopsisComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "💡 Indice 1 (année)", custom_id: `synopsis_hint1:${gameId}` },
        { type: 2, style: 2, label: "💡 Indice 2 (réalisation)", custom_id: `synopsis_hint2:${gameId}` },
        { type: 2, style: 1, label: "📝 Répondre", custom_id: `synopsis_answer:${gameId}` },
      ],
    },
  ];
}

// Seule une Modal (type 9) permet un champ libre en réponse à un clic.
export function buildAnswerModal(gameId) {
  return {
    custom_id: `synopsis_answer_modal:${gameId}`,
    title: "Quel est ce film ou cette série ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "synopsis_answer_input",
            style: 1,
            label: "Ta réponse",
            placeholder: "Titre du film ou de la série",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Posté uniquement par l'orchestrateur du groupe (jeux/scripts/
// postJeuxCulture.js) : sous l'alternance, lui seul sait quand récapituler
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
    title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « Synopsis éclaté » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: SYNOPSIS_COLOR,
  };
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getSynopsisLabel(gameId),
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
export async function postSynopsis(channelId, { dryRun = false, noPing = false, force = false, skipSeasonRecap = false } = {}) {
  void skipSeasonRecap;

  if (dryRun) {
    const catalogue = await loadSynopsis();
    const entry = catalogue[pickNextSynopsisIndex(await readState(), catalogue)];
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const embed = buildSynopsisEmbed({
      variante: entry.variante,
      synopsis: entry.synopsis,
      seasonId,
      seasonManche,
      seasonMancheTotal: computeSeasonMancheTotal(seasonManche),
    });
    const pingRoleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return { dryRun: true, entry, embed, components: buildSynopsisComponents(gameIdFor(entry)), pingRoleId };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const { state, entry } = await startNewGame(channelId);
  const embed = buildSynopsisEmbed({
    variante: entry.variante,
    synopsis: entry.synopsis,
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
  });
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components: buildSynopsisComponents(state.gameId), ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);
  await deletePreviousRoundMessage(previousState, "Synopsis éclaté");

  return { state, entry, message };
}

// ── Réponse éphémère (PATCH de la réponse différée) ─────────────

async function postEphemeral(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("[Synopsis] Échec PATCH réponse éphémère:", err.message);
  }
}

// ── Boutons indice (année, réalisation) ─────────────────────

export async function handleHintButton(webhookUrl, gameId, hintKey, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }
    const entry = await resolveSynopsis(gameId);
    const hintText = `💡 **${HINT_LABELS[hintKey] || hintKey}** : ${entry[hintKey]}`;

    // Score déjà figé : l'indice ne coûte plus rien, le message le dit.
    if ((await readParticipant(gameId, discordId))?.solved) {
      await postEphemeral(webhookUrl, `${hintText}\n_Tu as déjà trouvé, cet indice ne change plus ton score._`);
      return;
    }

    const { alreadyUsed } = await recordHintUsed(gameId, discordId, username, hintKey);
    const suffix = alreadyUsed ? "_Indice déjà révélé._" : "_Indice révélé (-3 pts)._";
    await postEphemeral(webhookUrl, `${hintText}\n${suffix}`);
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, titre, score, seasonScore }) {
  return [
    `**Synopsis éclaté : ${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🎬 **${titre}**, bien trouvé !`,
    `Score de cette manche : **${score} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendSynopsisDM(discordId, text) {
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
      body: JSON.stringify({ content: text }),
    });
    return true;
  } catch (err) {
    console.error("[Synopsis] Échec envoi DM:", err.message);
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

    const entry = await resolveSynopsis(gameId);
    if (!checkAnswer(entry, rawAnswer)) {
      await recordAttempt(gameId, discordId, username);
      await postEphemeral(webhookUrl, "❌ Mauvaise réponse ! (-2 pts). Réessaye avec le bouton Répondre.");
      return;
    }

    const { participant, score } = await markSolved(gameId, discordId, username);
    await archiveSolve(state, entry, discordId, username, score, participant.solvedAt);

    const seasonRanking = await computeSeasonRanking(state.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);

    await postEphemeral(webhookUrl, `🎉 Bravo, c'était bien **${entry.titre}** !`);

    await sendSynopsisDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        titre: entry.titre,
        score,
        seasonScore: seasonEntry?.totalScore ?? score,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
