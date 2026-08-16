// ============================================================
// lajustecarte.js — Handlers Discord pour le jeu "La Juste Carte" (devine la
// carte Clash Royale à partir d'indices comparatifs PV/Portée/Dégâts/Élixir).
// Embed, boutons, modal, DM. La publication d'une partie passe uniquement
// par scripts/postJusteCarte.js — seule la commande /justecarte (scores
// personnels du joueur qui l'exécute) est une vraie commande slash. Miroir
// structurel de api/discord/handlers/anagrams.js, avec un flux de réponse à
// 3 issues (nom inconnu / carte connue mais fausse / trouvée) au lieu de 2 :
// contrairement à Anagram, ce jeu accepte PLUSIEURS propositions successives
// par joueur avant résolution — chaque réponse éphémère (sauf victoire)
// inclut donc un bouton pour reproposer une carte.
//
// Pas d'autocomplete sur le nom de carte : les Modals Discord ne le
// supportent pas (limitation de la plateforme). Une commande slash avec
// option autocomplete aurait été possible mais jugée trop complexe pour le
// gain (ajout d'une commande dédiée ou fusion avec /justecarte) — décision
// explicite de rester sur le flux bouton/Modal, comme les 3 autres jeux.
// ============================================================

import {
  loadCatalog,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  resolveGuess,
  compareCard,
  recordAttempt,
  getGuessHistory,
  markSolved,
  archiveSolve,
  computeGameRanking,
  computeSeasonRanking,
  listGamePlayersInProgress,
  getPlayerSeasonResults,
  getSeasonManches,
  hasPlayerInteracted,
  getSeasonMancheNumber,
  getJusteCarteAnswer,
  previewSeasonManche,
  computeSeasonMancheTotal,
  getCardImageUrl,
  findTiedRank,
} from "../../../backend/services/lajustecarte.js";
import { toPublicSeasonId, formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const JUSTECARTE_COLOR = 0x2ecc71;
const STAT_LABELS = { hp: "PV", range: "Portée", damage: "Dégâts", elixir: "Élixir" };
const ARROW_BY_RESULT = { up: "⬆️", down: "⬇️", equal: "✅" };

// Remplace le pseudo figé de chaque entrée par le pseudo Discord actuel
// (résolution live, repli sur le pseudo stocké en cas d'échec) — voir
// discordUsers.js. Utilisé uniquement pour l'affichage.
async function resolveRankingPseudos(ranking) {
  return Promise.all(
    ranking.map(async (entry) => ({
      ...entry,
      pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
    })),
  );
}

// ── Embed / composants du post ────────────────────────────────

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Doit rester synchronisé avec le cron de .github/workflows/lajustecarte.yml
// ("0 16 * * 0") — jamais figé en dur dans le texte affiché, sous peine de
// devenir faux à chaque bascule CET/CEST (voir formatUtcTimeAsParis).
const JUSTECARTE_CRON_UTC_HOUR = 16;

function buildJusteCarteEmbed({ seasonId, seasonManche, seasonMancheTotal }) {
  return {
    title: "🃏 Le jeu du dimanche : La Juste Carte !",
    description:
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      "Une carte Clash Royale secrète est en jeu ! Propose le nom d'une carte : le jeu te dira, stat par stat, si la carte secrète est plus forte, plus faible ou identique à ta proposition. À chaque proposition, tu as droit à un indice supplémentaire.\n\n" +
      "**Barème :** tu commences avec 10 points, la 1ère proposition est gratuite. À partir de la 2e, chaque proposition coûte 1 point.\n\n" +
      "**Merci de ne pas spoiler ni tricher, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifie tes scores avec la commande `/justecarte`",
    color: JUSTECARTE_COLOR,
    image: { url: `${TRUST_ROYALE_URL}/images/banner-justecarte.webp` },
    footer: {
      text: `Nouvelle manche : dimanche prochain, ${formatUtcTimeAsParis(JUSTECARTE_CRON_UTC_HOUR)} (heure de Paris) !`,
    },
  };
}

function buildAnswerButton(gameId, label) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label,
          custom_id: `lajustecarte_answer:${gameId}`,
        },
      ],
    },
  ];
}

function buildJusteCarteComponents(gameId) {
  return buildAnswerButton(gameId, "🔎 Proposer une carte");
}

function buildRetryComponents(gameId) {
  return buildAnswerButton(gameId, "🔁 Reproposer une carte");
}

