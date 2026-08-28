// ============================================================
// quiz.js — Handlers Discord pour le Quiz thématique (7 questions, 1 par
// jour, révélation des bonnes réponses + classement au Jour 7). La
// publication/suppression quotidienne passe uniquement par
// scripts/postQuiz.js (postQuiz) — les boutons restent gérés par
// api/discord/interactions.js.
//
// Contrairement à Tamagoshi, AUCUN compteur de votes n'est jamais affiché
// publiquement (ni sur les boutons, ni en repatchant le message) : le
// contenu du vote de chaque joueur reste secret jusqu'à la révélation.
// ============================================================

import {
  loadQuizConfig,
  readState,
  writeState,
  pickNextMancheIndex,
  getThemeCursor,
  setThemeCursor,
  nextMancheSeq,
  previewNextMancheSeq,
  recordVote,
  computeMancheRanking,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/quiz.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const QUIZ_COLOR = 0x3498db;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const QCM_LETTERS = ["A", "B", "C", "D", "E"];
const TOTAL_QUESTIONS = 7;

// Illustration statique fournie dans l'app — chemin relatif déclaré dans
// data/quiz/quiz.json (champ `image`, jamais d'URL absolue dedans), même
// convention que tamagotchiImageUrl() dans handlers/tamagotchi.js.
function quizImageUrl(relativePath) {
  return relativePath ? `${TRUST_ROYALE_URL}/images/${relativePath}` : null;
}

// "JJ/MM/AAAA HH:mm" (heure de Paris) — horaire de POST, calculé au moment de
// la construction de l'embed (le délai jusqu'à l'envoi effectif est
// négligeable), affiché en footer pour dater le jour posté.
function formatPostedAtParis(date = new Date()) {
  return date.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Embed / composants d'une question ─────────────────────────────
// Les propositions de réponses vivent dans l'EMBED (lettre + texte), jamais
// sur les boutons — ceux-ci n'affichent qu'un label générique "Réponse A/B/…"
// (voir buildQuestionComponents) pour ne jamais laisser deviner le nombre de
// caractères d'une réponse ni gêner la lecture sur mobile.

function buildQuestionEmbed(mancheConfig, question, jour) {
  const image = quizImageUrl(question.image);
  const choicesLines = question.choix.map(
    (label, idx) => `**${QCM_LETTERS[idx]}.** ${label}`,
  );
  return {
    title: `❓ Quiz — ${mancheConfig.theme} — Jour ${jour}/${TOTAL_QUESTIONS}`,
    description: [
      `# ${question.enonce}`,
      "",
      ...choicesLines,
      "",
      "Vote via les boutons ci-dessous — un seul vote possible, définitif. Aucun résultat ni compteur n'est visible avant la révélation finale.",
    ].join("\n"),
    color: QUIZ_COLOR,
    ...(image ? { image: { url: image } } : {}),
    footer: {
      text: [
        `Vote avant ${formatUtcTimeAsParis(8)} demain.`,
        `Heure du quiz : ${formatPostedAtParis()}`,
      ].join("\n"),
    },
  };
}

// Boutons génériques ("Réponse A", "Réponse B", …) — le texte des réponses
// est réservé à l'embed (voir ci-dessus). Le nombre de boutons est dérivé
// directement de la longueur de `choix`, aucune branche dédiée n'est
// nécessaire pour supporter QCM (4) vs vrai/faux (2).
function buildQuestionComponents(manche, jour, question) {
  return [
    {
      type: 1,
      components: question.choix.map((_, idx) => ({
        type: 2,
        style: 2,
        label: `Réponse ${QCM_LETTERS[idx]}`,
        custom_id: `quiz_vote:${manche}:${jour}:${idx}`,
      })),
    },
  ];
}

// ── Embed de révélation finale (Jour 8) ───────────────────────────

function formatMancheHistoryLine(record) {
  const winners = record.winners?.length
    ? record.winners.join(", ")
    : "personne";
  return `Manche ${record.manche} (${record.theme}) : 🏆 ${winners} — ${record.maxScore}/${TOTAL_QUESTIONS}`;
}

async function buildRevealEmbed(manche, mancheConfig, ranking, manchesHistory) {
  const resolved = await Promise.all(
    ranking.map(async (r) => ({
      ...r,
      username: await resolveDisplayName(r.discordId, r.username),
    })),
  );
  const maxScore = resolved[0]?.score ?? 0;
  const winners =
    maxScore > 0 ? resolved.filter((r) => r.score === maxScore) : [];

  const lines = [
    `**Thème : ${mancheConfig.theme}**`,
    "",
    "**Les bonnes réponses :**",
    ...mancheConfig.questions.map(
      (q, idx) =>
        `Jour ${idx + 1} : ${q.enonce} → **${q.choix[q.bonne_reponse]}**`,
    ),
    "",
    "**Classement final :**",
    ...(resolved.length
      ? resolved
          .slice(0, 20)
          .map(
            (r, i) => `${i + 1}. ${r.username} — ${r.score}/${TOTAL_QUESTIONS}`,
          )
      : ["Personne n'a voté cette manche."]),
  ];

  if (winners.length) {
    lines.push(
      "",
      `🏆 Vainqueur${winners.length > 1 ? "s" : ""} (${maxScore}/${TOTAL_QUESTIONS}) : ${winners.map((w) => w.username).join(", ")}`,
    );
  }

  if (manchesHistory.length) {
    lines.push(
      "",
      "**Vainqueurs des manches précédentes :**",
      ...manchesHistory.map(formatMancheHistoryLine),
    );
  }

  return {
    title: "🏁 Quiz — Révélation finale",
    description: lines.join("\n"),
    color: QUIZ_COLOR,
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postQuiz.js) ──

// Supprime le message de la veille (tolérant), poste le nouveau, écrit
// l'état — mirroring publishAndWriteState() de handlers/tamagotchi.js.
async function publishAndWriteState(
  channelId,
  previousState,
  {
    manche,
    mancheIndex,
    mancheId,
    theme,
    jour,
    embed,
    components,
    noPing,
    termine = false,
  },
) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(
          `[Quiz] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Quiz] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Contrairement aux autres jeux collaboratifs, le Quiz pingue à chaque
  // post (Jour 1, jours suivants, révélation finale) — seul --no-ping
  // (tests) le désactive.
  const roleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

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

  await writeState({
    manche,
    mancheIndex,
    mancheId,
    theme,
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
  });

  return { jour, embed, message, termine };
}

export async function postQuiz(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  const config = await loadQuizConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  // Garde-fou anti-double-avancée : un cron en retard qui se déclencherait
  // juste après une relance manuelle du même jour avancerait la manche
  // d'une question de plus, coup sur coup (même incident/pattern que
  // Robinson, 26/08). Jamais appliqué en dry-run. `force` permet un
  // rattrapage volontaire en test.
  if (
    state &&
    !dryRun &&
    !force &&
    isTooSoonSinceLastClosure(state.publishedAt)
  ) {
    return {
      skipped: true,
      reason: "tooSoonSinceLastClosure",
      publishedAt: state.publishedAt,
    };
  }

  // Garde-fou : une manche active sur un AUTRE salon ne doit JAMAIS être
  // reprise ici. Sans ce contrôle, une manche oubliée active sur le salon de
  // test serait avancée (et son message supprimé) puis republiée sur le
  // salon public par le cron --require-active suivant — et inversement, un
  // `quiz:test` lancé par erreur pourrait couper une vraie manche publique en
  // cours. Incident réel du 23/08/2026 : un état de test resté actif a fuité
  // dans le salon public de cette façon.
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une manche déjà lancée manuellement
  // — il ne doit jamais démarrer le Jour 1 tout seul.
  if (!state && requireActiveState) return { skipped: true };

  const estPremierJour = !state;

  if (estPremierJour) {
    const cursor = await getThemeCursor();
    const mancheIndex = pickNextMancheIndex(cursor, config.manches.length);
    const mancheConfig = config.manches[mancheIndex];
    const jour = 1;
    const question = mancheConfig.questions[0];
    const embed = buildQuestionEmbed(mancheConfig, question, jour);

    if (dryRun) {
      const manche = await previewNextMancheSeq();
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return {
        dryRun: true,
        jour,
        theme: mancheConfig.theme,
        embed,
        components: buildQuestionComponents(manche, jour, question),
        pingRoleId,
      };
    }

    const manche = await nextMancheSeq();
    await setThemeCursor(mancheIndex);
    return publishAndWriteState(channelId, null, {
      manche,
      mancheIndex,
      mancheId: mancheConfig.id,
      theme: mancheConfig.theme,
      jour,
      embed,
      components: buildQuestionComponents(manche, jour, question),
      noPing,
    });
  }

  const jour = state.jour + 1;
  const mancheConfig = config.manches[state.mancheIndex];

  if (jour > TOTAL_QUESTIONS) {
    const ranking = await computeMancheRanking(state.manche, mancheConfig);
    const manchesHistory = await listManches({ limit: 10 });
    const embed = await buildRevealEmbed(
      state.manche,
      mancheConfig,
      ranking,
      manchesHistory,
    );

    if (dryRun) return { dryRun: true, final: true, embed };

    // Comme Tamagoshi : jamais archivé en dry-run ni sur le salon de test —
    // seule une vraie publication publique compte comme manche réelle, pour
    // ne jamais polluer l'archive avec des manches de test.
    if (isPublic) {
      const resolved = await Promise.all(
        ranking.map(async (r) => ({
          ...r,
          username: await resolveDisplayName(r.discordId, r.username),
        })),
      );
      const maxScore = resolved[0]?.score ?? 0;
      const winners =
        maxScore > 0
          ? resolved.filter((r) => r.score === maxScore).map((r) => r.username)
          : [];
      await archiveManche({
        manche: state.manche,
        mancheId: state.mancheId,
        theme: state.theme,
        resolvedAt: new Date().toISOString(),
        ranking: resolved,
        winners,
        maxScore,
      });
    }

    const result = await publishAndWriteState(channelId, state, {
      manche: state.manche,
      mancheIndex: state.mancheIndex,
      mancheId: state.mancheId,
      theme: state.theme,
      jour: state.jour,
      embed,
      components: [],
      noPing,
      termine: true,
    });
    // `final: true` distingue explicitement "la révélation vient d'être
    // postée par CET appel" de l'early-return `{ termine: true }` ci-dessus
    // (manche déjà close par un appel précédent, rien à reposter) — les deux
    // cas partagent result.termine === true, seul `final` permet à
    // scripts/postQuiz.js de les distinguer sans ambiguïté.
    return { ...result, final: true };
  }

  const question = mancheConfig.questions[jour - 1];
  const embed = buildQuestionEmbed(mancheConfig, question, jour);
  const components = buildQuestionComponents(state.manche, jour, question);

  if (dryRun) return { dryRun: true, jour, embed, components };

  return publishAndWriteState(channelId, state, {
    manche: state.manche,
    mancheIndex: state.mancheIndex,
    mancheId: state.mancheId,
    theme: state.theme,
    jour,
    embed,
    components,
    noPing,
  });
}

// ── Bouton de vote ─────────────────────────────────────────────────
// Ack routeur : type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, éphémère) —
// confirmation privée uniquement. Contrairement à Tamagoshi, le message
// public n'est JAMAIS repatché (aucun compteur de votes affiché).

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Quiz] Échec PATCH:", err.message);
  }
}

export async function handleQuizVote(
  webhookUrl,
  manche,
  jour,
  choiceIndex,
  discordId,
  username,
) {
  try {
    const state = await readState();
    if (
      !state ||
      state.termine ||
      String(state.manche) !== String(manche) ||
      String(state.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content: "Cette question est déjà close, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const result = await recordVote(
      manche,
      jour,
      discordId,
      choiceIndex,
      username,
    );
    const content =
      result.status === "rejected"
        ? "Tu as déjà voté aujourd'hui, ton vote est définitif jusqu'à la révélation finale !"
        : result.status === "already_recorded"
          ? "Tu as déjà voté cette réponse aujourd'hui, c'est noté !"
          : "Vote enregistré ! Réponse à la révélation finale.";
    await patchOriginal(webhookUrl, { content, embeds: [], components: [] });
  } catch (err) {
    console.error("[Quiz] Échec traitement du vote:", err.message);
  }
}
