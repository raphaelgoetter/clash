// ============================================================
// blindroyale.js — Handlers Discord pour le jeu "Blind Royale" (devine la
// carte Clash Royale à partir du son qu'elle produit). Embed, bouton indice,
// modal, DM. La publication d'une partie passe uniquement par
// scripts/postBlindRoyale.js — seule la commande /blindroyale (scores
// personnels du joueur qui l'exécute) est une vraie commande slash.
//
// Miroir structurel de zoom.js — même barème (10 pts de départ, -2 pts par
// mauvaise réponse, -3 pts si indice utilisé), pas de notion de rang/vitesse
// comme Anagram.
//
// Différence majeure avec les 4 autres jeux : le "visuel" de la manche est
// un SON, pas une image — les embeds Discord ne savent pas jouer d'audio
// (pas d'équivalent du champ `image`). Le seul moyen fiable d'obtenir un
// lecteur audio natif et rejouable à volonté dans Discord est une PIÈCE
// JOINTE de message (upload multipart), voir postBlindRoyale ci-dessous —
// même pattern FormData/Blob que sendDiscordWebhookFile
// (api/discord/interactions.js), mais ciblant l'endpoint de création de
// message par bot token plutôt qu'un webhook d'interaction.
// ============================================================

import fs from "fs/promises";
import path from "path";
import {
  loadBlindRoyaleCards,
  resolveBlindRoyaleEntry,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
  hintUsedFor,
  markSolved,
  archiveSolve,
  computeGameRanking,
  computeArrivalOrder,
  findRank,
  computeSeasonRanking,
  listGamePlayersInProgress,
  getPlayerSeasonResults,
  getSeasonManches,
  hasPlayerInteracted,
  getSeasonMancheNumber,
  getBlindRoyaleAnswer,
  previewSeasonManche,
  computeSeasonMancheTotal,
  getCardImageUrl,
  findTiedRank,
  alreadyPostedThisWeek,
  SOUNDS_DIR,
  ILLUSTRATION_PATH,
} from "../../../backend/services/blindroyale.js";
import { toPublicSeasonId } from "../../../backend/services/dateUtils.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const BLINDROYALE_COLOR = 0x1abc9c;
// Nom générique de la pièce jointe — ne doit JAMAIS reprendre entry.sound
// (ex. "archer-queen.mp3"), qui spoilerait la réponse dans le nom de fichier
// affiché par Discord sous le lecteur audio.
const ATTACHMENT_FILENAME = "carte-mystere.mp3";
const ILLUSTRATION_FILENAME = "blindroyale.webp";
const RARITY_LABELS = {
  common: "Commune",
  rare: "Rare",
  epic: "Épique",
  legendary: "Légendaire",
  champion: "Champion",
};

// Remplace le pseudo figé de chaque entrée par le pseudo Discord actuel —
// voir le commentaire équivalent dans anagrams.js/zoom.js.
async function resolveRankingPseudos(ranking) {
  return Promise.all(
    ranking.map(async (entry) => ({
      ...entry,
      pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
    })),
  );
}

// ── Embed / composants du post ────────────────────────────────

function buildBlindRoyaleEmbed({ seasonId, seasonManche, seasonMancheTotal }) {
  return {
    title: "🎧 Le jeu du lundi : Blind Royale !",
    description:
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      "Un son de carte Clash Royale mystère est joint à ce message ⬇️ — écoute-le autant de fois que tu veux, puis devine de quelle carte il s'agit !\n\n" +
      "**Barème**\n" +
      "- Réponse exacte du 1er coup sans indice : **10 pts**\n" +
      "- Chaque tentative incorrecte : **-2 pts**\n" +
      "- Indice «Rareté» utilisé : **-3 pts**\n\n" +
      "Le classement de la saison est mis à jour après chaque manche, et un MP te sera envoyé pour récapituler tes points et ton classement.\n\n" +
      "**Merci de ne pas spoiler ni tricher, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifie tes scores avec la commande `/blindroyale`",
    color: BLINDROYALE_COLOR,
    image: { url: `attachment://${ILLUSTRATION_FILENAME}` },
    footer: {
      text: "Nouvelle manche : lundi prochain !",
    },
  };
}

function buildBlindRoyaleComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "💡 Indice : rareté", custom_id: `blindroyale_hint:${gameId}` },
        { type: 2, style: 1, label: "🔊 Répondre", custom_id: `blindroyale_answer:${gameId}` },
      ],
    },
  ];
}

