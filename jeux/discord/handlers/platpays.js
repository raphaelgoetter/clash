// ============================================================
// platpays.js — Handlers Discord du jeu "Plat Pays" (devine le pays
// d'origine d'un plat à partir de sa photo), groupe "Coup d'œil" du vendredi
// (voir jeux/services/refonte.js). Embed, boutons, Modal, DM : même parcours
// que Frame (handlers/frames.js) ; indices = ingrédients (-1) puis continent
// (-3).
// La photo n'est servie que par /api/platpays/image (aucune URL ne trahit
// la réponse). En production, la publication passe par
// jeux/scripts/postJeuxVisuels.js (orchestrateur du groupe, qui poste aussi
// le récap de fin de saison).
// ============================================================

import {
  loadPlats,
  resolvePlat,
  getPlatLabel,
  getCurrentSeasonId,
  readState,
  writeState,
  readParticipant,
  startNewGame,
  pickNextPlatIndex,
  gameIdFor,
  checkAnswer,
  recordAttempt,
  recordHintUsed,
  markSolved,
  archiveSolve,
  computeSeasonRanking,
  getSeasonManches,
  getSeasonMancheNumber,
  previewSeasonManche,
  computeSeasonMancheTotal,
  findTiedRank,
  alreadyPostedThisWeek,
  HINT_COSTS,
  HINT_FIELDS,
  WRONG_ANSWER_COST,
  paysAffiche,
} from "../../services/platpays.js";
import { nomSaison } from "../../services/saison.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const PLATPAYS_COLOR = 0x27ae60;

const HINT_LABELS = {
  indice1: "Ingrédients",
  indice2: "Continent",
};

function formatCost(cost) {
  return `-${cost} pt${cost > 1 ? "s" : ""}`;
}

// ── Embed / composants du post ────────────────────────────────

function buildPlatEmbed({ entry, gameId, seasonId, seasonManche, seasonMancheTotal, cacheBust }) {
  return {
    title: "🍽️ Le jeu du vendredi : Plat Pays !",
    description: [
      `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
      "",
      "De quel pays vient ce plat ?",
      "",
      "**Barème**",
      "- Réponse exacte du 1er coup sans indice : **10 pts**",
      `- Chaque tentative incorrecte : **${formatCost(WRONG_ANSWER_COST)}**`,
      `- Indice 1 (ingrédients) : **${formatCost(HINT_COSTS.indice1)}**`,
      `- Indice 2 (continent) : **${formatCost(HINT_COSTS.indice2)}**`,
      "",
      "**Merci de ne pas spoiler, sinon c'est pas drôle !**",
    ].join("\n"),
    // gameId= épingle la photo de CETTE manche (anti-spoiler côté route) ;
    // cache-buster (?v=) : Discord met en cache l'aperçu par URL, échecs compris.
    image: { url: `${TRUST_ROYALE_URL}/api/platpays/image?gameId=${gameId}&v=${cacheBust}` },
    color: PLATPAYS_COLOR,
    // Licence seule : le nom de l'auteur (écriture, langue) pourrait trahir le
    // pays ; il est cité à la résolution (voir creditLine).
    footer: { text: `Photo : Wikimedia Commons (${entry.credit.licence}) · Nouvelle manche : vendredi prochain !` },
  };
}

// Crédit complet de la photo (auteur, licence, page Commons), affiché une
// fois la réponse trouvée.
function creditLine(entry) {
  return `-# Photo : ${entry.credit.auteur}, ${entry.credit.licence} (<${entry.credit.source}>)`;
}

function buildPlatComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "💡 Indice 1 (ingrédients)", custom_id: `platpays_hint1:${gameId}` },
        { type: 2, style: 2, label: "🌍 Indice 2 (continent)", custom_id: `platpays_hint2:${gameId}` },
        { type: 2, style: 1, label: "📝 Répondre", custom_id: `platpays_answer:${gameId}` },
      ],
    },
  ];
}

