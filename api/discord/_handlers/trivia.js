// ============================================================
// trivia.js — Handlers Discord pour le jeu "Trivia" (QCM de culture Clash
// Royale, 4 propositions A/B/C/D), en alternance une saison sur deux avec
// Frame (voir backend/services/jeuxculture.js). Allégé comme
// _handlers/palette.js : pas de Modal, pas de bouton indice, pas de DM — un
// seul essai par joueur, verrouillé au premier clic (voir
// backend/services/trivia.js). Commande `/trivia` en miroir de `/palette`
// (scores personnels).
// ============================================================

import {
  resolveTriviaEntry,
  loadTriviaCatalog,
  readState,
  writeState,
  startNewGame,
  checkAnswer,
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
  getTriviaRoundLabel,
  getPlayerSeasonResults,
  getGameParticipants,
  findTiedRank,
  LETTERS,
} from "../../../backend/services/trivia.js";
import { toPublicSeasonId } from "../../../backend/services/dateUtils.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const TRIVIA_COLOR = 0xf1c40f;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

function buildTriviaEmbed({
  entryQuestion,
  entryOptionsDisplay,
  seasonId,
  seasonManche,
  seasonMancheTotal,
}) {
  // Propositions dans le CORPS de l'embed (lettre + texte), jamais sur les
  // boutons — ceux-ci n'affichent qu'un label générique "Réponse A/B/C/D"
  // (voir buildTriviaComponents), même convention que buildQuestionEmbed/
  // buildQuestionComponents dans _handlers/quiz.js (référence explicite) :
  // le texte d'une proposition serait trop long pour un bouton Discord.
  const choicesLines = entryOptionsDisplay.map(
    (text, i) => `**${LETTERS[i]}.** ${text}`,
  );
  return {
    title: "🧠 Le jeu du mercredi : Trivia !",
    description: [
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      `# ${entryQuestion}`,
      "",
      ...choicesLines,
      "",
      "**Barème** : bonne réponse = **1 pt**, mauvaise réponse = 0 pt.",
      "Réponds via les boutons ci-dessous — un seul essai possible, définitif.",
    ].join("\n"),
    // Illustration statique (frontend/public/images/trivia/images/), même
    // principe que justecarte-game.webp (buildJusteCarteEmbed) : pas
    // d'image par question, juste une bannière fixe du jeu. Cache-buster
    // (?v=) — même piège documenté pour justecarte/frames/zoom : Discord met
    // en cache l'aperçu d'un embed PAR URL, y compris un échec de fetch.
    image: {
      url: `${TRUST_ROYALE_URL}/images/trivia/images/trivia-game.webp?v=${Date.now()}`,
    },
    color: TRIVIA_COLOR,
    footer: {
      text: "Nouvelle manche : mercredi prochain !",
    },
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Copie quasi identique de buildSeasonRecapEmbed dans palette.js. N'est PAS
// déclenché par postTrivia() lui-même mais uniquement par
// scripts/postJeuxCulture.js : sous l'alternance, ce n'est pas forcément
// Trivia qui reprend la main juste après SA propre saison — seul
// l'orchestrateur partagé sait quand récapituler la bonne saison au bon
// moment (voir backend/services/jeuxculture.js).

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
      return `${label} ${entry.pseudo} — ${entry.totalScore} pts`;
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
    `Bravo à tous ! Rendez-vous juste après pour le lancement de la Saison ${toPublicSeasonId(newSeasonId)}.`,
  );

  return {
    title: `🏆 Fin de la Saison ${toPublicSeasonId(endedSeasonId)} « Trivia » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: TRIVIA_COLOR,
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
      label: await getTriviaRoundLabel(gameId),
    })),
  );
  return manches
    .filter((m) => m.seasonManche != null && m.label != null)
    .sort((a, b) => a.seasonManche - b.seasonManche);
}

// Exportée : appelée directement par scripts/postJeuxCulture.js.
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

// Boutons génériques ("Réponse A", "Réponse B", …) — le texte des réponses
// est réservé à l'embed (voir buildTriviaEmbed), même convention que
// buildQuestionComponents dans _handlers/quiz.js.
function buildTriviaComponents(gameId) {
  return [
    {
      type: 1,
      components: LETTERS.map((letter) => ({
        type: 2,
        style: 2,
        label: `Réponse ${letter}`,
        custom_id: `trivia_answer:${gameId}:${letter}`,
      })),
    },
  ];
}

function displayOrderFor(entry, order) {
  return order ? order.map((optionIdx) => entry.options[optionIdx]) : entry.options;
}

// `force` ignore le garde-fou anti-double-post (alreadyPostedThisWeek) —
// utile pour rattraper un créneau manqué à la main, jamais depuis le cron.
// `skipSeasonRecap` : accepté pour rester homogène avec l'appel de
// l'orchestrateur (scripts/postJeuxCulture.js) — Trivia n'a pas de logique
// de récap interne (comme Palette), le paramètre est donc simplement ignoré.
export async function postTrivia(
  channelId,
  { dryRun = false, force = false, noPing = false, skipSeasonRecap = false } = {},
) {
  void skipSeasonRecap;

  if (dryRun) {
    const gameId = "preview";
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const entryQuestion = "(aperçu, question réelle tirée à la publication)";
    const embed = buildTriviaEmbed({
      gameId,
      entryQuestion,
      entryOptionsDisplay: ["…", "…", "…", "…"],
      seasonId,
      seasonManche,
      seasonMancheTotal,
    });
    const components = buildTriviaComponents(gameId);
    const pingRoleId = noPing
      ? null
      : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return {
      dryRun: true,
      entry: { question: entryQuestion },
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

  const { state: newState, entry, order } = await startNewGame(channelId);
  const embed = buildTriviaEmbed({
    gameId: newState.gameId,
    entryQuestion: entry.question,
    entryOptionsDisplay: displayOrderFor(entry, order),
    seasonId: newState.seasonId,
    seasonManche: newState.seasonManche,
    seasonMancheTotal: newState.seasonMancheTotal,
  });
  const components = buildTriviaComponents(newState.gameId);
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
    console.error("[Trivia] Échec PATCH réponse éphémère:", err.message);
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
      "[Trivia] Échec PATCH réponse éphémère (embed):",
      err.message,
    );
  }
}

// ── Bouton de réponse A/B/C/D ──────────────────────────────────────
// Un simple clic suffit : ACK immédiat (type 5, éphémère) côté routeur,
// tout le traitement se fait ici, en arrière-plan (même principe que
// handleAnswerButton dans palette.js).

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
    const correct = checkAnswer(order, letter);
    const score = computeScore(correct);

    const { participant, alreadyAnswered } = await recordAnswer(
      gameId,
      discordId,
      username,
      letter,
      correct,
      score,
    );
    if (alreadyAnswered) {
      await postEphemeral(
        webhookUrl,
        "Tu as déjà répondu à cette manche, une seule tentative autorisée !",
      );
      return;
    }

    const catalog = await loadTriviaCatalog();
    const entry = resolveTriviaEntry(catalog, gameId);
    if (entry)
      await archiveAnswer(
        state,
        entry,
        discordId,
        username,
        score,
        participant.answeredAt,
      );
    const correctLetter = getCorrectLetter(order);
    const resultLine = correct
      ? `✅ Bonne réponse ! **+${score} pt**`
      : `❌ Mauvaise réponse (tu avais choisi **${letter}**, c'était **${correctLetter}**)`;

    const breakdown = entry
      ? order.map((optionIdx, i) => {
          const marker = optionIdx === 0 ? "🏆" : "";
          return `**${LETTERS[i]}.** ${entry.options[optionIdx]} ${marker}`;
        })
      : [];

    const descriptionLines = [resultLine, "", "**Les 4 propositions :**", ...breakdown];
    if (entry?.source) {
      // Toujours affichée (pas de garde-fou "si dispo") : la crédibilité
      // d'une anecdote de trivia dépend de sa source vérifiable, jamais
      // laissée implicite.
      descriptionLines.push("", `📚 **Source :** ${entry.source}`);
    }

    await postEphemeralEmbed(webhookUrl, {
      description: descriptionLines.join("\n"),
      color: TRIVIA_COLOR,
    });
  } catch (err) {
    console.error("[Trivia] Échec traitement de la réponse:", err.message);
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /trivia : scores personnels du joueur ────────────────
// Miroir de handlePaletteStatsCommand (palette.js), adapté au modèle "essai
// unique" : pas de distinction solved/en cours ni de tentatives à afficher —
// un joueur a répondu (correct ou non) ou n'a pas encore répondu.

function buildTriviaStatsEmbed({
  pseudo,
  currentSeasonManche,
  seasonMancheTotal,
  currentEntryQuestion,
  currentAnswered,
  currentCorrect,
  currentScore,
  totalAnswered,
  correctCount,
  pastManches,
  seasonId,
  seasonTotal,
  seasonRank,
  seasonRankTotal,
}) {
  const lines = [];

  lines.push(
    `**Saison ${toPublicSeasonId(seasonId)} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) — ${currentEntryQuestion} :**`,
  );
  if (currentAnswered) {
    lines.push(
      currentCorrect
        ? "- Tu as trouvé la bonne réponse !"
        : "- Tu t'es trompé de réponse.",
    );
    lines.push(`- Tu as marqué ${currentScore} pt`);
  } else {
    lines.push("- Tu n'as pas encore répondu à cette manche");
  }
  if (totalAnswered > 0) {
    lines.push(
      `- ${totalAnswered} joueur${totalAnswered > 1 ? "s" : ""} ${totalAnswered > 1 ? "ont" : "a"} répondu pour le moment, dont ${correctCount} ${correctCount > 1 ? "ont" : "a"} trouvé`,
    );
  }

  for (const m of pastManches) {
    lines.push("");
    lines.push(
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} — ${m.label} :**`,
    );
    if (m.played) {
      lines.push(
        m.correct
          ? "- Tu as trouvé la bonne réponse !"
          : "- Tu t'es trompé de réponse.",
      );
      lines.push(`- Tu as marqué ${m.score} pt`);
    } else {
      lines.push("- Tu n'as pas joué cette manche");
    }
  }

  lines.push("");
  lines.push(`**Score de la saison (S${toPublicSeasonId(seasonId)}) :**`);
  lines.push(`- Tu as accumulé ${seasonTotal} pt${seasonTotal > 1 ? "s" : ""} cette saison`);
  if (seasonRank != null) {
    lines.push(`- Ton classement : ${seasonRank} / ${seasonRankTotal}`);
  }

  return {
    title: `🧠  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: TRIVIA_COLOR,
  };
}

function buildTriviaStatsComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: "trivia_stats_refresh" },
      ],
    },
  ];
}