export function buildAnswerModal(gameId) {
  return {
    custom_id: `blindroyale_answer_modal:${gameId}`,
    title: "Quelle est cette carte ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "blindroyale_answer_input",
            style: 1,
            label: "Ta réponse",
            placeholder: "Nom de la carte...",
            required: true,
            max_length: 60,
          },
        ],
      },
    ],
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Structure identique à zoom.js/anagrams.js (top 20, scores à 0 exclus,
// médailles avec gestion des ex-aequo).

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
      return `${label} ${entry.pseudo} — ${entry.totalScore} pts`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(`... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`);
  }
  if (manchesPlayed?.length > 0) {
    lines.push("", "**Manches de la saison :**", ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`));
  }
  lines.push("", `Bravo à tous ! Rendez-vous juste après pour le lancement de la Saison ${toPublicSeasonId(newSeasonId)}.`);

  return {
    title: `🏆 Fin de la Saison ${toPublicSeasonId(endedSeasonId)} « Blind Royale » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: BLINDROYALE_COLOR,
  };
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getBlindRoyaleAnswer(gameId),
    })),
  );
  return manches.filter((m) => m.seasonManche != null && m.label != null).sort((a, b) => a.seasonManche - b.seasonManche);
}

async function postSeasonRecap(channelId, endedSeasonId, newSeasonId, { noPing = false } = {}) {
  const token = process.env.DISCORD_TOKEN;
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return;

  const resolvedRanking = await resolveRankingPseudos(seasonRanking);
  const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
  const embed = buildSeasonRecapEmbed(resolvedRanking, endedSeasonId, newSeasonId, manchesPlayed);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

// ── Envoi d'un message de salon avec pièces jointes (bot token) ────
// Équivalent de sendDiscordWebhookFile (api/discord/interactions.js), mais
// pour POST /channels/{id}/messages avec Authorization: Bot — jamais utilisé
// ailleurs dans le repo pour un post de salon planifié, donc pas de helper
// partagé existant à réutiliser.
//
// `files` : [{ buffer, filename, contentType }, ...]. Le tableau
// `attachments` (id ↔ filename) est nécessaire dès que l'embed référence
// `attachment://<filename>` (ici l'illustration) — même pattern que
// sendDiscordWebhookFile pour `files[0]`.
async function postChannelMessageWithFiles(channelId, token, payload, files) {
  const form = new FormData();
  const attachments = files.map((f, i) => ({ id: i, filename: f.filename }));
  form.append("payload_json", JSON.stringify({ ...payload, attachments }));
  files.forEach((f, i) => {
    const blob = new Blob([f.buffer], { type: f.contentType || "application/octet-stream" });
    form.append(`files[${i}]`, blob, f.filename);
  });
  return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });
}

// ── Publication (appelée uniquement par scripts/postBlindRoyale.js) ──
// Un seul créneau hebdomadaire (comme Zoom) : pas de logique de tirage par
// créneau (réservée à Anagram, qui en a 2 par semaine).

export async function postBlindRoyale(channelId, { dryRun = false, noPing = false, force = false } = {}) {
  if (dryRun) {
    const cards = await loadBlindRoyaleCards();
    const state = await readState();
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildBlindRoyaleEmbed({ seasonId, seasonManche, seasonMancheTotal });
    // La prochaine carte secrète n'est jamais calculée/révélée en dry-run :
    // la sélection (loadPlayOrder, dans blindroyale.js) peut compléter
    // l'ordre de rotation persisté en Redis si de nouvelles cartes ont été
    // ajoutées — un dry-run doit rester strictement en lecture seule, donc
    // ce calcul est réservé à startNewGame() (appelé uniquement en
    // publication réelle). Voir postJusteCarte, qui a le même garde-fou.
    const components = buildBlindRoyaleComponents("preview");
    const pingRoleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

    let seasonRecapEmbed = null;
    if (state?.seasonId != null && seasonId != null && state.seasonId !== seasonId) {
      const seasonRanking = await computeSeasonRanking(state.seasonId);
      if (seasonRanking.length > 0) {
        const resolvedRanking = await resolveRankingPseudos(seasonRanking);
        const manchesPlayed = await getSeasonManchesPlayed(state.seasonId);
        seasonRecapEmbed = buildSeasonRecapEmbed(resolvedRanking, state.seasonId, seasonId, manchesPlayed);
      }
    }

    return { dryRun: true, catalogSize: cards.length, embed, components, seasonRecapEmbed, pingRoleId };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const newSeasonId = await getCurrentSeasonId();
  if (previousState?.seasonId != null && newSeasonId != null && previousState.seasonId !== newSeasonId) {
    await postSeasonRecap(channelId, previousState.seasonId, newSeasonId, { noPing });
  }

  const { state, entry } = await startNewGame(channelId);
  const embed = buildBlindRoyaleEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
  });
  const components = buildBlindRoyaleComponents(state.gameId);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const [soundBuffer, illustrationBuffer] = await Promise.all([
    fs.readFile(path.join(SOUNDS_DIR, entry.sound)),
    fs.readFile(ILLUSTRATION_PATH),
  ]);
  const payload = { embeds: [embed], components, ...buildRolePingFields(roleId) };
  const res = await postChannelMessageWithFiles(channelId, token, payload, [
    { buffer: soundBuffer, filename: ATTACHMENT_FILENAME, contentType: "audio/mpeg" },
    { buffer: illustrationBuffer, filename: ILLUSTRATION_FILENAME, contentType: "image/webp" },
  ]);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);

  return { state, entry, message };
}

