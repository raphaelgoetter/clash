// ============================================================
// motlepluslong.js — Handlers Discord pour le jeu "Le Mot le Plus Long" (12
// lettres tirées, proposer le nom de carte Clash Royale le plus long qu'on
// peut former avec). Embed, bouton, modal. Miroir structurel de
// api/discord/_handlers/lajustecarte.js, avec deux différences (voir
// backend/services/motlepluslong.js pour le détail complet) :
// - pas de "carte secrète" : n'importe quelle carte du pool qui rentre dans
//   le tirage est une réponse valide, il n'y a donc pas de notion de
//   victoire qui termine la manche ;
// - un joueur peut reproposer autant de fois qu'il veut, seul son MEILLEUR
//   mot compte — le bouton "Proposer un mot" reste donc identique après
//   chaque tentative (pas de bouton "Reproposer" séparé comme La Juste
//   Carte).
//
// ⚠️ Statut : phase de TEST UNIQUEMENT. scripts/postMotLePlusLong.js ne
// poste QUE sur le salon de test (DISCORD_CHANNEL_FRAME_TEST, réutilisé —
// voir CONTRIBUTING.md, pas de nouveau salon dédié) et n'expose
// volontairement PAS d'option --public : ce jeu doit remplacer un mini-jeu
// existant dont le choix n'est pas encore arrêté. Ne pas ajouter de cron
// GitHub Actions tant que cette décision n'est pas prise.
// ============================================================

import {
  loadEligiblePool,
  loadFullCardList,
  getCurrentSeasonId,
  readState,
  writeState,
  startNewGame,
  validateSubmission,
  submitWord,
  getGuessHistory,
  canonicalWordForm,
  computeSeasonMancheTotal,
  previewSeasonManche,
  alreadyPostedThisWeek,
} from "../../../backend/services/motlepluslong.js";

const MOTLEPLUSLONG_COLOR = 0x9b59b6;

function buildMotLePlusLongEmbed({ seasonId, seasonManche, seasonMancheTotal, letters }) {
  const lettersDisplay = letters ? letters.join(" ") : "? ? ? ? ? ? ? ? ? ? ? ?";
  return {
    title: "🔤 [TEST] Le Mot le Plus Long",
    description:
      `**Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      `Voici tes 12 lettres :\n\n# ${lettersDisplay}\n\n` +
      "Propose le nom de carte Clash Royale **le plus long** que tu peux former avec ces lettres (espaces et ponctuation ignorés, ex. **P.E.K.K.A** s'écrit **PEKKA**). " +
      "Tu peux reproposer autant de fois que tu veux, seul ton meilleur mot compte — le score est simplement son nombre de lettres.\n\n" +
      "🚧 Jeu en test — les résultats de cette manche ne comptent pas encore pour un classement de saison officiel.",
    color: MOTLEPLUSLONG_COLOR,
    footer: { text: "Manche ouverte jusqu'à la prochaine (jour de publication pas encore fixé)." },
  };
}

function buildAnswerComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "✏️ Proposer un mot",
          custom_id: `motlepluslong_answer:${gameId}`,
        },
      ],
    },
  ];
}

export function buildAnswerModal(gameId) {
  return {
    custom_id: `motlepluslong_answer_modal:${gameId}`,
    title: "Propose un mot",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "motlepluslong_answer_input",
            style: 1,
            label: "Nom de la carte",
            placeholder: "Nom de la carte…",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Publication (appelée uniquement par scripts/postMotLePlusLong.js) ──
// Volontairement plus simple que lajustecarte.js : pas de récap de fin de
// saison (le jeu n'est pas encore rattaché à un vrai classement de saison
// tant qu'il est en test), pas de ping de rôle (jamais utile sur le salon
// de test).
export async function postMotLePlusLong(channelId, { dryRun = false, force = false } = {}) {
  if (dryRun) {
    const pool = await loadEligiblePool();
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildMotLePlusLongEmbed({ seasonId, seasonManche, seasonMancheTotal, letters: null });
    return { dryRun: true, poolSize: pool.length, embed, components: buildAnswerComponents("preview") };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state } = await startNewGame(channelId);
  const embed = buildMotLePlusLongEmbed(state);
  const components = buildAnswerComponents(state.gameId);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);

  return { state, message };
}

// ── Réponse éphémère (PATCH de la réponse différée) ─────────────
// Copie du pattern de lajustecarte.js — voir ce fichier pour le détail.

async function postEphemeral(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("[Mot le Plus Long] Échec PATCH réponse éphémère:", err.message);
  }
}

function formatHistoryLine(history) {
  return history.length > 0 ? `_Tes propositions valides jusqu'ici : ${history.join(", ")}_` : "";
}

// ── Soumission de la modal (réponse du joueur) ──────────────────
export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const [pool, fullList] = await Promise.all([loadEligiblePool(), loadFullCardList()]);
    const result = validateSubmission(pool, fullList, state.letters, rawAnswer);

    if (result.status === "invalid") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `🤔 Je ne reconnais pas « ${rawAnswer} » — vérifie l'orthographe (le nom doit être en français). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    if (result.status === "not-eligible") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `🚫 **${result.entry.fr}** existe dans Clash Royale, mais ne fait pas partie du pool de ce jeu (apostrophe dans le nom, ou plus de 12 lettres). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    if (result.status === "impossible") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `❌ **${result.entry.fr}** (${canonicalWordForm(result.entry.fr)}) est une carte valide pour ce jeu, mais ne rentre pas dans le tirage de cette manche (pas assez de certaines lettres). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    const seasonId = await getCurrentSeasonId();
    const { improved, bestLength } = await submitWord(gameId, discordId, username, result.entry, result.length, seasonId);
    const word = canonicalWordForm(result.entry.fr);

    if (!improved) {
      await postEphemeral(
        webhookUrl,
        `✅ **${word}** (${result.length} lettres) est valide, mais tu as déjà mieux : **${bestLength} lettres**. Continue à chercher !`,
      );
      return;
    }

    const perfect = bestLength >= state.letters.length;
    await postEphemeral(
      webhookUrl,
      `${perfect ? "🏆 Score parfait" : "🎉 Nouveau record"} ! **${word}** (${bestLength} lettre${bestLength > 1 ? "s" : ""}) — c'est ton meilleur mot sur cette manche.`,
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
