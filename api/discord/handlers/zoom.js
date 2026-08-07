// ============================================================
// zoom.js — Handlers Discord pour le jeu "Zoom carte" (devine 2 cartes à
// partir d'un zoom extrême sur leurs icônes). Embed, boutons, modal, DM.
// La publication d'une partie passe uniquement par scripts/postZoom.js —
// seule la commande /zoom (scores personnels du joueur qui l'exécute) est
// une vraie commande slash. Miroir structurel de
// api/discord/handlers/frames.js, adapté pour 2 slots indépendants (voir
// backend/services/zoom.js).
// ============================================================

import {
  loadZoomCatalog,
  resolveZoomPair,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextZoomPair,
  checkAnswer,
  recordSlotAttempt,
  recordSlotHintUsed,
  markSlotSolved,
  archiveSlotSolve,
  computeGameRanking,
  computeFullSolveArrivalOrder,
  computeSeasonRanking,
  listGamePlayersInProgress,
  getPlayerSeasonResults,
  getSeasonManches,
  getSeasonMancheNumber,
  getZoomRoundLabel,
  previewSeasonManche,
  computeSeasonMancheTotal,
  findRank,
  findTiedRank,
} from "../../../backend/services/zoom.js";
import { toPublicSeasonId } from "../../../backend/services/dateUtils.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const ZOOM_COLOR = 0xe67e22;
const SLOT_LABELS = { A: "gauche", B: "droite" };

// Remplace le pseudo figé de chaque entrée par le pseudo Discord actuel —
// voir le commentaire équivalent dans frames.js.
async function resolveRankingPseudos(ranking) {
  return Promise.all(
    ranking.map(async (entry) => ({
      ...entry,
      pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
    })),
  );
}

// ── Embed / composants du post ────────────────────────────────

function buildZoomEmbed({ seasonId, seasonManche, seasonMancheTotal, gameId, cacheBust }) {
  return {
    title: "🔍 Le jeu du vendredi : Zoom carte !",
    description:
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      "Deux cartes zoomées à l'extrême. Devine leurs noms !\n\n" +
      "Clique sur «Répondre» pour soumettre tes réponses, ou prends un indice sur une carte pour la dézoomer.\n\n" +
      "**Barème (par carte)**\n" +
      "- Réponse exacte du 1er coup sans indice : **10 pts**\n" +
      "- Chaque tentative incorrecte : **-2 pts**\n" +
      "- Indice utilisé : **-3 pts**\n\n" +
      "Pas besoin de trouver les 2 cartes pour marquer des points : chacune compte séparément.\n\n" +
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifie tes scores avec la commande `/zoom`",
    // gameId= épingle l'image de CETTE manche précise (voir le même
    // raisonnement détaillé dans frames.js — getFrameImageByGameId).
    image: {
      url: `${TRUST_ROYALE_URL}/api/zoom/image?gameId=${gameId}&v=${cacheBust}`,
    },
    color: ZOOM_COLOR,
    footer: {
      text: "Nouvelle manche : vendredi prochain. Bonne chance tout le monde !",
    },
  };
}

function buildZoomComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "🔍 Indice carte gauche", custom_id: `zoom_hintA:${gameId}` },
        { type: 2, style: 2, label: "🔍 Indice carte droite", custom_id: `zoom_hintB:${gameId}` },
        { type: 2, style: 1, label: "📝 Répondre", custom_id: `zoom_answer:${gameId}` },
      ],
    },
  ];
}

// Modal à 2 champs. Un slot déjà résolu par CE joueur est pré-rempli et
// rendu facultatif, pour permettre de re-cliquer "Répondre" et ne compléter
// que le slot manquant sans revalider celui déjà trouvé.
export function buildAnswerModal(gameId, participant) {
  const solvedA = !!participant?.slots?.A?.solved;
  const solvedB = !!participant?.slots?.B?.solved;
  return {
    custom_id: `zoom_answer_modal:${gameId}`,
    title: "Quelles sont ces cartes ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "zoom_answer_left",
            style: 1,
            label: "Carte de gauche",
            placeholder: "Nom de la carte...",
            required: !solvedA,
            value: solvedA ? "✅ déjà trouvé" : "",
            max_length: 60,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "zoom_answer_right",
            style: 1,
            label: "Carte de droite",
            placeholder: "Nom de la carte...",
            required: !solvedB,
            value: solvedB ? "✅ déjà trouvé" : "",
            max_length: 60,
          },
        ],
      },
    ],
  };
}