// Reposte la manche ACTIVE (même gameId) dans un autre salon, sans faire
// avancer la partie ni toucher aux données déjà enregistrées — voir
// repostZoom/repostFrame pour le raisonnement complet.
export async function repostBlindRoyale(channelId) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const state = await readState();
  if (!state) throw new Error("Aucune partie active à reposter.");

  const cards = await loadBlindRoyaleCards();
  const entry = resolveBlindRoyaleEntry(cards, state.gameId);
  if (!entry) throw new Error("Carte de la manche active introuvable dans le pool.");

  const embed = buildBlindRoyaleEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
  });
  const components = buildBlindRoyaleComponents(state.gameId);

  const [soundBuffer, illustrationBuffer] = await Promise.all([
    fs.readFile(path.join(SOUNDS_DIR, entry.sound)),
    fs.readFile(ILLUSTRATION_PATH),
  ]);
  const res = await postChannelMessageWithFiles(channelId, token, { embeds: [embed], components }, [
    { buffer: soundBuffer, filename: ATTACHMENT_FILENAME, contentType: "audio/mpeg" },
    { buffer: illustrationBuffer, filename: ILLUSTRATION_FILENAME, contentType: "image/webp" },
  ]);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  const newState = { ...state, channelId, messageId: message.id };
  await writeState(newState);

  return { state: newState, message };
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
    console.error("[BlindRoyale] Échec PATCH réponse éphémère:", err.message);
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
    console.error("[BlindRoyale] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── Bouton "Indice : rareté" ──────────────────────────────
// Idempotent (comme zoom.js/lajustecarte.js) : la pénalité de -3 pts n'est
// appliquée qu'à la victoire (voir computeScore/markSolved), donc
// ré-afficher l'indice ne coûte jamais rien de plus.

export async function handleHintButton(webhookUrl, gameId, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const existing = await readParticipant(gameId, discordId);
    if (existing?.solved) {
      await postEphemeral(webhookUrl, "💡 Tu as déjà trouvé la carte secrète !");
      return;
    }

    const cards = await loadBlindRoyaleCards();
    const secretEntry = resolveBlindRoyaleEntry(cards, gameId);
    const { alreadyUsed } = await recordHintUsed(gameId, discordId, username);
    const suffix = alreadyUsed
      ? "_Indice déjà révélé, aucun point supplémentaire déduit._"
      : "_Indice révélé (-3 pts sur le score final)._";

    await postEphemeralEmbed(webhookUrl, {
      title: "💡 Indice : rareté",
      description: `La carte secrète est **${RARITY_LABELS[secretEntry.rarity] ?? secretEntry.rarity}**.\n\n${suffix}`,
      color: BLINDROYALE_COLOR,
    });
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────

function ordinal(n) {
  return `${n}${n === 1 ? "ᵉʳ" : "ᵉ"}`;
}

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, reponse, score, gameRank, seasonScore, hintUsed }) {
  return [
    `**Blind Royale : Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🎧 **${reponse}** — tu es le ${ordinal(gameRank)} à avoir trouvé !`,
    `Score de cette manche : **${score} pts**${hintUsed ? " _(indice rareté utilisé : -3 pts)_" : ""}`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendBlindRoyaleDM(discordId, text) {
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
    console.error("[BlindRoyale] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la modal (réponse du joueur) ──────────────────

export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const existing = await readParticipant(gameId, discordId);
    if (existing?.solved) {
      await postEphemeral(webhookUrl, "Tu as déjà trouvé la réponse !");
      return;
    }

    const cards = await loadBlindRoyaleCards();
    const entry = resolveBlindRoyaleEntry(cards, gameId);
    const correct = checkAnswer(entry, rawAnswer);

    if (!correct) {
      await recordAttempt(gameId, discordId, username, false);
      await postEphemeral(webhookUrl, "❌ Mauvaise réponse ! (-2 pts). Réessaie avec le bouton Répondre.");
      return;
    }

    const hintUsed = await hintUsedFor(gameId, discordId);
    const { participant, score } = await markSolved(gameId, discordId, username);
    await archiveSolve(state, entry, discordId, username, score, participant.solvedAt);

    const [arrivalOrder, seasonRanking] = await Promise.all([
      computeArrivalOrder(gameId),
      computeSeasonRanking(state.seasonId),
    ]);
    const gameRank = findRank(arrivalOrder, discordId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);
    const imageUrl = await getCardImageUrl(entry.cardKey);

    await postEphemeralEmbed(webhookUrl, {
      title: "🎧 Bravo !",
      description:
        `C'était bien **${entry.fr}** — tu es le ${ordinal(gameRank)} à avoir trouvé !\n` +
        `Score de cette manche : **${score} pts**${hintUsed ? " _(indice rareté utilisé : -3 pts)_" : ""}`,
      ...(imageUrl ? { image: { url: imageUrl } } : {}),
      color: BLINDROYALE_COLOR,
    });

    await sendBlindRoyaleDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        reponse: entry.fr,
        score,
        gameRank,
        seasonScore: seasonEntry?.totalScore ?? score,
        hintUsed,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /blindroyale : scores personnels du joueur ────────────────

function buildBlindRoyaleStatsEmbed({
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

  lines.push(`**Saison ${toPublicSeasonId(seasonId)} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) :**`);
  if (currentSolved) {
    lines.push("- Tu as trouvé le nom de la carte !");
    lines.push(`- Tu as marqué ${currentScore} points`);
    lines.push(`- Ton classement : ${currentRank} / ${solvedCount}`);
  } else if (currentInteracted) {
    lines.push("- Tu n'as pas encore trouvé le nom de la carte !");
    lines.push("- Tu n'as pas marqué de points");
  } else {
    lines.push("- Tu n'as pas encore commencé cette manche");
  }
  lines.push(
    `- ${solvedCount} joueur${solvedCount > 1 ? "s" : ""} (sur ${totalParticipants}) ${solvedCount > 1 ? "ont" : "a"} trouvé pour le moment, ` +
      `et ${perfectCount} joueur${perfectCount > 1 ? "s" : ""} ${perfectCount > 1 ? "ont" : "a"} 10 pts`,
  );

  for (const m of pastManches) {
    lines.push("");
    lines.push(`**Saison ${toPublicSeasonId(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`);
    if (m.played) {
      lines.push("- Tu as trouvé le nom de la carte !");
      lines.push(`- Tu as marqué ${m.score} points`);
    } else {
      lines.push("- Tu n'as pas joué cette manche");
    }
  }

  lines.push("");
  lines.push(`**Score de la saison (S${toPublicSeasonId(seasonId)}) :**`);
  lines.push(`- Tu as accumulé ${seasonTotal} points cette saison`);
  if (seasonRank != null) {
    lines.push(`- Ton classement : ${seasonRank} / ${seasonRankTotal}`);
  }

  return {
    title: `🎧  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: BLINDROYALE_COLOR,
  };
}

function buildBlindRoyaleStatsComponents() {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: "blindroyale_stats_refresh" }],
    },
  ];
}

export async function handleBlindRoyaleStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune partie Blind Royale n'a encore été lancée.");
      return;
    }

    const [participant, seasonResults, seasonManches, currentInteracted, gameRanking, inProgress, seasonRanking] = await Promise.all([
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

    const embed = buildBlindRoyaleStatsEmbed({
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

    await postEphemeralEmbed(webhookUrl, embed, buildBlindRoyaleStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