export async function handleTriviaStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune manche Trivia n'a encore été lancée.");
      return;
    }

    const catalog = await loadTriviaCatalog();
    const currentEntry = resolveTriviaEntry(catalog, state.gameId);

    const [participant, seasonResults, seasonManches, gameParticipants, seasonRanking] =
      await Promise.all([
        readParticipant(state.gameId, discordId),
        getPlayerSeasonResults(state.seasonId, discordId),
        getSeasonManches(state.seasonId),
        getGameParticipants(state.gameId),
        computeSeasonRanking(state.seasonId),
      ]);

    const currentAnswered = !!participant;
    const currentCorrect = !!participant?.correct;
    const currentScore = participant?.score ?? 0;
    const totalAnswered = gameParticipants.length;
    const correctCount = gameParticipants.filter((p) => p.correct).length;

    const hasSeasonRank = seasonResults.length > 0;
    const seasonRank = hasSeasonRank ? findTiedRank(seasonRanking, discordId, "totalScore") : null;
    const seasonRankTotal = seasonRanking.length;

    const pastGameIds = seasonManches.filter((gameId) => gameId !== state.gameId);
    const pastManches = (
      await Promise.all(
        pastGameIds.map(async (gameId) => {
          const result = seasonResults.find((r) => r.gameId === gameId);
          const label = await getTriviaRoundLabel(gameId);
          return {
            seasonManche: await getSeasonMancheNumber(state.seasonId, gameId),
            label: label ?? result?.question ?? gameId,
            played: !!result,
            correct: !!result && result.score > 0,
            score: result?.score ?? 0,
          };
        }),
      )
    )
      .filter((m) => m.seasonManche != null)
      .sort((a, b) => b.seasonManche - a.seasonManche);

    const seasonTotal = seasonResults.reduce((sum, r) => sum + r.score, 0);

    const embed = buildTriviaStatsEmbed({
      pseudo: username,
      currentSeasonManche: state.seasonManche,
      seasonMancheTotal: state.seasonMancheTotal,
      currentEntryQuestion: currentEntry?.question ?? state.gameId,
      currentAnswered,
      currentCorrect,
      currentScore,
      totalAnswered,
      correctCount,
      pastManches,
      seasonId: state.seasonId,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(webhookUrl, embed, buildTriviaStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
