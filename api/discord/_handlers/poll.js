// ============================================================
// poll.js — Handlers Discord pour le Sondage public (série de sondages
// natifs Discord, un message par question). Aucune commande Discord
// associée : c'est scripts/postPoll.js qui déclenche la publication, en
// phase de test comme en public.
//
// Contrairement aux mini-jeux (Quiz, Tamagotchi, ...), il n'y a aucun bouton
// ni interaction à gérer pour les questions "choice"/"note" : Discord
// affiche et compte les votes tout seul via l'objet `poll` du message.
//
// Seule la question "freetext" (idées de jeu) déroge à ce principe — un
// sondage natif Discord ne permet pas de champ libre, donc cette question
// est postée comme un message classique avec un bouton "💡 Proposer une
// idée" qui ouvre une Modal (custom_id "poll_idea"/"poll_idea_modal",
// routés dans api/discord/interactions.js). Les idées soumises sont
// stockées dans `poll:ideas` (voir backend/services/poll.js).
// ============================================================

import {
  loadPollConfig,
  readState,
  writeState,
  clearState,
  buildPollObject,
  addIdea,
  listIdeas,
  clearIdeas,
} from "../../../backend/services/poll.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

// Votes "extrêmes" à afficher dans pollStatus.js, par question — décidé par
// Raphael (2026-09-12) : le décompte/la moyenne par réponse sont déjà
// visibles directement dans le sondage natif Discord, seul le détail
// nominatif de certaines réponses jugées intéressantes vaut la peine d'être
// recalculé ici (qui a mis la note la plus basse, qui n'a rien coché, qui a
// coché plusieurs cases). Les questions absentes de cette liste (Q1)
// ne sont pas traitées par pollStatus.js.
//
// - "note-value" : voteurs ayant choisi la valeur `value` (échelle 1-5).
// - "choice-answer" : voteurs ayant choisi la réponse `text` exacte.
// - "choice-answers-any" : union (dédupliquée) des voteurs ayant choisi
//   AU MOINS UNE des réponses de `texts` (allowMultiselect uniquement).
// - "multi-count" : voteurs ayant coché au moins `min` réponses parmi TOUTES
//   celles de la question (nécessite de lister les voteurs de chaque
//   réponse et de croiser — allowMultiselect uniquement).
const EXTREME_RULES = {
  "q2-role-minijeux": { kind: "choice-answer", text: "Je ne sais pas", label: 'Vote "Je ne sais pas"' },
  "q3-regularite": { kind: "note-value", value: "1", label: 'Vote "1"' },
  "q4-freins-participation": {
    kind: "choice-answers-any",
    texts: ["Je n'aime pas ce type de jeu", "Pas assez motivant ou intéressant"],
    label: 'Vote "Je n\'aime pas ce type de jeu" ou "Pas assez motivant ou intéressant"',
  },
  "q5-format-prefere": { kind: "choice-answer", text: "Aucun des deux", label: 'Vote "Aucun des deux"' },
  "q6-prefere-hebdo": { kind: "choice-answer", text: "Aucun", label: 'Vote "Aucun"' },
  "q7-prefere-quotidien": { kind: "choice-answer", text: "Aucun", label: 'Vote "Aucun"' },
  "q8-non-participation-hebdo": { kind: "multi-count", min: 2, label: "2 choix cochés ou plus" },
  "q9-non-participation-quotidien": { kind: "multi-count", min: 2, label: "2 choix cochés ou plus" },
  "q10-satisfaction": { kind: "note-value", value: "1", label: 'Vote "1"' },
};

const IDEA_BUTTON_CUSTOM_ID = "poll_idea";
const IDEA_MODAL_CUSTOM_ID = "poll_idea_modal";
const IDEA_MODAL_INPUT_ID = "poll_idea_input";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteMessage(token, channelId, messageId) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function postMessage(token, channelId, body) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  return res.json();
}

// Poste une question comme sondage natif Discord (POST .../messages avec le
// champ `poll`) et renvoie le message créé (contient l'id assigné à chaque
// réponse, utile pour pollStatus.js).
function postQuestionMessage(token, channelId, questionConfig) {
  return postMessage(token, channelId, { poll: buildPollObject(questionConfig) });
}

// ── Question "freetext" : message + bouton "Proposer une idée" ──

