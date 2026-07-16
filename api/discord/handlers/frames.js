// ============================================================
// frames.js — Handlers Discord pour le jeu "Frame" (devine le film)
// Embed, boutons, modal, DM. La publication d'une partie passe uniquement
// par scripts/postFrame.js — seule la commande /frame (scores personnels
// du joueur qui l'exécute) est une vraie commande slash.
// ============================================================

import {
  loadFrames,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextFrameIndex,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
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
  findRank,
  findTiedRank,
} from "../../../backend/services/frames.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const FRAME_COLOR = 0x2ecc71;

const HINT_LABELS = {
  indice1: "Année",
  indice2: "Réalisateur",
};

// ── Embed / composants du post ────────────────────────────────

function buildFrameEmbed({ seasonId, seasonManche, seasonMancheTotal, cacheBust }) {
  return {
    title: "🎬 Le jeu du mercredi : Trouvez le film !",
    description:
      `**Saison ${seasonId} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      "Devinez le titre d'un film à partir d'une image.\n\n" +
      "Cliquez sur le bouton «Répondre» pour soumettre votre réponse, ou prenez un indice pour vous aider.\n\n" +
      "**Barème**\n" +
      "- Réponse exacte du 1er coup sans indice : **10 pts**\n" +
      "- Chaque tentative incorrecte : **-2 pts**\n" +
      "- Chaque indice utilisé : **-3 pts**\n\n" +
      "Le classement de la saison est mis à jour après chaque manche, et un DM vous est envoyé pour récapituler vos points et votre classement.\n\n" +
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifiez vos scores avec la commande `/frame`",
    // Route dynamique servant uniquement l'image de la partie active. Le
    // paramètre v= est un cache-buster ignoré par le serveur (impossible
    // d'obtenir une image future en le modifiant) — il DOIT être unique à
    // chaque publication (jamais gameId, qui se répète après un reset ou un
    // tour de boucle) car le proxy d'images de Discord met en cache par URL
    // complète et resservirait indéfiniment une image périmée sinon.
    image: { url: `${TRUST_ROYALE_URL}/api/frames/image?v=${cacheBust}` },
    color: FRAME_COLOR,
    footer: {
      text: "Prochaine manche : dans une semaine. Bonne chance tout le monde !",
    },
  };
}

function buildFrameComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "💡 Indice 1 (année)",
          custom_id: `frame_hint1:${gameId}`,
        },
        {
          type: 2,
          style: 2,
          label: "💡 Indice 2 (réalisateur)",
          custom_id: `frame_hint2:${gameId}`,
        },
        {
          type: 2,
          style: 1,
          label: "📝 Répondre",
          custom_id: `frame_answer:${gameId}`,
        },
      ],
    },
  ];
}

// Contenu de la Modal ouverte par le bouton "Valider" — Discord n'autorise
// pas de champ texte directement sur un message, seule une Modal (type 9)
// permet un "champ libre" en réponse synchrone à un clic de bouton.
export function buildAnswerModal(gameId) {
  return {
    custom_id: `frame_answer_modal:${gameId}`,
    title: "Quel est ce film ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "frame_answer_input",
            style: 1,
            label: "Votre réponse",
            placeholder: "Titre du film...",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Publication (appelée uniquement par scripts/postFrame.js) ──
// En dry-run, aucune écriture d'état ni appel Discord — la prochaine image
// est seulement prévisualisée, sans faire avancer la partie.

export async function postFrame(channelId, { dryRun = false } = {}) {
  if (dryRun) {
    const frames = await loadFrames();
    const state = await readState();
    const currentIndex = pickNextFrameIndex(state, frames);
    const frameEntry = frames[currentIndex];
    const gameId = frameEntry.image.replace(/\.[^.]+$/, "");
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildFrameEmbed({ seasonId, seasonManche, seasonMancheTotal, cacheBust: Date.now() });
    const components = buildFrameComponents(gameId);
    return { dryRun: true, frameEntry, embed, components };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state, frameEntry } = await startNewGame(channelId);
  const embed = buildFrameEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    cacheBust: Date.now(),
  });
  const components = buildFrameComponents(state.gameId);

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

  return { state, frameEntry, message };
}

// Reposte la manche ACTIVE (même gameId) dans un autre salon, sans faire
// avancer la partie ni toucher aux données déjà enregistrées (participants,
// indices, tentatives, résultats archivés) — utile pour déplacer le post
// vers un nouveau salon sans rien perdre. L'ancien message reste
// fonctionnel (les boutons ne vérifient que le gameId, pas le salon), à
// supprimer/éditer manuellement si besoin d'éviter la confusion.
export async function repostFrame(channelId) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const state = await readState();
  if (!state) throw new Error("Aucune partie active à reposter.");

  const frames = await loadFrames();
  const frameEntry = frames[state.currentIndex];

  const embed = buildFrameEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    cacheBust: Date.now(),
  });
  const components = buildFrameComponents(state.gameId);

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
  const newState = { ...state, channelId, messageId: message.id };
  await writeState(newState);

  return { state: newState, frameEntry, message };
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
    console.error("[Frame] Échec PATCH réponse éphémère:", err.message);
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
    console.error("[Frame] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── Bouton indice ────────────────────────────────────────────

export async function handleHintButton(
  webhookUrl,
  gameId,
  hintKey,
  discordId,
  username,
) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const frames = await loadFrames();
    const frameEntry = frames[state.currentIndex];
    const label = HINT_LABELS[hintKey] || hintKey;
    const value = frameEntry[hintKey];

    // Score déjà figé par markSolved() — cliquer un indice après coup ne
    // déduit plus rien, mais le message ne doit pas laisser croire le
    // contraire (pas d'appel à recordHintUsed, inutile une fois résolu).
    const existing = await readParticipant(gameId, discordId);
    if (existing?.solved) {
      await postEphemeral(
        webhookUrl,
        `💡 **${label}** : ${value}\n_Vous avez déjà trouvé, cet indice ne change plus votre score._`,
      );
      return;
    }

    const { alreadyUsed } = await recordHintUsed(
      gameId,
      discordId,
      username,
      hintKey,
    );

    const suffix = alreadyUsed
      ? "_Indice déjà révélé._"
      : "_Indice révélé (-3 pts)._";

    await postEphemeral(webhookUrl, `💡 **${label}** : ${value}\n${suffix}`);
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────

// Classement figé (l'ordre d'arrivée), jamais rafraîchi ensuite — contrairement
// à un "classement : Xe/Y" affiché dans un DM déjà envoyé, qui deviendrait
// faux dès qu'un joueur supplémentaire résout la partie après coup.
function ordinal(n) {
  return `${n}${n === 1 ? "ᵉʳ" : "ᵉ"}`;
}

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, titre, score, gameRank, seasonScore }) {
  return [
    `**Trouvez le film : Saison ${seasonId} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🎬 **${titre}** — vous êtes le ${ordinal(gameRank)} à avoir trouvé !`,
    `Score de cette manche : **${score} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendFrameDM(discordId, text) {
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
    console.error("[Frame] Échec envoi DM:", err.message);
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

    const frames = await loadFrames();
    const frameEntry = frames[state.currentIndex];
    const correct = checkAnswer(frameEntry, rawAnswer);

    if (!correct) {
      await recordAttempt(gameId, discordId, username, false);
      await postEphemeral(
        webhookUrl,
        "❌ Mauvaise réponse ! (-2 pts). Réessayez avec le bouton Répondre.",
      );
      return;
    }

    const { participant, score } = await markSolved(
      gameId,
      discordId,
      username,
    );
    await archiveSolve(
      state,
      frameEntry,
      discordId,
      username,
      score,
      participant.solvedAt,
    );

    const [gameRanking, seasonRanking] = await Promise.all([
      computeGameRanking(gameId),
      computeSeasonRanking(state.seasonId),
    ]);
    const gameRank = findRank(gameRanking, discordId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);

    await postEphemeral(
      webhookUrl,
      `🎉 Bravo, c'était bien **${frameEntry.titre}** !`,
    );

    await sendFrameDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        titre: frameEntry.titre,
        score,
        gameRank,
        seasonScore: seasonEntry?.totalScore ?? score,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /frame : scores personnels du joueur ────────────────

function buildFrameStatsEmbed({
  pseudo,
  currentSeasonManche,
  seasonMancheTotal,
  currentSolved,
  currentInteracted,
  currentScore,
  currentRank,
  solvedCount,
  totalParticipants,
  perfectCount,
  pastManches,
  seasonId,
  seasonTotal,
  seasonRank,
  seasonRankTotal,
}) {
  const lines = [];

  lines.push(`**Saison ${seasonId} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) :**`);
  if (currentSolved) {
    lines.push("- Vous avez trouvé le nom du film !");
    lines.push(`- Vous avez marqué ${currentScore} points`);
    lines.push(`- Votre classement : ${currentRank} / ${solvedCount}`);
  } else if (currentInteracted) {
    lines.push("- Vous n'avez pas encore trouvé le nom du film !");
    lines.push("- Vous n'avez pas marqué de points");
  } else {
    lines.push("- Vous n'avez pas encore commencé cette manche");
  }
  lines.push(
    `- ${solvedCount} joueur${solvedCount > 1 ? "s" : ""} (sur ${totalParticipants}) ${solvedCount > 1 ? "ont" : "a"} trouvé pour le moment, ` +
      `et ${perfectCount} joueur${perfectCount > 1 ? "s" : ""} ${perfectCount > 1 ? "ont" : "a"} 10pts`,
  );

  for (const m of pastManches) {
    lines.push("");
    lines.push(`**Saison ${seasonId} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`);
    if (m.played) {
      lines.push("- Vous avez trouvé le nom du film !");
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
    title: `🎬  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: FRAME_COLOR,
  };
}

function buildFrameStatsComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: "frame_stats_refresh" },
      ],
    },
  ];
}

export async function handleFrameStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune partie Frame n'a encore été lancée.");
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
    const solvedCount = gameRanking.length;
    const totalParticipants = solvedCount + inProgress.length;
    const perfectCount = gameRanking.filter((r) => r.score === 10).length;
    const currentRank = currentSolved ? findTiedRank(gameRanking, discordId, "score") : null;

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

    const embed = buildFrameStatsEmbed({
      pseudo: username,
      currentSeasonManche,
      seasonMancheTotal,
      currentSolved,
      currentInteracted,
      currentScore,
      currentRank,
      solvedCount,
      totalParticipants,
      perfectCount,
      pastManches,
      seasonId: state.seasonId,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(webhookUrl, embed, buildFrameStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
