// ============================================================
// anagrams.js — Handlers Discord pour le jeu "Anagram" (devine la carte
// Clash Royale à partir d'une anagramme). Embed, boutons, modal, DM. La
// publication d'une partie passe uniquement par scripts/postAnagram.js —
// seule la commande /anagram (scores personnels du joueur qui l'exécute)
// est une vraie commande slash. Miroir de api/discord/handlers/frames.js.
// ============================================================

import {
  loadAnagrams,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextAnagramIndex,
  checkAnswer,
  recordAttempt,
  markSolved,
  archiveSolve,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
  getPlayerSeasonResults,
  getSeasonManches,
  hasPlayerInteracted,
  getSeasonMancheNumber,
  previewSeasonManche,
  computeSeasonMancheTotal,
  getCardImageUrl,
  alreadyPostedThisWeek,
  computeWeeklySlotIndex,
  shouldPostThisSlot,
  findTiedRank,
} from "../../../backend/services/anagrams.js";

const ANAGRAM_COLOR = 0x9b59b6;

// ── Embed / composants du post ────────────────────────────────

function buildAnagramEmbed({ seasonId, seasonManche, seasonMancheTotal, anagram }) {
  return {
    title: "🔤 Le jeu du samedi : Trouvez la carte !",
    description:
      `**Saison ${seasonId} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      "Devinez le nom de la carte Clash Royale à partir de son anagramme :\n\n" +
      `**${anagram}**\n\n` +
      "Cliquez sur le bouton «Répondre» pour soumettre votre réponse.\n\n" +
      "**Barème** — vos points dépendent de votre rang d'arrivée :\n" +
      "- 1er à trouver : **10 pts**, 2e : **9 pts**, 3e : **8 pts**...\n" +
      "- 0 pt à partir du 11e joueur\n\n" +
      "Le classement de la saison est mis à jour après chaque manche, et un DM vous est envoyé pour récapituler vos points et votre classement.\n\n" +
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifiez vos scores avec la commande `/anagram`",
    color: ANAGRAM_COLOR,
    footer: {
      text: "Prochaine manche : un samedi, à une heure surprise !",
    },
  };
}

function buildAnagramComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "📝 Répondre",
          custom_id: `anagram_answer:${gameId}`,
        },
      ],
    },
  ];
}

// Contenu de la Modal ouverte par le bouton "Répondre" — voir frames.js pour
// le mécanisme détaillé (réponse synchrone type:9, MODAL_SUBMIT type:5 entrant
// à ne pas confondre avec le type:5 de réponse DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).
export function buildAnswerModal(gameId) {
  return {
    custom_id: `anagram_answer_modal:${gameId}`,
    title: "Quelle est cette carte ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "anagram_answer_input",
            style: 1,
            label: "Nom de la carte",
            placeholder: "Nom de la carte...",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Copie quasi identique de buildSeasonRecapEmbed dans frames.js (mêmes
// règles : troncage à 20 joueurs, exclusion des 0 pt, gestion des ex-aequo
// pour les médailles), libellé adapté au jeu Anagram.

const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

function buildSeasonRecapEmbed(seasonRanking, endedSeasonId, newSeasonId) {
  const nonZero = seasonRanking.filter((r) => r.totalScore > 0);
  const shown = nonZero.slice(0, SEASON_RECAP_MAX_PLAYERS);
  const hiddenCount = nonZero.length - shown.length;

  const topScore = shown[0]?.totalScore;
  const winners = shown.filter((r) => r.totalScore === topScore);
  const winnerNames = winners.map((w) => w.pseudo).join(" et ");

  const lines = [
    winners.length > 1
      ? `🥇 ${winnerNames} remportent la saison avec ${topScore} pts !`
      : `🥇 ${winnerNames} remporte la saison avec ${topScore} pts !`,
    "",
    "**Classement final :**",
    ...shown.map((entry) => {
      const rank = findTiedRank(shown, entry.discordId, "totalScore");
      const tiedCount = shown.filter((e) => e.totalScore === entry.totalScore).length;
      const label = tiedCount === 1 && rank <= 3 ? SEASON_RECAP_MEDALS[rank - 1] : `${rank}.`;
      return `${label} ${entry.pseudo} — ${entry.totalScore} pts`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(`... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`);
  }
  lines.push("", `Bravo à tous ! Rendez-vous juste après pour le lancement de la Saison ${newSeasonId}.`);

  return {
    title: `🏆 Fin de la Saison ${endedSeasonId} !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à « Trouvez la carte » cette saison !\n\n` +
      lines.join("\n"),
    color: ANAGRAM_COLOR,
  };
}

async function postSeasonRecap(channelId, endedSeasonId, newSeasonId) {
  const token = process.env.DISCORD_TOKEN;
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

  const embed = buildSeasonRecapEmbed(seasonRanking, endedSeasonId, newSeasonId);
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

// ── Publication (appelée uniquement par scripts/postAnagram.js) ──
// En dry-run, aucune écriture d'état ni appel Discord — la prochaine
// anagramme est seulement prévisualisée, sans faire avancer la partie.
// `force` bypasse le gating hebdomadaire (jour + tirage aléatoire) — utilisé
// pour les tests manuels et le rattrapage si le cron a raté toute sa fenêtre.

export async function postAnagram(channelId, { dryRun = false, force = false } = {}) {
  if (dryRun) {
    const anagrams = await loadAnagrams();
    const state = await readState();
    const currentIndex = pickNextAnagramIndex(state, anagrams);
    const entry = anagrams[currentIndex];
    const gameId = String(entry.ID);
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildAnagramEmbed({ seasonId, seasonManche, seasonMancheTotal, anagram: entry.anagram });
    const components = buildAnagramComponents(gameId);

    let seasonRecapEmbed = null;
    if (state?.seasonId != null && seasonId != null && state.seasonId !== seasonId) {
      const seasonRanking = await computeSeasonRanking(state.seasonId);
      if (seasonRanking.length > 0) {
        seasonRecapEmbed = buildSeasonRecapEmbed(seasonRanking, state.seasonId, seasonId);
      }
    }

    return { dryRun: true, entry, embed, components, seasonRecapEmbed };
  }

  if (!force) {
    const now = new Date();
    if (now.getUTCDay() !== 6) {
      return { skipped: true, reason: "not-saturday" };
    }
    if (await alreadyPostedThisWeek(now)) {
      return { skipped: true, reason: "already-posted-this-week" };
    }
    const slotIndex = computeWeeklySlotIndex(now);
    if (!shouldPostThisSlot(slotIndex)) {
      return { skipped: true, reason: `not-selected-slot-${slotIndex}` };
    }
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const newSeasonId = await getCurrentSeasonId();
  if (previousState?.seasonId != null && newSeasonId != null && previousState.seasonId !== newSeasonId) {
    await postSeasonRecap(channelId, previousState.seasonId, newSeasonId);
  }

  const { state, entry } = await startNewGame(channelId);
  const embed = buildAnagramEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    anagram: entry.anagram,
  });
  const components = buildAnagramComponents(state.gameId);

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], components }),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);

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
    console.error("[Anagram] Échec PATCH réponse éphémère:", err.message);
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
    console.error("[Anagram] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── DM de fin de manche ──────────────────────────────────────

function ordinal(n) {
  return `${n}${n === 1 ? "ᵉʳ" : "ᵉ"}`;
}

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, reponse, score, position, seasonScore }) {
  return [
    `**Trouvez la carte : Saison ${seasonId} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🃏 **${reponse}** — vous êtes le ${ordinal(position)} à avoir trouvé !`,
    `Score de cette manche : **${score} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendAnagramDM(discordId, text) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return false;
  try {
    const dmRes = await fetch(
      "https://discord.com/api/v10/users/@me/channels",
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: discordId }),
      },
    );
    if (!dmRes.ok) return false;
    const { id: dmChannelId } = await dmRes.json();
    await fetch(
      `https://discord.com/api/v10/channels/${dmChannelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      },
    );
    return true;
  } catch (err) {
    console.error("[Anagram] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la modal (réponse du joueur) ──────────────────

export async function handleModalSubmit(
  webhookUrl,
  gameId,
  discordId,
  username,
  rawAnswer,
) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const existing = await readParticipant(gameId, discordId);
    if (existing?.solved) {
      await postEphemeral(webhookUrl, "Vous avez déjà trouvé la réponse !");
      return;
    }

    const anagrams = await loadAnagrams();
    const entry = anagrams[state.currentIndex];
    const correct = checkAnswer(entry, rawAnswer);

    if (!correct) {
      await recordAttempt(gameId, discordId, username, false);
      await postEphemeral(
        webhookUrl,
        "❌ Mauvaise réponse ! Réessayez avec le bouton Répondre.",
      );
      return;
    }

    const { participant, score } = await markSolved(gameId, discordId, username);
    await archiveSolve(
      state,
      entry,
      discordId,
      username,
      score,
      participant.position,
      participant.solvedAt,
    );

    const seasonRanking = await computeSeasonRanking(state.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);
    const imageUrl = await getCardImageUrl(entry.cardKey);

    await postEphemeralEmbed(webhookUrl, {
      title: "🃏 Bravo !",
      description:
        `C'était bien **${entry.answer}** — vous êtes le ${ordinal(participant.position)} à avoir trouvé !\n` +
        `Score de cette manche : **${score} pts**`,
      ...(imageUrl ? { image: { url: imageUrl } } : {}),
      color: ANAGRAM_COLOR,
    });

    await sendAnagramDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        reponse: entry.answer,
        score,
        position: participant.position,
        seasonScore: seasonEntry?.totalScore ?? score,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /anagram : scores personnels du joueur ────────────────