function buildIdeaMessageBody(questionConfig) {
  return {
    embeds: [
      {
        title: "💡 Une idée de jeu ?",
        description: questionConfig.question,
        color: 0xf1c40f,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "💡 Proposer une idée",
            custom_id: IDEA_BUTTON_CUSTOM_ID,
          },
        ],
      },
    ],
  };
}

function postIdeaMessage(token, channelId, questionConfig) {
  return postMessage(token, channelId, buildIdeaMessageBody(questionConfig));
}

// Contenu de la Modal ouverte par le bouton "Proposer une idée" — même
// principe que buildAnswerModal() dans frames.js (Discord n'autorise pas de
// champ texte directement sur un message).
export function buildIdeaModal() {
  return {
    custom_id: IDEA_MODAL_CUSTOM_ID,
    title: "Proposer une idée de jeu",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: IDEA_MODAL_INPUT_ID,
            style: 2,
            label: "Ton idée",
            placeholder: "Un mini-jeu, un jeu spécial, une variante...",
            required: true,
            max_length: 1000,
          },
        ],
      },
    ],
  };
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
    console.error("[Poll] Échec PATCH réponse éphémère:", err.message);
  }
}

// Soumission de la Modal "idée de jeu" — appelé depuis interactions.js après
// avoir répondu type:5 (deferred ephemeral) à Discord.
export async function handleIdeaModalSubmit(webhookUrl, discordId, username, rawText) {
  const text = (rawText || "").trim();
  if (!text) {
    await postEphemeral(webhookUrl, "⚠️ Idée vide, rien n'a été envoyé.");
    return;
  }

  await addIdea({
    discordId,
    username,
    text,
    submittedAt: new Date().toISOString(),
  });

  await postEphemeral(webhookUrl, "✅ Merci, ton idée a bien été envoyée !");
}

