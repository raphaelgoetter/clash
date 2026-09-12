// ============================================================
// poll.js — Handlers Discord pour le Sondage public (série de sondages
// natifs Discord, un message par question). Aucune commande Discord
// associée : c'est scripts/postPoll.js qui déclenche la publication, en
// phase de test comme en public.
//
// Contrairement aux mini-jeux (Quiz, Tamagotchi, ...), il n'y a aucun bouton
// ni interaction à gérer côté api/discord/interactions.js : Discord affiche
// et compte les votes tout seul via l'objet `poll` du message.
// ============================================================

import { loadPollConfig, readState, writeState, clearState, buildPollObject } from "../../../backend/services/poll.js";

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

// Poste une question comme sondage natif Discord (POST .../messages avec le
// champ `poll`) et renvoie le message créé (contient l'id assigné à chaque
// réponse, utile pour pollStatus.js).
async function postQuestionMessage(token, channelId, questionConfig) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ poll: buildPollObject(questionConfig) }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  return res.json();
}

// Poste toutes les questions de data/poll/poll.json comme sondages natifs
// distincts, dans l'ordre, avec une courte pause entre deux posts (confort
// vis-à-vis du rate limit Discord). Écrit l'état une fois tout posté.
//
// - Si un sondage est déjà actif sur CE salon et `force` n'est pas passé,
//   ne republie rien (protège d'un double `poll:public` par erreur).
// - Si `force` est passé, les anciens messages déjà trackés sont supprimés
//   avant de reposter (utile en boucle sur le salon de test).
export async function postPoll(channelId, { dryRun = false, force = false } = {}) {
  const config = await loadPollConfig();
  const state = await readState();

  if (state && !force) {
    return { alreadyPosted: true, state };
  }

  if (dryRun) {
    return {
      dryRun: true,
      channelId,
      questions: config.questions.map((q) => ({ id: q.id, poll: buildPollObject(q) })),
    };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (state?.messages?.length) {
    for (const m of state.messages) {
      await deleteMessage(token, m.channelId, m.messageId);
    }
  }

  const messages = [];
  for (const questionConfig of config.questions) {
    const message = await postQuestionMessage(token, channelId, questionConfig);
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

// Supprime les messages de sondage déjà postés (tolérant, best-effort) et
// efface l'état — repart de zéro pour un prochain `poll:test`/`poll:public`.
export async function resetPoll() {
  const token = process.env.DISCORD_TOKEN;
  const state = await readState();

  let deleted = 0;
  if (state?.messages?.length && token) {
    for (const m of state.messages) {
      const ok = await deleteMessage(token, m.channelId, m.messageId);
      if (ok) deleted += 1;
    }
  }

  await clearState();

  return { hadState: !!state, messagesDeleted: deleted, totalMessages: state?.messages?.length ?? 0 };
}

// Relit chaque message de sondage tracké et renvoie son décompte courant
// (Discord fait le tally, on ne fait que le lire).
export async function getPollStatus() {
  const state = await readState();
  if (!state) return null;

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const results = [];
  for (const m of state.messages) {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${m.channelId}/messages/${m.messageId}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok) {
      results.push({ ...m, error: `HTTP ${res.status}` });
      continue;
    }
    const message = await res.json();
    const poll = message.poll;
    const answerTextById = new Map(
      (poll?.answers ?? []).map((a) => [a.answer_id, a.poll_media?.text ?? ""]),
    );
    const counts = (poll?.results?.answer_counts ?? []).map((c) => ({
      text: answerTextById.get(c.id) ?? `#${c.id}`,
      count: c.count,
    }));
    const totalVotes = counts.reduce((sum, c) => sum + c.count, 0);

    results.push({
      ...m,
      isFinalized: poll?.results?.is_finalized ?? false,
      totalVotes,
      counts,
    });
  }

  return { ...state, results };
}