function buildAnagramStatsEmbed({
  pseudo,
  currentSeasonManche,
  seasonMancheTotal,
  currentSolved,
  currentInteracted,
  currentScore,
  currentPosition,
  solvedCount,
  totalParticipants,
  pastManches,
  seasonId,
  seasonTotal,
  seasonRank,
  seasonRankTotal,
}) {
  const lines = [];

  lines.push(`**Saison ${seasonId} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) :**`);
  if (currentSolved) {
    lines.push(`- Vous avez trouvé le nom de la carte (${ordinal(currentPosition)} à trouver) !`);
    lines.push(`- Vous avez marqué ${currentScore} points`);
  } else if (currentInteracted) {
    lines.push("- Vous n'avez pas encore trouvé le nom de la carte !");
    lines.push("- Vous n'avez pas marqué de points");
  } else {
    lines.push("- Vous n'avez pas encore commencé cette manche");
  }
  lines.push(
    `- ${solvedCount} joueur${solvedCount > 1 ? "s" : ""} (sur ${totalParticipants}) ${solvedCount > 1 ? "ont" : "a"} trouvé pour le moment`,
  );

  for (const m of pastManches) {
    lines.push("");
    lines.push(`**Saison ${seasonId} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`);
    if (m.played) {
      lines.push("- Vous avez trouvé le nom de la carte !");
      lines.push(`- Vous avez marqué ${m.score} points`);
    } else {
      lines.push("- Vous n'avez pas joué cette manche");
    }
  }

  lines.push("");
  lines.push(`**Score de la saison (S${seasonId}) :**`);
  lines.push(`- Vous avez accumulé ${seasonTotal} points cette saison`);
  if (seasonRank != null) {
    lines.push(`- Votre classement : ${seasonRank} / ${seasonRankTotal}`);
  }

  return {
    title: `🔤  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: ANAGRAM_COLOR,
  };
}

function buildAnagramStatsComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: "anagram_stats_refresh" },
      ],
    },
  ];
}

export async function handleAnagramStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune partie Anagram n'a encore été lancée.");
      return;
    }

    const [participant, seasonResults, seasonManches, currentInteracted, gameRanking, inProgress, seasonRanking] =
      await Promise.all([
        readParticipant(state.gameId, discordId),
        getPlayerSeasonResults(state.seasonId, discordId),
        getSeasonManches(state.seasonId),
        hasPlayerInteracted(state.gameId, discordId),
        computeGameRanking(state.gameId),
        listGamePlayersInProgress(state.gameId),
        computeSeasonRanking(state.seasonId),
      ]);

    const currentSeasonManche = state.seasonManche;
    const seasonMancheTotal = state.seasonMancheTotal;
    const currentSolved = !!participant?.solved;
    const currentScore = participant?.score ?? 0;
    const currentPosition = participant?.position ?? null;
    const solvedCount = gameRanking.length;
    const totalParticipants = solvedCount + inProgress.length;

    const hasSeasonRank = seasonResults.length > 0;
    const seasonRank = hasSeasonRank ? findTiedRank(seasonRanking, discordId, "totalScore") : null;
    const seasonRankTotal = seasonRanking.length;

    const pastGameIds = seasonManches.filter((gameId) => gameId !== state.gameId);
    const pastManches = (
      await Promise.all(
        pastGameIds.map(async (gameId) => {
          const result = seasonResults.find((r) => r.gameId === gameId);
          return {
            seasonManche: await getSeasonMancheNumber(state.seasonId, gameId),
            played: !!result,
            score: result?.score ?? 0,
          };
        }),
      )
    )
      .filter((m) => m.seasonManche != null)
      .sort((a, b) => b.seasonManche - a.seasonManche);

    const seasonTotal = seasonResults.reduce((sum, r) => sum + r.score, 0);

    const embed = buildAnagramStatsEmbed({
      pseudo: username,
      currentSeasonManche,
      seasonMancheTotal,
      currentSolved,
      currentInteracted,
      currentScore,
      currentPosition,
      solvedCount,
      totalParticipants,
      pastManches,
      seasonId: state.seasonId,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(webhookUrl, embed, buildAnagramStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
