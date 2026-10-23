// ============================================================
// triviaEngine.js — Handlers Discord communs aux QCM « Trivia » (voir
// jeux/services/triviaEngine.js), instanciés par handlers/trivia.js et
// handlers/triviageek.js. Pas de Modal, pas d'indice, pas de DM : un seul
// essai par joueur, verrouillé au premier clic.
//
// config :
//   name, emoji, color   — nom affiché (« Trivia »), émoji, couleur d'embed
//   jour                  — jour de publication affiché (« mercredi »)
//   answerPrefix          — préfixe des custom_id des boutons A/B/C/D
//   statsRefreshId        — custom_id du bouton « Rafraîchir » des scores
//   bannerPath            — image fixe du jeu (frontend TrustRoyale), ou null
// ============================================================

import { nomSaison, deMois } from "../../services/saison.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

export function createTriviaHandlers(svc, { name, emoji, color, jour, answerPrefix, statsRefreshId, bannerPath }) {
  const { LETTERS } = svc;
  const logTag = `[${name}]`;

  function buildTriviaEmbed({ entryTitre, entryQuestion, entryOptionsDisplay, seasonId, seasonManche, seasonMancheTotal }) {
    // Propositions dans le CORPS de l'embed (lettre + texte), jamais sur les
    // boutons : le texte d'une proposition serait trop long pour un bouton.
    const choicesLines = entryOptionsDisplay.map((text, i) => `**${LETTERS[i]}.** ${text}`);
    const embed = {
      title: `${emoji} Le jeu du ${jour} : ${name} !`,
      description: [
        `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
        "",
        ...(entryTitre ? [`*${entryTitre}*`] : []),
        `# ${entryQuestion}`,
        "",
        ...choicesLines,
        "",
        "**Barème** : bonne réponse = **1 pt**, mauvaise réponse = 0 pt.",
        "Réponds via les boutons ci-dessous : un seul essai possible, définitif.",
      ].join("\n"),
      color,
      footer: { text: `Nouvelle manche : ${jour} prochain !` },
    };
    // Cache-buster (?v=) : Discord met en cache l'aperçu d'un embed PAR URL,
    // y compris un échec de fetch (même piège que justecarte/frames/zoom).
    if (bannerPath) embed.image = { url: `${TRUST_ROYALE_URL}${bannerPath}?v=${Date.now()}` };
    return embed;
  }

  // Boutons génériques (« Réponse A »…) — le texte des réponses est réservé
  // à l'embed.
  function buildTriviaComponents(gameId) {
    return [
      {
        type: 1,
        components: LETTERS.map((letter) => ({
          type: 2,
          style: 2,
          label: `Réponse ${letter}`,
          custom_id: `${answerPrefix}:${gameId}:${letter}`,
        })),
      },
    ];
  }

  function displayOrderFor(entry, order) {
    return order ? order.map((optionIdx) => entry.options[optionIdx]) : entry.options;
  }

  // ── Récapitulatif de fin de saison ────────────────────────────────
  // Jamais déclenché par post() lui-même mais par l'orchestrateur du
  // groupe : sous l'alternance, seul lui sait quand récapituler la bonne
  // saison au bon moment.
  function buildSeasonRecapEmbed(seasonRanking, endedSeasonId, newSeasonId, manchesPlayed) {
    const nonZero = seasonRanking.filter((r) => r.totalScore > 0);
    const shown = nonZero.slice(0, SEASON_RECAP_MAX_PLAYERS);
    const hiddenCount = nonZero.length - shown.length;

    const lines = [
      "**Classement final :**",
      ...shown.map((entry) => {
        const rank = svc.findTiedRank(shown, entry.discordId, "totalScore");
        const tiedCount = shown.filter((e) => e.totalScore === entry.totalScore).length;
        const label = tiedCount === 1 && rank <= 3 ? SEASON_RECAP_MEDALS[rank - 1] : `${rank}.`;
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
      title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « ${name} » !`,
      description:
        `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
        lines.join("\n"),
      color,
    };
  }

  async function getSeasonManchesPlayed(seasonId) {
    const gameIds = await svc.getSeasonManches(seasonId);
    const manches = await Promise.all(
      gameIds.map(async (gameId) => ({
        seasonManche: await svc.getSeasonMancheNumber(seasonId, gameId),
        label: await svc.getTriviaRoundLabel(gameId),
      })),
    );
    return manches
      .filter((m) => m.seasonManche != null && m.label != null)
      .sort((a, b) => a.seasonManche - b.seasonManche);
  }

  async function postSeasonRecap(channelId, endedSeasonId, newSeasonId, { noPing = false } = {}) {
    const seasonRanking = await svc.computeSeasonRanking(endedSeasonId);
    if (seasonRanking.length === 0) return; // rien à récapituler

    const resolvedRanking = await Promise.all(
      seasonRanking.map(async (entry) => ({
        ...entry,
        pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
      })),
    );
    const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
    const embed = buildSeasonRecapEmbed(resolvedRanking, endedSeasonId, newSeasonId, manchesPlayed);
    const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
    }
  }

  // ── Publication d'une manche ────────────────────────────────────────
  // `force` ignore le garde-fou anti-double-post — utile pour rattraper un
  // créneau manqué à la main, jamais depuis le cron. `skipSeasonRecap` :
  // accepté pour rester homogène avec l'appel de l'orchestrateur, ignoré
  // (pas de logique de récap interne).
  async function post(channelId, { dryRun = false, force = false, noPing = false, skipSeasonRecap = false } = {}) {
    void skipSeasonRecap;

    if (dryRun) {
      const gameId = "preview";
      const seasonId = await svc.getCurrentSeasonId();
      const seasonManche = await svc.previewSeasonManche(seasonId);
      const seasonMancheTotal = svc.computeSeasonMancheTotal(seasonManche);
      const entryQuestion = "(aperçu, question réelle tirée à la publication)";
      const embed = buildTriviaEmbed({
        entryTitre: null,
        entryQuestion,
        entryOptionsDisplay: ["…", "…", "…", "…"],
        seasonId,
        seasonManche,
        seasonMancheTotal,
      });
      const pingRoleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
      return {
        dryRun: true,
        entry: { question: entryQuestion },
        embed,
        components: buildTriviaComponents(gameId),
        pingRoleId,
      };
    }

    if (!force && (await svc.alreadyPostedThisWeek())) {
      return { skipped: true, reason: "already-posted-this-week" };
    }

    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN manquant.");

    const previousState = await svc.readState();
    const { state: newState, entry, order } = await svc.startNewGame(channelId);
    // La manche précédente est désormais close : si sa question porte un
    // erratum, le point est offert et l'erratum annoncé AVANT la nouvelle
    // question. Un échec n'empêche jamais la publication de la manche.
    if (previousState?.gameId) {
      await postErratumIfNeeded(channelId, previousState.gameId).catch((err) =>
        console.error(`${logTag} Échec de l'erratum:`, err.message),
      );
    }
    const embed = buildTriviaEmbed({
      entryTitre: entry.titre,
      entryQuestion: entry.question,
      entryOptionsDisplay: displayOrderFor(entry, order),
      seasonId: newState.seasonId,
      seasonManche: newState.seasonManche,
      seasonMancheTotal: newState.seasonMancheTotal,
    });
    const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [embed],
        components: buildTriviaComponents(newState.gameId),
        ...buildRolePingFields(roleId),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
    }

    const message = await res.json();
    newState.messageId = message.id;
    await svc.writeState(newState);
    await deletePreviousRoundMessage(previousState, name);

    return { state: newState, entry, message };
  }

  // ── Erratum automatique ─────────────────────────────────────────────
  // Point offert à tous les participants (idempotent) puis message public,
  // sans ping, posté une seule fois.
  function buildErratumEmbed(erratum, participantCount) {
    return {
      title: `📢 ${name} : erratum`,
      description: [
        ...erratum.announcement,
        "",
        `🎁 Le point de cette manche est offert à tous les participants (**${participantCount}** joueur${participantCount > 1 ? "s" : ""}).`,
        "",
        "Merci au joueur qui l'a signalé, et toutes nos excuses !",
      ].join("\n"),
      color,
    };
  }

  async function postErratumIfNeeded(channelId, gameId) {
    const entry = svc.resolveTriviaEntry(await svc.loadTriviaCatalog(), gameId);
    if (!entry?.erratum) return;

    const participantCount = await svc.grantErratumPoint(gameId, entry.erratum.correctedAnswer);
    if (participantCount === 0) return;
    if (!(await svc.claimErratumAnnouncement(gameId))) return;

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [buildErratumEmbed(entry.erratum, participantCount)],
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      await svc.releaseErratumAnnouncement(gameId);
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi erratum (${res.status}): ${errText}`);
    }
    console.log(`${logTag} Erratum ${gameId} posté (${participantCount} participant(s)).`);
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
      console.error(`${logTag} Échec PATCH réponse éphémère:`, err.message);
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
      console.error(`${logTag} Échec PATCH réponse éphémère (embed):`, err.message);
    }
  }

  // ── Bouton de réponse A/B/C/D ───────────────────────────────────────
  // ACK immédiat (type 5, éphémère) côté routeur, tout le traitement se fait
  // ici, en arrière-plan.
  async function handleAnswerButton(webhookUrl, gameId, letter, discordId, username) {
    try {
      const state = await svc.readState();
      if (!state || state.gameId !== gameId) {
        await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée, une nouvelle a peut-être déjà commencé !");
        return;
      }

      if (await svc.readParticipant(gameId, discordId)) {
        await postEphemeral(webhookUrl, "Tu as déjà répondu à cette manche, une seule tentative autorisée !");
        return;
      }

      const order = await svc.readRoundOrder(gameId);
      const correct = svc.checkAnswer(order, letter);
      const score = svc.computeScore(correct);

      const { participant, alreadyAnswered } = await svc.recordAnswer(
        gameId,
        discordId,
        username,
        letter,
        correct,
        score,
      );
      if (alreadyAnswered) {
        await postEphemeral(webhookUrl, "Tu as déjà répondu à cette manche, une seule tentative autorisée !");
        return;
      }

      const entry = svc.resolveTriviaEntry(await svc.loadTriviaCatalog(), gameId);
      if (entry) await svc.archiveAnswer(state, entry, discordId, username, score, participant.answeredAt);
      const correctLetter = svc.getCorrectLetter(order);
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
      if (entry?.erratum) {
        descriptionLines.push("", `⚠️ **Erratum :** ${entry.erratum.notice}`);
      }
      if (entry?.source) {
        // Toujours affichée : la crédibilité d'une anecdote de trivia dépend
        // de sa source vérifiable.
        descriptionLines.push("", `📚 **Source :** ${entry.source}`);
      }

      await postEphemeralEmbed(webhookUrl, { description: descriptionLines.join("\n"), color });
    } catch (err) {
      console.error(`${logTag} Échec traitement de la réponse:`, err.message);
      await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
    }
  }

  // ── Commande de scores personnels (/trivia) ─────────────────────────
  // Modèle « essai unique » : un joueur a répondu (correct ou non) ou n'a
  // pas encore répondu.
  function buildStatsEmbed({
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
      `**${nomSaison(seasonId)} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) · ${currentEntryQuestion} :**`,
    );
    if (currentAnswered) {
      lines.push(currentCorrect ? "- Tu as trouvé la bonne réponse !" : "- Tu t'es trompé de réponse.");
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
      lines.push(`**${nomSaison(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} · ${m.label} :**`);
      if (m.played) {
        lines.push(m.correct ? "- Tu as trouvé la bonne réponse !" : "- Tu t'es trompé de réponse.");
        lines.push(`- Tu as marqué ${m.score} pt`);
      } else {
        lines.push("- Tu n'as pas joué cette manche");
      }
    }

    lines.push("");
    lines.push(`**Score de la saison ${deMois(seasonId)} :**`);
    lines.push(`- Tu as accumulé ${seasonTotal} pt${seasonTotal > 1 ? "s" : ""} cette saison`);
    if (seasonRank != null) {
      lines.push(`- Ton classement : ${seasonRank} / ${seasonRankTotal}`);
    }

    return {
      title: `${emoji}  Scores de ${pseudo}`,
      description: lines.join("\n"),
      color,
    };
  }

  async function handleStatsCommand(webhookUrl, discordId, username) {
    try {
      const state = await svc.readState();
      if (!state) {
        await postEphemeral(webhookUrl, `⚠️ Aucune manche ${name} n'a encore été lancée.`);
        return;
      }

      const currentEntry = svc.resolveTriviaEntry(await svc.loadTriviaCatalog(), state.gameId);

      const [participant, seasonResults, seasonManches, gameParticipants, seasonRanking] = await Promise.all([
        svc.readParticipant(state.gameId, discordId),
        svc.getPlayerSeasonResults(state.seasonId, discordId),
        svc.getSeasonManches(state.seasonId),
        svc.getGameParticipants(state.gameId),
        svc.computeSeasonRanking(state.seasonId),
      ]);

      const pastGameIds = seasonManches.filter((gameId) => gameId !== state.gameId);
      const pastManches = (
        await Promise.all(
          pastGameIds.map(async (gameId) => {
            const result = seasonResults.find((r) => r.gameId === gameId);
            const label = await svc.getTriviaRoundLabel(gameId);
            return {
              seasonManche: await svc.getSeasonMancheNumber(state.seasonId, gameId),
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

      const embed = buildStatsEmbed({
        pseudo: username,
        currentSeasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        currentEntryQuestion: currentEntry?.question ?? state.gameId,
        currentAnswered: !!participant,
        currentCorrect: !!participant?.correct,
        currentScore: participant?.score ?? 0,
        totalAnswered: gameParticipants.length,
        correctCount: gameParticipants.filter((p) => p.correct).length,
        pastManches,
        seasonId: state.seasonId,
        seasonTotal: seasonResults.reduce((sum, r) => sum + r.score, 0),
        seasonRank: seasonResults.length > 0 ? svc.findTiedRank(seasonRanking, discordId, "totalScore") : null,
        seasonRankTotal: seasonRanking.length,
      });

      const components = statsRefreshId
        ? [{ type: 1, components: [{ type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: statsRefreshId }] }]
        : [];
      await postEphemeralEmbed(webhookUrl, embed, components);
    } catch (err) {
      await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
    }
  }

  return { post, postSeasonRecap, handleAnswerButton, handleStatsCommand };
}