// Lit l'état du joueur avant de construire la modal (pour le pré-remplissage
// des slots déjà résolus) — repli sur une modal "tout requis, sans
// pré-remplissage" si la lecture Redis échoue, pour ne jamais bloquer
// l'ouverture de la modal (contrainte des 3 secondes de Discord).
export async function buildAnswerModalForPlayer(gameId, discordId) {
  let participant = null;
  try {
    participant = await readParticipant(gameId, discordId);
  } catch (err) {
    console.error("[Zoom] Lecture participant échouée avant ouverture modal:", err.message);
  }
  return buildAnswerModal(gameId, participant);
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Structure identique à frames.js (mêmes règles : top 20, scores à 0 exclus,
// médailles avec gestion des ex-aequo).

const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

function buildSeasonRecapEmbed(seasonRanking, endedSeasonId, newSeasonId, manchesPlayed) {
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
  if (manchesPlayed?.length > 0) {
    lines.push("", "**Manches de la saison :**", ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`));
  }
  lines.push("", `Bravo à tous ! Rendez-vous juste après pour le lancement de la Saison ${toPublicSeasonId(newSeasonId)}.`);

  return {
    title: `🏆 Fin de la Saison ${toPublicSeasonId(endedSeasonId)} !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à « Zoom carte » cette saison !\n\n` +
      lines.join("\n"),
    color: ZOOM_COLOR,
  };
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getZoomRoundLabel(gameId),
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

// ── Publication (appelée uniquement par scripts/postZoom.js) ──

export async function postZoom(channelId, { dryRun = false, noPing = false } = {}) {
  if (dryRun) {
    const catalog = await loadZoomCatalog();
    const state = await readState();
    const { idxA, idxB } = pickNextZoomPair(state, catalog);
    const entryA = catalog[idxA];
    const entryB = catalog[idxB];
    const gameId = `${entryA.id}__${entryB.id}`;
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildZoomEmbed({ seasonId, seasonManche, seasonMancheTotal, gameId, cacheBust: Date.now() });
    const components = buildZoomComponents(gameId);
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

    return { dryRun: true, entryA, entryB, embed, components, seasonRecapEmbed, pingRoleId };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const newSeasonId = await getCurrentSeasonId();
  if (previousState?.seasonId != null && newSeasonId != null && previousState.seasonId !== newSeasonId) {
    await postSeasonRecap(channelId, previousState.seasonId, newSeasonId, { noPing });
  }

  const { state, entryA, entryB } = await startNewGame(channelId);
  const embed = buildZoomEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    gameId: state.gameId,
    cacheBust: Date.now(),
  });
  const components = buildZoomComponents(state.gameId);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);

  return { state, entryA, entryB, message };
}

// Reposte la manche ACTIVE dans un autre salon, sans faire avancer la partie
// ni toucher aux données déjà enregistrées — voir repostFrame dans
// frames.js pour le raisonnement complet.
export async function repostZoom(channelId) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const state = await readState();
  if (!state) throw new Error("Aucune partie active à reposter.");

  const embed = buildZoomEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    gameId: state.gameId,
    cacheBust: Date.now(),
  });
  const components = buildZoomComponents(state.gameId);

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
    console.error("[Zoom] Échec PATCH réponse éphémère:", err.message);
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
    console.error("[Zoom] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── Boutons indice ────────────────────────────────────────────
// Contrairement à Frame (indice textuel), l'indice ici est une IMAGE — le
// message public partagé par tout le salon ne peut pas être modifié par un
// clic individuel, la réponse est donc un embed éphémère avec le crop
// dézoomé de CE seul slot (jamais un PATCH du message d'origine).

export async function handleHintButton(webhookUrl, gameId, slot, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const label = SLOT_LABELS[slot] || slot;
    const existing = await readParticipant(gameId, discordId);
    if (existing?.slots?.[slot]?.solved) {
      await postEphemeral(webhookUrl, `🔍 Tu as déjà trouvé la carte de ${label} !`);
      return;
    }

    const { alreadyUsed } = await recordSlotHintUsed(gameId, discordId, slot, username);
    const suffix = alreadyUsed ? "_Indice déjà révélé._" : "_Indice révélé (-3 pts)._";

    await postEphemeralEmbed(webhookUrl, {
      description: `🔍 **Carte de ${label}** — un peu moins zoomée...\n${suffix}`,
      image: { url: `${TRUST_ROYALE_URL}/api/zoom/image?gameId=${gameId}&slot=${slot}&v=${Date.now()}` },
      color: ZOOM_COLOR,
    });
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────
// Envoyé uniquement quand les 2 slots sont résolus (voir justCompleted dans
// handleModalSubmit) — une résolution partielle n'a pas de DM dédié, la
// confirmation éphémère suffit.

function ordinal(n) {
  return `${n}${n === 1 ? "ᵉʳ" : "ᵉ"}`;
}

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, answerA, answerB, totalScore, gameRank, seasonScore }) {
  return [
    `**Zoom carte : Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🔍 **${answerA}** & **${answerB}** — tu es le ${ordinal(gameRank)} à avoir tout trouvé !`,
    `Score de cette manche : **${totalScore} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendZoomDM(discordId, text) {
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
    console.error("[Zoom] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la modal (réponses du joueur) ──────────────────
// Chaque slot est résolu indépendamment : une réponse correcte sur un slot
// ne dépend pas de l'autre, et un joueur peut soumettre la modal plusieurs
// fois pour compléter le slot qu'il n'avait pas encore trouvé.

export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawLeft, rawRight) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    const catalog = await loadZoomCatalog();
    const { entryA, entryB } = resolveZoomPair(catalog, gameId);
    const existing = await readParticipant(gameId, discordId);

    const lines = [];
    let completion = null;

    for (const [slot, entry, raw] of [
      ["A", entryA, rawLeft],
      ["B", entryB, rawRight],
    ]) {
      const label = SLOT_LABELS[slot];
      if (existing?.slots?.[slot]?.solved) {
        lines.push(`✅ Carte de ${label} : déjà trouvée (**${entry.answer}**)`);
        continue;
      }
      if (!raw?.trim()) {
        lines.push(`➖ Carte de ${label} : pas de réponse soumise`);
        continue;
      }
      if (!checkAnswer(entry, raw)) {
        await recordSlotAttempt(gameId, discordId, slot, username, false);
        lines.push(`❌ Carte de ${label} : mauvaise réponse (-2 pts)`);
        continue;
      }

      const { participant, score, justCompleted } = await markSlotSolved(gameId, discordId, slot, username);
      await archiveSlotSolve(state, entry, discordId, username, slot, score, new Date().toISOString());
      lines.push(`🎉 Carte de ${label} : **${entry.answer}** trouvée ! (+${score} pts)`);
      if (justCompleted) completion = { participant };
    }

    await postEphemeral(webhookUrl, lines.join("\n"));

    if (completion) {
      const [arrivalOrder, seasonRanking] = await Promise.all([
        computeFullSolveArrivalOrder(gameId),
        computeSeasonRanking(state.seasonId),
      ]);
      const gameRank = findRank(arrivalOrder, discordId);
      const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);

      await sendZoomDM(
        discordId,
        buildDmText({
          seasonId: state.seasonId,
          seasonManche: state.seasonManche,
          seasonMancheTotal: state.seasonMancheTotal,
          answerA: entryA.answer,
          answerB: entryB.answer,
          totalScore: completion.participant.totalScore,
          gameRank,
          seasonScore: seasonEntry?.totalScore ?? completion.participant.totalScore,
        }),
      );
    }
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /zoom : scores personnels du joueur ────────────────

function buildZoomStatsEmbed({
  pseudo,
  currentSeasonManche,
  seasonMancheTotal,
  slotsStatus,
  currentTotalScore,
  currentRank,
  solvedCount,
  totalParticipants,
  pastManches,
  seasonId,
  seasonTotal,
  seasonRank,
  seasonRankTotal,
}) {
  const lines = [];

  lines.push(`**Saison ${toPublicSeasonId(seasonId)} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) :**`);
  for (const slot of ["A", "B"]) {
    const s = slotsStatus[slot];
    lines.push(
      s.solved
        ? `- Carte de ${SLOT_LABELS[slot]} : trouvée (+${s.score} pts)`
        : `- Carte de ${SLOT_LABELS[slot]} : pas encore trouvée`,
    );
  }
  if (currentTotalScore > 0) {
    lines.push(`- Ton classement sur cette manche : ${currentRank} / ${solvedCount}`);
  }
  lines.push(
    `- ${totalParticipants} joueur${totalParticipants > 1 ? "s" : ""} ${totalParticipants > 1 ? "ont" : "a"} interagi avec cette manche, ` +
      `${solvedCount} ${solvedCount > 1 ? "ont" : "a"} marqué au moins 1 point`,
  );

  for (const m of pastManches) {
    lines.push("");
    lines.push(`**Saison ${toPublicSeasonId(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`);
    if (m.played) {
      lines.push(`- Tu as marqué ${m.totalScore} points (${m.slotsFound}/2 carte${m.slotsFound > 1 ? "s" : ""} trouvée${m.slotsFound > 1 ? "s" : ""})`);
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
    title: `🔍  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: ZOOM_COLOR,
  };
}

function buildZoomStatsComponents() {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 2, label: "🔄 Rafraîchir", custom_id: "zoom_stats_refresh" }],
    },
  ];
}

export async function handleZoomStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune partie Zoom carte n'a encore été lancée.");
      return;
    }

    const [participant, seasonResults, seasonManches, gameRanking, inProgress, seasonRanking] = await Promise.all([
      readParticipant(state.gameId, discordId),
      getPlayerSeasonResults(state.seasonId, discordId),
      getSeasonManches(state.seasonId),
      computeGameRanking(state.gameId),
      listGamePlayersInProgress(state.gameId),
      computeSeasonRanking(state.seasonId),
    ]);

    const slotsStatus = {
      A: { solved: !!participant?.slots?.A?.solved, score: participant?.slots?.A?.score ?? 0 },
      B: { solved: !!participant?.slots?.B?.solved, score: participant?.slots?.B?.score ?? 0 },
    };
    const currentTotalScore = participant?.totalScore ?? 0;
    const solvedCount = gameRanking.length;
    const totalParticipants = solvedCount + inProgress.length;
    const currentRank = currentTotalScore > 0 ? findTiedRank(gameRanking, discordId, "totalScore") : null;

    const hasSeasonRank = seasonResults.length > 0;
    const seasonRank = hasSeasonRank ? findTiedRank(seasonRanking, discordId, "totalScore") : null;
    const seasonRankTotal = seasonRanking.length;

    // Regroupe les résultats archivés (1 entrée par slot résolu) par manche —
    // voir le commentaire de getPlayerSeasonResults dans zoom.js.
    const byGameId = new Map();
    for (const r of seasonResults) {
      const acc = byGameId.get(r.gameId) ?? { totalScore: 0, slotsFound: 0 };
      acc.totalScore += r.score;
      acc.slotsFound += 1;
      byGameId.set(r.gameId, acc);
    }

    const pastGameIds = seasonManches.filter((gameId) => gameId !== state.gameId);
    const pastManches = (
      await Promise.all(
        pastGameIds.map(async (gameId) => {
          const agg = byGameId.get(gameId);
          return {
            seasonManche: await getSeasonMancheNumber(state.seasonId, gameId),
            played: !!agg,
            totalScore: agg?.totalScore ?? 0,
            slotsFound: agg?.slotsFound ?? 0,
          };
        }),
      )
    )
      .filter((m) => m.seasonManche != null)
      .sort((a, b) => b.seasonManche - a.seasonManche);

    const seasonTotal = seasonResults.reduce((sum, r) => sum + r.score, 0);

    const embed = buildZoomStatsEmbed({
      pseudo: username,
      currentSeasonManche: state.seasonManche,
      seasonMancheTotal: state.seasonMancheTotal,
      slotsStatus,
      currentTotalScore,
      currentRank,
      solvedCount,
      totalParticipants,
      pastManches,
      seasonId: state.seasonId,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(webhookUrl, embed, buildZoomStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