// Contenu de la Modal ouverte par le bouton — voir anagrams.js pour le
// mécanisme détaillé (réponse synchrone type:9, MODAL_SUBMIT type:5 entrant
// à ne pas confondre avec le type de réponse 5 DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).
export function buildAnswerModal(gameId) {
  return {
    custom_id: `lajustecarte_answer_modal:${gameId}`,
    title: "Propose une carte",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "lajustecarte_answer_input",
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

// ── Récapitulatif de fin de saison ──────────────────────────────
// Copie quasi identique de buildSeasonRecapEmbed dans anagrams.js (mêmes
// règles : troncage à 20 joueurs, exclusion des 0 pt, gestion des ex-aequo
// pour les médailles), libellé adapté au jeu La Juste Carte.

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
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à « La Juste Carte » cette saison !\n\n` +
      lines.join("\n"),
    color: JUSTECARTE_COLOR,
  };
}

// Liste triée (Manche 1, 2, 3...) des cartes de la saison écoulée, pour le
// récap de fin de saison — voir getJusteCarteAnswer() (backend/services/lajustecarte.js).
async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getJusteCarteAnswer(gameId),
    })),
  );
  return manches
    .filter((m) => m.seasonManche != null && m.label != null)
    .sort((a, b) => a.seasonManche - b.seasonManche);
}

async function postSeasonRecap(channelId, endedSeasonId, newSeasonId, { noPing = false } = {}) {
  const token = process.env.DISCORD_TOKEN;
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

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

// ── Publication (appelée uniquement par scripts/postJusteCarte.js) ──
// En dry-run, aucune écriture d'état ni appel Discord — la prochaine carte
// est seulement prévisualisée, sans faire avancer la partie. Contrairement
// à Anagram, pas de gating hebdomadaire applicatif (jour/tirage) : comme
// Frame et Zoom, la seule porte d'entrée est le déclenchement du cron
// GitHub Actions (dimanche 16h UTC) — voir .github/workflows/lajustecarte.yml.

export async function postJusteCarte(channelId, { dryRun = false, noPing = false } = {}) {
  if (dryRun) {
    const catalog = await loadCatalog();
    const state = await readState();
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildJusteCarteEmbed({ seasonId, seasonManche, seasonMancheTotal });
    const components = buildJusteCarteComponents("preview");
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

    // La prochaine carte secrète n'est jamais calculée/révélée en dry-run :
    // contrairement à Anagram (dont l'embed lui-même ne spoile rien), la
    // sélection de la prochaine carte (loadPlayOrder) peut compléter l'ordre
    // de rotation persisté en Redis si de nouvelles cartes ont été ajoutées
    // — un dry-run doit rester strictement en lecture seule, donc ce calcul
    // est réservé à startNewGame() (appelé uniquement en publication réelle).
    return { dryRun: true, catalogSize: catalog.length, embed, components, seasonRecapEmbed, pingRoleId };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const newSeasonId = await getCurrentSeasonId();
  if (previousState?.seasonId != null && newSeasonId != null && previousState.seasonId !== newSeasonId) {
    await postSeasonRecap(channelId, previousState.seasonId, newSeasonId, { noPing });
  }

  const { state, entry } = await startNewGame(channelId);
  const embed = buildJusteCarteEmbed({
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
  });
  const components = buildJusteCarteComponents(state.gameId);
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

  return { state, entry, message };
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
    console.error("[La Juste Carte] Échec PATCH réponse éphémère:", err.message);
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
    console.error("[La Juste Carte] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── DM à la victoire uniquement ──────────────────────────────
// Contrairement à Anagram (DM à chaque manche résolue en une tentative),
// ici un DM à chaque proposition serait intrusif vu qu'un joueur peut en
// soumettre plusieurs de suite — envoyé une seule fois, à la victoire.

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, reponse, score, attempts, seasonScore }) {
  return [
    `**La Juste Carte : Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🃏 C'était bien **${reponse}** — trouvée en ${attempts} proposition${attempts > 1 ? "s" : ""} !`,
    `Score de cette manche : **${score} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
  ].join("\n");
}

async function sendJusteCarteDM(discordId, text) {
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
    console.error("[La Juste Carte] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Formatage des indices comparatifs ──────────────────────────

function formatHistoryLine(history) {
  return history.length > 0 ? `_Tu as déjà proposé : ${history.join(", ")}_\n\n` : "";
}

function buildComparisonEmbed(guessEntry, comparison, attemptNumber, history) {
  const lines = Object.entries(comparison).map(([stat, result]) => `**${STAT_LABELS[stat]}** ${ARROW_BY_RESULT[result]}`);
  return {
    title: `❌ Ce n'est pas ${guessEntry.fr}`,
    description:
      `Proposition n°${attemptNumber} :\n\n${lines.join("\n")}\n\n` +
      "_⬆️ = ta proposition est plus élevée que la carte secrète sur cette stat, ⬇️ = plus basse, ✅ = identique._\n\n" +
      formatHistoryLine(history) +
      "Réessaie avec le bouton ci-dessous !",
    color: JUSTECARTE_COLOR,
  };
}