// Poste toutes les questions de data/poll/poll.json — chaque question
// "choice"/"note" comme sondage natif distinct, chaque question "freetext"
// comme message + bouton — dans l'ordre, avec une courte pause entre deux
// posts (confort vis-à-vis du rate limit Discord). Écrit l'état une fois
// tout posté.
//
// - Si un sondage est déjà actif sur CE salon et `force` n'est pas passé,
//   ne republie rien (protège d'un double `poll:public` par erreur).
// - Si `force` est passé, les anciens messages déjà trackés sont supprimés
//   avant de reposter (utile en boucle sur le salon de test).
export async function postPoll(channelId, { dryRun = false, force = false } = {}) {
  const config = await loadPollConfig();
  const state = await readState();

  // Le dry-run reste une simple prévisualisation, indépendante de tout état
  // déjà posté — sinon --dry-run devient inutilisable dès qu'un sondage est
  // actif (voir le garde-fou "déjà posté" juste après, qui ne s'applique
  // qu'à la vraie publication).
  if (dryRun) {
    return {
      dryRun: true,
      channelId,
      questions: config.questions.map((q) =>
        q.type === "freetext"
          ? { id: q.id, freetext: buildIdeaMessageBody(q) }
          : { id: q.id, poll: buildPollObject(q) },
      ),
    };
  }

  if (state && !force) {
    return { alreadyPosted: true, state };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (state?.messages?.length) {
    for (const m of state.messages) {
      await deleteMessage(token, m.channelId, m.messageId);
      await sleep(400);
    }
    await clearIdeas();
  }

  const messages = [];
  for (const questionConfig of config.questions) {
    const message =
      questionConfig.type === "freetext"
        ? await postIdeaMessage(token, channelId, questionConfig)
        : await postQuestionMessage(token, channelId, questionConfig);
    messages.push({
      questionId: questionConfig.id,
      question: questionConfig.question,
      type: questionConfig.type,
      channelId,
      messageId: message.id,
    });
    await sleep(400);
  }

  await writeState({
    channelId,
    startedAt: new Date().toISOString(),
    messages,
  });

  return { channelId, messages };
}

// Supprime les messages de sondage déjà postés (tolérant, best-effort),
// efface l'état et les idées soumises — repart de zéro pour un prochain
// `poll:test`/`poll:public`.
export async function resetPoll() {
  const token = process.env.DISCORD_TOKEN;
  const state = await readState();

  let deleted = 0;
  if (state?.messages?.length && token) {
    for (const m of state.messages) {
      const ok = await deleteMessage(token, m.channelId, m.messageId);
      if (ok) deleted += 1;
      await sleep(400);
    }
  }

  await clearState();
  await clearIdeas();

  return { hadState: !!state, messagesDeleted: deleted, totalMessages: state?.messages?.length ?? 0 };
}

// Liste les votants d'une réponse précise d'un sondage natif Discord
// (GET /channels/{id}/polls/{message}/answers/{answer_id}, paginé par 100).
// Contrairement à answer_counts (un simple total), cet endpoint renvoie les
// utilisateurs eux-mêmes — c'est le seul moyen de savoir QUI a voté quoi.
async function getAnswerVoters(token, channelId, messageId, answerId) {
  const voters = [];
  let after;
  for (;;) {
    const url = new URL(
      `https://discord.com/api/v10/channels/${channelId}/polls/${messageId}/answers/${answerId}`,
    );
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
    await sleep(400);
    if (!res.ok) break;

    const data = await res.json();
    const users = data.users ?? [];
    voters.push(...users);
    if (users.length < 100) break;
    after = users[users.length - 1].id;
  }
  return voters;
}

async function resolveVoterNames(voters) {
  return Promise.all(
    voters.map((u) => resolveDisplayName(u.id, u.global_name || u.username)),
  );
}

// Calcule le vote "extrême" d'une question, selon la règle EXTREME_RULES
// correspondante — ne fait un appel "voteurs" que si answer_counts indique
// qu'il y a effectivement au moins un vote sur la réponse concernée (évite
// des appels Discord inutiles).
async function computeExtreme(token, m, poll, rule) {
  const answerIdByText = new Map(
    (poll?.answers ?? []).map((a) => [a.poll_media?.text ?? "", a.answer_id]),
  );
  const countByAnswerId = new Map(
    (poll?.results?.answer_counts ?? []).map((c) => [c.id, c.count]),
  );

  if (rule.kind === "note-value" || rule.kind === "choice-answer") {
    const text = rule.kind === "note-value" ? rule.value : rule.text;
    const answerId = answerIdByText.get(text);
    if (!answerId || !(countByAnswerId.get(answerId) > 0)) return [];
    return resolveVoterNames(await getAnswerVoters(token, m.channelId, m.messageId, answerId));
  }

  if (rule.kind === "choice-answers-any") {
    const votersById = new Map();
    for (const text of rule.texts) {
      const answerId = answerIdByText.get(text);
      if (!answerId || !(countByAnswerId.get(answerId) > 0)) continue;
      const voters = await getAnswerVoters(token, m.channelId, m.messageId, answerId);
      for (const voter of voters) votersById.set(voter.id, voter);
    }
    return resolveVoterNames([...votersById.values()]);
  }

  if (rule.kind === "multi-count") {
    const countByDiscordId = new Map();
    for (const answer of poll?.answers ?? []) {
      if (!(countByAnswerId.get(answer.answer_id) > 0)) continue;
      const voters = await getAnswerVoters(token, m.channelId, m.messageId, answer.answer_id);
      for (const voter of voters) {
        const entry = countByDiscordId.get(voter.id) ?? { count: 0, voter };
        entry.count += 1;
        countByDiscordId.set(voter.id, entry);
      }
    }
    const matching = [...countByDiscordId.values()].filter((entry) => entry.count >= rule.min);
    return resolveVoterNames(matching.map((entry) => entry.voter));
  }

  return [];
}

// Relit chaque message de sondage tracké et calcule uniquement les votes
// "extrêmes" configurés dans EXTREME_RULES (voir ce commentaire pour le
// détail) + les idées soumises pour la question "freetext". Les questions
// sans règle ne sont pas traitées (le décompte/la moyenne restent visibles
// directement dans le sondage natif Discord).
export async function getPollStatus() {
  const state = await readState();
  if (!state) return null;

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const extremes = [];
  for (const m of state.messages) {
    if (m.type === "freetext") continue;

    const rule = EXTREME_RULES[m.questionId];
    if (!rule) continue;

    const res = await fetch(
      `https://discord.com/api/v10/channels/${m.channelId}/messages/${m.messageId}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    await sleep(400);
    if (!res.ok) {
      extremes.push({ questionId: m.questionId, question: m.question, label: rule.label, error: `HTTP ${res.status}` });
      continue;
    }

    const message = await res.json();
    const voters = await computeExtreme(token, m, message.poll, rule);
    extremes.push({ questionId: m.questionId, question: m.question, label: rule.label, voters });
  }

  const ideas = await listIdeas();

  return { ...state, extremes, ideas };
}