// Seule une Modal (type 9) permet un champ libre en réponse à un clic.
export function buildAnswerModal(gameId) {
  return {
    custom_id: `platpays_answer_modal:${gameId}`,
    title: "De quel pays vient ce plat ?",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "platpays_answer_input",
            style: 1,
            label: "Ta réponse",
            placeholder: "Nom du pays",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Posté uniquement par l'orchestrateur du groupe (jeux/scripts/
// postJeuxVisuels.js) : sous l'alternance, lui seul sait quand récapituler
// la bonne saison.

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
      return `${label} ${entry.pseudo} (${entry.totalScore} pts)`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(`... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`);
  }
  if (manchesPlayed?.length > 0) {
    lines.push("", "**Manches de la saison :**", ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`));
  }
  lines.push("", `Bravo à tous ! Rendez-vous juste après pour le lancement de la ${nomSaison(newSeasonId)}.`);

  return {
    title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « Plat Pays » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: PLATPAYS_COLOR,
  };
}

async function getSeasonManchesPlayed(seasonId) {
  const gameIds = await getSeasonManches(seasonId);
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: await getPlatLabel(gameId),
    })),
  );
  return manches.filter((m) => m.seasonManche != null && m.label != null).sort((a, b) => a.seasonManche - b.seasonManche);
}

export async function postSeasonRecap(channelId, endedSeasonId, newSeasonId, { noPing = false } = {}) {
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

  const resolvedRanking = await Promise.all(
    seasonRanking.map(async (entry) => ({ ...entry, pseudo: await resolveDisplayName(entry.discordId, entry.pseudo) })),
  );
  const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
  const embed = buildSeasonRecapEmbed(resolvedRanking, endedSeasonId, newSeasonId, manchesPlayed);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

// ── Publication d'une manche ────────────────────────────────────
// `force` ignore le garde-fou anti-double-post — rattrapage manuel
// uniquement. `skipSeasonRecap` : accepté pour l'homogénéité avec
// l'orchestrateur, ignoré (pas de logique de récap interne).
export async function postPlatPays(channelId, { dryRun = false, noPing = false, force = false, skipSeasonRecap = false } = {}) {
  void skipSeasonRecap;

  if (dryRun) {
    const catalogue = await loadPlats();
    const entry = catalogue[pickNextPlatIndex(await readState(), catalogue)];
    const gameId = gameIdFor(entry);
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const embed = buildPlatEmbed({
      entry,
      gameId,
      seasonId,
      seasonManche,
      seasonMancheTotal: computeSeasonMancheTotal(seasonManche),
      cacheBust: Date.now(),
    });
    const pingRoleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return { dryRun: true, entry, embed, components: buildPlatComponents(gameId), pingRoleId };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const previousState = await readState();
  const { state, entry } = await startNewGame(channelId);
  const embed = buildPlatEmbed({
    entry,
    gameId: state.gameId,
    seasonId: state.seasonId,
    seasonManche: state.seasonManche,
    seasonMancheTotal: state.seasonMancheTotal,
    cacheBust: Date.now(),
  });
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components: buildPlatComponents(state.gameId), ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  state.messageId = message.id;
  await writeState(state);
  await deletePreviousRoundMessage(previousState, "Plat Pays");

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
    console.error("[Plat Pays] Échec PATCH réponse éphémère:", err.message);
  }
}

// ── Boutons indice (ingrédients, continent) ─────────────────

export async function handleHintButton(webhookUrl, gameId, hintKey, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }
    const entry = await resolvePlat(gameId);
    const hintText = `💡 **${HINT_LABELS[hintKey] || hintKey}** : ${entry[HINT_FIELDS[hintKey]]}`;

    // Score déjà figé : l'indice ne coûte plus rien, le message le dit.
    if ((await readParticipant(gameId, discordId))?.solved) {
      await postEphemeral(webhookUrl, `${hintText}\n_Tu as déjà trouvé, cet indice ne change plus ton score._`);
      return;
    }

    const { alreadyUsed } = await recordHintUsed(gameId, discordId, username, hintKey);
    const suffix = alreadyUsed ? "_Indice déjà révélé._" : `_Indice révélé (${formatCost(HINT_COSTS[hintKey])})._`;
    await postEphemeral(webhookUrl, `${hintText}\n${suffix}`);
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── DM de fin de manche ──────────────────────────────────────

function buildDmText({ seasonId, seasonManche, seasonMancheTotal, plat, pays, score, seasonScore, credit }) {
  return [
    `**Plat Pays : ${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**`,
    "",
    `🍽️ **${pays}**, bien trouvé ! (le plat : ${plat})`,
    `Score de cette manche : **${score} pts**`,
    `Score total de la saison : **${seasonScore} pts**`,
    "",
    credit,
  ].join("\n");
}

async function sendPlatPaysDM(discordId, text) {
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
    console.error("[Plat Pays] Échec envoi DM:", err.message);
    return false;
  }
}

// ── Soumission de la Modal (réponse du joueur) ──────────────────

export async function handleModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée.");
      return;
    }

    if ((await readParticipant(gameId, discordId))?.solved) {
      await postEphemeral(webhookUrl, "Tu as déjà trouvé la réponse !");
      return;
    }

    const entry = await resolvePlat(gameId);
    if (!checkAnswer(entry, rawAnswer)) {
      await recordAttempt(gameId, discordId, username);
      await postEphemeral(webhookUrl, `❌ Mauvaise réponse ! (${formatCost(WRONG_ANSWER_COST)}). Réessaye avec le bouton Répondre.`);
      return;
    }

    const { participant, score } = await markSolved(gameId, discordId, username);
    await archiveSolve(state, entry, discordId, username, score, participant.solvedAt);

    const seasonRanking = await computeSeasonRanking(state.seasonId);
    const seasonEntry = seasonRanking.find((e) => e.discordId === discordId);

    await postEphemeral(webhookUrl, `🎉 Bravo, c'était bien **${paysAffiche(entry)}** ! (le plat : ${entry.plat})\n${creditLine(entry)}`);

    await sendPlatPaysDM(
      discordId,
      buildDmText({
        seasonId: state.seasonId,
        seasonManche: state.seasonManche,
        seasonMancheTotal: state.seasonMancheTotal,
        plat: entry.plat,
        pays: paysAffiche(entry),
        score,
        seasonScore: seasonEntry?.totalScore ?? score,
        credit: creditLine(entry),
      }),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
