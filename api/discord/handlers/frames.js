// ============================================================
// frames.js — Handlers Discord pour le jeu "Frame" (devine le film)
// Embed, boutons, modal, DM. Pas de commande slash associée : la
// publication passe uniquement par scripts/postFrame.js.
// ============================================================

import {
  loadFrames,
  readState,
  writeState,
  readHistory,
  startNewGame,
  pickNextFrameIndex,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
  markSolved,
  archiveSolve,
  computeGameRanking,
  computeSeasonRanking,
  findRank,
} from "../../../backend/services/frames.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const FRAME_COLOR = 0x2ecc71;

const HINT_LABELS = {
  indice1: "Année",
  indice2: "Réalisateur",
};

// ── Embed / composants du post ────────────────────────────────

function buildFrameEmbed(frameEntry) {
  return {
    title: "🎬 Quel est ce film ?",
    description:
      "Devinez le titre d'un film à partir de l'image\n\n" +
      "Répondez dans le champ libre ci-dessous et cliquez sur le bouton « Répondre » pour soumettre votre réponse.\n\n" +
      "**Barème**\n" +
      "Réponse exacte du 1er coup sans indice : **10 pts**\n" +
      "Chaque tentative incorrecte : **-2 pts**\n" +
      "Chaque indice utilisé : **-3 pts**",
    image: { url: `${TRUST_ROYALE_URL}/frames/images/${frameEntry.image}` },
    color: FRAME_COLOR,
    footer: { text: "Prochaine partie : dans une semaine. Bonne chance tout le monde !" },
  };
}

function buildFrameComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "💡 Indice 1 (année)", custom_id: `frame_hint1:${gameId}` },
        { type: 2, style: 2, label: "💡 Indice 2 (réalisateur)", custom_id: `frame_hint2:${gameId}` },
        { type: 2, style: 1, label: "📝 Répondre", custom_id: `frame_answer:${gameId}` },
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
    const embed = buildFrameEmbed(frameEntry);
    const components = buildFrameComponents(gameId);
    return { dryRun: true, frameEntry, embed, components };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state, frameEntry } = await startNewGame(channelId);
  const embed = buildFrameEmbed(frameEntry);
  const components = buildFrameComponents(state.gameId);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed], components }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);

  return { state, frameEntry, message };
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

// ── Bouton indice ────────────────────────────────────────────

export async function handleHintButton(webhookUrl, gameId, hintKey, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette partie est terminée.");
      return;
    }

    const frames = await loadFrames();
    const frameEntry = frames[state.currentIndex];
    const { alreadyUsed } = await recordHintUsed(discordId, username, hintKey);

    const label = HINT_LABELS[hintKey] || hintKey;
    const value = frameEntry[hintKey];
    const suffix = alreadyUsed ? "_Indice déjà révélé._" : "_Indice révélé (-3 pts)._";

    await postEphemeral(webhookUrl, `💡 **${label}** : ${value}\n${suffix}`);
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de partie ──────────────────────────────────────

function buildDmText({ titre, score, gameRank, gameTotal, seasonScore, seasonRank, seasonTotal }) {
  return [
    `🎬 **${titre}** — vous avez trouvé !`,
    `Score de cette partie : **${score} pts** (classement : ${gameRank}ᵉ/${gameTotal})`,
    `Score total de la saison : **${seasonScore} pts** (classement général : ${seasonRank}ᵉ/${seasonTotal})`,
  ].join("\n");
}

async function sendFrameDM(discordId, text) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return false;
  try {
    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dmRes.ok) return false;
    const { id: dmChannelId } = await dmRes.json();
    await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    return true;
  } catch (err) {
    console.error("[Frame] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la modal (réponse du joueur) ──────────────────

export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette partie est terminée.");
      return;
    }

    if (state.participants[discordId]?.solved) {
      await postEphemeral(webhookUrl, "Vous avez déjà trouvé la réponse !");
      return;
    }

    const frames = await loadFrames();
    const frameEntry = frames[state.currentIndex];
    const correct = checkAnswer(frameEntry, rawAnswer);

    if (!correct) {
      await recordAttempt(discordId, username, false);
      await postEphemeral(
        webhookUrl,
        "❌ Mauvaise réponse ! (-2 pts). Réessayez avec le bouton Répondre.",
      );
      return;
    }

    const { state: updatedState, score } = await markSolved(discordId, username);
    const solvedAt = updatedState.participants[discordId].solvedAt;
    await archiveSolve(updatedState, frameEntry, discordId, username, score, solvedAt);

    const gameRanking = computeGameRanking(updatedState);
    const gameRank = findRank(gameRanking, discordId);

    const history = await readHistory();
    const seasonRanking = computeSeasonRanking(history, updatedState.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);
    const seasonRank = findRank(seasonRanking, discordId);

    await postEphemeral(webhookUrl, `🎉 Bravo, c'était bien **${frameEntry.titre}** !`);

    await sendFrameDM(
      discordId,
      buildDmText({
        titre: frameEntry.titre,
        score,
        gameRank,
        gameTotal: gameRanking.length,
        seasonScore: seasonEntry?.totalScore ?? score,
        seasonRank,
        seasonTotal: seasonRanking.length,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