function buildUnknownCardEmbed(rawAnswer, history) {
  return {
    title: "🤔 Carte inconnue",
    description:
      `Je ne reconnais pas « ${rawAnswer} » — vérifie l'orthographe (le nom doit être en français) et réessaie. Cette tentative n'a pas été comptabilisée.\n\n` +
      formatHistoryLine(history),
    color: JUSTECARTE_COLOR,
  };
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
      await postEphemeral(webhookUrl, "Tu as déjà trouvé la carte secrète !");
      return;
    }

    const catalog = await loadCatalog();
    const secretEntry = catalog.find((c) => c.cardKey === state.gameId);
    const guessEntry = resolveGuess(catalog, rawAnswer);

    if (!guessEntry) {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeralEmbed(webhookUrl, buildUnknownCardEmbed(rawAnswer, history), buildRetryComponents(gameId));
      return;
    }

    const attemptNumber = await recordAttempt(gameId, discordId, username, guessEntry.fr);

    if (guessEntry.cardKey !== secretEntry.cardKey) {
      const comparison = compareCard(secretEntry, guessEntry, attemptNumber);
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeralEmbed(
        webhookUrl,
        buildComparisonEmbed(guessEntry, comparison, attemptNumber, history),
        buildRetryComponents(gameId),
      );
      return;
    }

    const { participant, score } = await markSolved(gameId, discordId, username, attemptNumber);
    await archiveSolve(state, secretEntry, discordId, username, score, participant.attempts, participant.solvedAt);

    const seasonRanking = await computeSeasonRanking(state.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);
    const imageUrl = await getCardImageUrl(secretEntry.cardKey);

    await postEphemeralEmbed(webhookUrl, {
      title: "🃏 Bravo !",
      description:
        `C'était bien **${secretEntry.fr}** — trouvée en ${participant.attempts} proposition${participant.attempts > 1 ? "s" : ""} !\n` +
        `Score de cette manche : **${score} pts**`,
      ...(imageUrl ? { image: { url: imageUrl } } : {}),
      color: JUSTECARTE_COLOR,
    });

    await sendJusteCarteDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        reponse: secretEntry.fr,
        score,
        attempts: participant.attempts,
        seasonScore: seasonEntry?.totalScore ?? score,
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /justecarte : scores personnels du joueur ────────────────

function buildJusteCarteStatsEmbed({
  pseudo,
  currentSeasonManche,
  seasonMancheTotal,
  currentSolved,
  currentInteracted,
  currentAttempts,
  currentScore,
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
  if (currentSolved) {
    lines.push(`- Tu as trouvé la carte secrète en ${currentAttempts} proposition${currentAttempts > 1 ? "s" : ""} !`);
    lines.push(`- Tu as marqué ${currentScore} points`);
  } else if (currentInteracted) {
    lines.push(`- Tu n'as pas encore trouvé la carte secrète (${currentAttempts} proposition${currentAttempts > 1 ? "s" : ""} pour le moment)`);
  } else {
    lines.push("- Tu n'as pas encore commencé cette manche");
  }
  lines.push(`- ${solvedCount} joueur${solvedCount > 1 ? "s" : ""} (sur ${totalParticipants}) ${solvedCount > 1 ? "ont" : "a"} trouvé pour le moment`);

  for (const m of pastManches) {
    lines.push("");
    lines.push(`**Saison ${toPublicSeasonId(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`);
    if (m.played) {
      lines.push(`- Tu as trouvé la carte secrète en ${m.attempts} proposition${m.attempts > 1 ? "s" : ""} !`);
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
    title: `🃏  Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: JUSTECARTE_COLOR,
  };
}

function buildJusteCarteStatsComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "🔄 Rafraîchir",
          custom_id: "lajustecarte_stats_refresh",
        },
      ],
    },
  ];
}

export async function handleJusteCarteStatsCommand(webhookUrl, discordId, username) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(webhookUrl, "⚠️ Aucune partie La Juste Carte n'a encore été lancée.");
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
    const currentAttempts = participant?.attempts ?? 0;
    const solvedCount = gameRanking.length;
    const totalParticipants = solvedCount + inProgress.length;

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
            attempts: result?.attempts ?? 0,
          };
        }),
      )
    )
      .filter((m) => m.seasonManche != null)
      .sort((a, b) => b.seasonManche - a.seasonManche);

    const seasonTotal = seasonResults.reduce((sum, r) => sum + r.score, 0);

    const embed = buildJusteCarteStatsEmbed({
      pseudo: username,
      currentSeasonManche,
      seasonMancheTotal,
      currentSolved,
      currentInteracted,
      currentAttempts,
      currentScore,
      solvedCount,
      totalParticipants,
      pastManches,
      seasonId: state.seasonId,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(webhookUrl, embed, buildJusteCarteStatsComponents());
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
