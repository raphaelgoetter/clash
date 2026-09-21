// ============================================================
// pelemele.js — Handlers Discord pour le jeu "Pêle-mêle"
// (DRAW_SIZE lettres tirées, proposer le nom de carte Clash Royale le plus
// long qu'on peut former avec). Embed, bouton, modal. Miroir structurel de
// api/discord/_handlers/lajustecarte.js, avec deux différences (voir
// backend/services/pelemele.js pour le détail complet) :
// - pas de "carte secrète" : n'importe quelle carte du pool qui rentre dans
//   le tirage est une réponse valide, il n'y a donc pas de notion de
//   victoire qui termine la manche ;
// - un joueur peut reproposer autant de fois qu'il veut ; TOUS ses mots
//   distincts trouvés comptent (barème : LONGEST_WORD_BONUS pour le(s) mot(s)
//   le(s) plus long(s) possible(s) du tirage, EXTRA_WORD_POINTS pour chaque
//   autre — voir pelemele.js), pas juste le meilleur — le bouton
//   "Proposer un mot" reste donc identique après chaque tentative (pas de
//   bouton "Reproposer" séparé comme La Juste Carte).
//
// Production (2026-09) : alterne avec Anagram, une saison Clash Royale sur
// deux, sous le nom collectif "Jeux de lettres" — voir
// backend/services/jeuxdelettres.js. En production, la publication passe
// UNIQUEMENT par scripts/postJeuxDeLettres.js (qui décide quel jeu est actif
// et gère le récap de fin de saison du jeu qui vient de se terminer, quel
// qu'il soit) ; scripts/postPeleMele.js reste utilisable pour forcer un post
// direct de CE jeu précis (test, rattrapage manuel).
// ============================================================

import {
  DRAW_SIZE,
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
  readParticipant,
  getPlayerSeasonResults,
  getSeasonManches,
  getSeasonMancheNumber,
  computeGameRanking,
  listGamePlayersInProgress,
  computeSeasonRanking,
  getAllArchivedResults,
  findTiedRank,
} from "../../../backend/services/pelemele.js";
import { toPublicSeasonId } from "../../../backend/services/dateUtils.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const PELEMELE_COLOR = 0x9b59b6;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// L'image (chevalet de tuiles, voir pelemeleImage.js) n'existe que pour
// une manche RÉELLEMENT démarrée (gameId != null) — en dry-run/preview,
// aucun tirage n'a encore été généré (voir postPeleMele), donc pas
// d'image à référencer.
function buildPeleMeleEmbed({
  seasonId,
  seasonManche,
  seasonMancheTotal,
  gameId,
  totalValidWords,
}) {
  return {
    title: "🔤 Le jeu du samedi : Pêle-mêle !",
    description:
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      `Plusieurs cartes Clash Royale se cachent derrière ces ${DRAW_SIZE} lettres. Sauras-tu toutes les retrouver ?\n\n` +
      "🏆 **1 point** par carte trouvée, **5 points** s'il s'agit du mot le plus long.\n" +
      "♾️ Tu as autant d'essais que tu veux !\n\n" +
      (totalValidWords != null
        ? `🎯 **${totalValidWords} carte${totalValidWords > 1 ? "s" : ""} valide${totalValidWords > 1 ? "s" : ""} sur ce tirage** — à toi de toutes les trouver !\n\n`
        : "") +
      "📜 Détails (orthographe, accents, ponctuation...) dans le bouton **Règles**.\n\n" +
      "**Merci de ne pas spoiler ni tricher, sinon c'est pas drôle !**\n\n" +
      "🤖 Vérifie tes scores avec la commande `/pelemele`",
    color: PELEMELE_COLOR,
    // Cache-buster (?v=) — même pattern que frames.js/zoom.js/lajustecarte.js :
    // Discord met en cache l'aperçu d'un embed PAR URL.
    ...(gameId
      ? {
          image: {
            url: `${TRUST_ROYALE_URL}/api/pelemele/image?gameId=${gameId}&v=${Date.now()}`,
          },
        }
      : {}),
    footer: {
      text: "Nouvelle manche : samedi prochain, à une heure surprise !",
    },
  };
}

// Contenu statique (aucune dépendance à l'état d'une manche précise) — sert
// à la fois au bouton "Règles" sur le post et pourrait resservir ailleurs
// (ex. une future commande /pelemele) sans dupliquer le texte.
export function buildRulesEmbed() {
  return {
    title: "📜 Règles de Pêle-mêle",
    description:
      `${DRAW_SIZE} lettres sont tirées au sort à chaque manche. Propose le nom d'une carte Clash Royale que tu peux former avec ces lettres — autant de fois que tu veux, aucune limite d'essais.\n\n` +
      "**Barème**\n" +
      "🏆 **5 points** pour la (ou les) carte(s) la (les) plus longue(s) possible sur ce tirage.\n" +
      "✨ **+1 point** pour chaque autre carte valide trouvée.\n" +
      "Reproposer une carte déjà trouvée ne rapporte rien — seules les cartes **distinctes** comptent.\n\n" +
      "**Orthographe**\n" +
      "• Les accents ne sont pas obligatoires (é/e, à/a… acceptés indifféremment).\n" +
      "• La casse n'a pas d'importance (majuscules/minuscules).\n" +
      "• Les points et autre ponctuation dans un nom de carte sont ignorés : **P.E.K.K.A** s'écrit simplement **PEKKA**.\n" +
      "• Les espaces entre les mots d'un nom sont optionnels.\n" +
      "• Les cartes dont le nom contient une **apostrophe** (ex. Barbares d'élite) ne font pas partie de ce jeu.",
    color: PELEMELE_COLOR,
  };
}

// ── Récapitulatif de fin de saison ──────────────────────────────
// Copie quasi identique de buildSeasonRecapEmbed dans anagrams.js (mêmes
// règles : troncage à 20 joueurs, exclusion des 0 pt, gestion des ex-aequo
// pour les médailles), libellé adapté au jeu Pêle-mêle. Différence : pas
// d'illustration dédiée de fin de saison (aucun asset créé pour ce jeu),
// `image` simplement omise plutôt que de pointer vers un fichier inexistant.
//
// Contrairement à Anagram, ce récap n'est PAS déclenché par postPeleMele()
// lui-même mais uniquement par scripts/postJeuxDeLettres.js (voir
// postSeasonRecap ci-dessous) : sous l'alternance, ce n'est pas forcément
// Pêle-mêle qui reprend la main juste après SA propre saison — seul
// l'orchestrateur partagé sait quand recaper la bonne saison au bon moment
// (voir backend/services/jeuxdelettres.js).

const SEASON_RECAP_MAX_PLAYERS = 20;
const SEASON_RECAP_MEDALS = ["🥇", "🥈", "🥉"];

function buildSeasonRecapEmbed(
  seasonRanking,
  endedSeasonId,
  newSeasonId,
  manchesPlayed,
) {
  const nonZero = seasonRanking.filter((r) => r.totalScore > 0);
  const shown = nonZero.slice(0, SEASON_RECAP_MAX_PLAYERS);
  const hiddenCount = nonZero.length - shown.length;

  const lines = [
    "**Classement final :**",
    ...shown.map((entry) => {
      const rank = findTiedRank(shown, entry.discordId, "totalScore");
      const tiedCount = shown.filter(
        (e) => e.totalScore === entry.totalScore,
      ).length;
      const label =
        tiedCount === 1 && rank <= 3
          ? SEASON_RECAP_MEDALS[rank - 1]
          : `${rank}.`;
      return `${label} ${entry.pseudo} — ${entry.totalScore} pts`;
    }),
  ];
  if (hiddenCount > 0) {
    lines.push(
      `... et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} joueur${hiddenCount > 1 ? "s" : ""}`,
    );
  }
  if (manchesPlayed?.length > 0) {
    lines.push(
      "",
      "**Manches de la saison :**",
      ...manchesPlayed.map((m) => `Manche ${m.seasonManche} : ${m.label}`),
    );
  }
  lines.push(
    "",
    `Bravo à tous ! Rendez-vous juste après pour le lancement de la Saison ${toPublicSeasonId(newSeasonId)}.`,
  );

  return {
    title: `🏆 Fin de la Saison ${toPublicSeasonId(endedSeasonId)} « Pêle-mêle » !`,
    description:
      `Merci aux ${seasonRanking.length} joueur${seasonRanking.length > 1 ? "s" : ""} qui ont participé à ce mini-jeu cette saison.\n\n` +
      lines.join("\n"),
    color: PELEMELE_COLOR,
  };
}

// Remplace le pseudo figé de chaque entrée par le pseudo Discord actuel
// (résolution live, repli sur le pseudo stocké en cas d'échec).
async function resolveRankingPseudos(ranking) {
  return Promise.all(
    ranking.map(async (entry) => ({
      ...entry,
      pseudo: await resolveDisplayName(entry.discordId, entry.pseudo),
    })),
  );
}

// Liste triée (Manche 1, 2, 3...) des tirages de la saison écoulée, pour le
// récap de fin de saison. Contrairement à Anagram (une réponse unique par
// manche, `getAnagramAnswer(gameId)`), Pêle-mêle n'a pas de "réponse" unique
// — le libellé affiché est donc le TIRAGE (les lettres) de la manche,
// identique pour tous les joueurs, lu depuis n'importe quel enregistrement
// archivé de ce gameId (voir le champ `letters` ajouté dans finalizeRound,
// backend/services/pelemele.js).
async function getSeasonManchesPlayed(seasonId) {
  const allResults = await getAllArchivedResults();
  const seasonResults = allResults.filter((r) => r.seasonId === seasonId);
  const lettersByGameId = new Map();
  for (const r of seasonResults) {
    if (!lettersByGameId.has(r.gameId))
      lettersByGameId.set(r.gameId, r.letters);
  }
  const gameIds = [...lettersByGameId.keys()];
  const manches = await Promise.all(
    gameIds.map(async (gameId) => ({
      seasonManche: await getSeasonMancheNumber(seasonId, gameId),
      label: lettersByGameId.get(gameId),
    })),
  );
  return manches
    .filter((m) => m.seasonManche != null && m.label != null)
    .sort((a, b) => a.seasonManche - b.seasonManche);
}

// Exportée : appelée directement par scripts/postJeuxDeLettres.js.
export async function postSeasonRecap(
  channelId,
  endedSeasonId,
  newSeasonId,
  { noPing = false } = {},
) {
  const token = process.env.DISCORD_TOKEN;
  const seasonRanking = await computeSeasonRanking(endedSeasonId);
  if (seasonRanking.length === 0) return; // rien à récapituler

  const resolvedRanking = await resolveRankingPseudos(seasonRanking);
  const manchesPlayed = await getSeasonManchesPlayed(endedSeasonId);
  const embed = buildSeasonRecapEmbed(
    resolvedRanking,
    endedSeasonId,
    newSeasonId,
    manchesPlayed,
  );
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], ...buildRolePingFields(roleId) }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi récap de saison (${res.status}): ${errText}`);
  }
}

// custom_id des boutons "Règles"/"Journal" SANS gameId : ni l'un ni l'autre
// ne dépend de la manche affichée sur CE post précis — les règles sont
// statiques, et le Journal lit toujours l'état COURANT (readState) plutôt
// que la manche à laquelle le message appartenait au moment de son post
// (sinon cliquer sur un vieux post afficherait une manche "actuelle" périmée).
function buildAnswerComponents(gameId) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "✏️ Proposer un mot",
          custom_id: `pelemele_answer:${gameId}`,
        },
        {
          type: 2,
          style: 2,
          label: "📜 Règles",
          custom_id: "pelemele_rules",
        },
        {
          type: 2,
          style: 2,
          label: "📖 Journal",
          custom_id: "pelemele_journal",
        },
      ],
    },
  ];
}

export function buildAnswerModal(gameId) {
  return {
    custom_id: `pelemele_answer_modal:${gameId}`,
    title: "Propose un mot",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "pelemele_answer_input",
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

// ── Publication ────────────────────────────────────────────────
// Appelée par scripts/postJeuxDeLettres.js (production, avec force:true —
// le gating jour/créneau est déjà fait par l'orchestrateur, voir
// backend/services/jeuxdelettres.js) ou par scripts/postPeleMele.js
// (test/rattrapage manuel direct de ce jeu précis). skipSeasonRecap n'existe
// PAS ici (contrairement à postAnagram) : ce jeu n'a aucune logique de récap
// interne, seul l'orchestrateur en décide (voir postSeasonRecap ci-dessus).
export async function postPeleMele(
  channelId,
  { dryRun = false, force = false, noPing = false } = {},
) {
  if (dryRun) {
    const pool = await loadEligiblePool();
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildPeleMeleEmbed({
      seasonId,
      seasonManche,
      seasonMancheTotal,
    });
    const pingRoleId = noPing
      ? null
      : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return {
      dryRun: true,
      poolSize: pool.length,
      embed,
      components: buildAnswerComponents("preview"),
      pingRoleId,
    };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state } = await startNewGame(channelId);
  const embed = buildPeleMeleEmbed(state);
  const components = buildAnswerComponents(state.gameId);
  const roleId = noPing ? null : await getRoleIdByName(MINI_JEUX_ROLE_NAME);

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
    console.error("[Pêle-mêle] Échec PATCH réponse éphémère:", err.message);
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
    console.error(
      "[Pêle-mêle] Échec PATCH réponse éphémère (embed):",
      err.message,
    );
  }
}

function formatHistoryLine(history) {
  return history.length > 0
    ? `_Tes propositions valides jusqu'ici : ${history.join(", ")}_`
    : "";
}

// Nombre de manches précédentes affichées dans le Journal — au-delà, la
// liste deviendrait illisible dans un embed Discord (et on approcherait la
// limite de 4096 caractères d'une description).
const JOURNAL_HISTORY_LIMIT = 10;

// ── Bouton "Journal" (mots trouvés sur la manche en cours + historique
// personnel des manches précédentes) ──────────────────────────────────
export async function handleJournalButton(webhookUrl, discordId) {
  try {
    const state = await readState();

    let currentSection;
    if (!state) {
      currentSection = "_Aucune manche en cours._";
    } else {
      const participant = await readParticipant(state.gameId, discordId);
      if (!participant?.foundWords?.length) {
        currentSection = "Tu n'as encore rien trouvé sur cette manche.";
      } else {
        const progress =
          state.totalValidWords != null
            ? ` (${participant.foundWords.length}/${state.totalValidWords})`
            : "";
        currentSection =
          `**${participant.foundWords.join(", ")}**${progress}\n` +
          `Score sur cette manche : **${participant.score} pts**`;
      }
    }

    const seasonId = state?.seasonId ?? (await getCurrentSeasonId());
    let previousSection = "_Pas encore de manche terminée._";
    if (seasonId != null) {
      const results = (await getPlayerSeasonResults(seasonId, discordId))
        // La manche EN COURS n'est pas encore archivée (voir finalizeRound,
        // déclenché seulement quand la manche suivante démarre) donc jamais
        // dans getPlayerSeasonResults — ce filtre est un filet de sécurité,
        // pas le cas attendu en pratique.
        .filter((r) => r.gameId !== state?.gameId)
        .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

      if (results.length > 0) {
        const shown = results.slice(0, JOURNAL_HISTORY_LIMIT);
        const lines = await Promise.all(
          shown.map(async (r) => {
            const manche = await getSeasonMancheNumber(r.seasonId, r.gameId);
            return `Manche ${manche ?? "?"} : **${r.score} pts** (${r.reponse})`;
          }),
        );
        const total = results.reduce(
          (sum, r) => sum + (Number(r.score) || 0),
          0,
        );
        const hiddenCount = results.length - shown.length;
        previousSection =
          lines.join("\n") +
          (hiddenCount > 0
            ? `\n_... et ${hiddenCount} manche${hiddenCount > 1 ? "s" : ""} plus ancienne${hiddenCount > 1 ? "s" : ""}_`
            : "") +
          `\n\nTotal cumulé : **${total} pts** sur ${results.length} manche${results.length > 1 ? "s" : ""}.`;
      }
    }

    await postEphemeralEmbed(webhookUrl, {
      title: "📖 Journal — Pêle-mêle",
      description: `**Manche actuelle**\n${currentSection}\n\n**Manches précédentes**\n${previousSection}`,
      color: PELEMELE_COLOR,
    });
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
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

    const [pool, fullList] = await Promise.all([
      loadEligiblePool(),
      loadFullCardList(),
    ]);
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
        `🚫 **${result.entry.fr}** existe dans Clash Royale, mais ne fait pas partie du pool de ce jeu (apostrophe dans le nom, ou plus de ${DRAW_SIZE} lettres). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    if (result.status === "impossible") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `❌ **${result.entry.fr}** (${canonicalWordForm(result.entry.fr)}) n'est pas valide : certaines lettres ne sont pas dans ce tirage. Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    const seasonId = await getCurrentSeasonId();
    const { isNew, points, foundCount, participant } = await submitWord(
      gameId,
      discordId,
      username,
      result.entry,
      result.length,
      state.maxWordLength,
      seasonId,
    );
    const word = canonicalWordForm(result.entry.fr);

    if (!isNew) {
      await postEphemeral(
        webhookUrl,
        `✅ Tu avais déjà trouvé **${word}**. Il en reste peut-être d'autres à chercher !`,
      );
      return;
    }

    const isLongest = result.length === state.maxWordLength;
    const foundAll =
      state.totalValidWords != null && foundCount === state.totalValidWords;
    const progress =
      state.totalValidWords != null
        ? ` (${foundCount}/${state.totalValidWords} mots trouvés)`
        : "";

    await postEphemeral(
      webhookUrl,
      `${isLongest ? "🏆" : "🎉"} **${word}** (${result.length} lettre${result.length > 1 ? "s" : ""}) — +${points} pt${points > 1 ? "s" : ""} ! ` +
        `Score total sur cette manche : **${participant.score} pts**${progress}.` +
        (foundAll
          ? "\n\n🎊 Tu as trouvé TOUS les mots de cette manche, bravo !"
          : ""),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}

// ── Commande /pelemele : scores personnels du joueur ────────────────
// Miroir structurel de handleAnagramStatsCommand (anagrams.js) — même forme
// (manche en cours + historique de saison + score total + rang), adapté à
// l'absence de notion de "solved" : la section "manche en cours" liste les
// mots trouvés au lieu d'un booléen, et le classement de manche compte les
// joueurs ayant trouvé AU MOINS un mot (pas de "premier arrivé").
function buildPeleMeleStatsEmbed({
  pseudo,
  seasonId,
  currentSeasonManche,
  seasonMancheTotal,
  currentFoundWords,
  currentScore,
  totalValidWords,
  foundPlayersCount,
  totalParticipants,
  pastManches,
  seasonTotal,
  seasonRank,
  seasonRankTotal,
}) {
  const lines = [];

  lines.push(
    `**Saison ${toPublicSeasonId(seasonId)} · Manche ${currentSeasonManche}/${seasonMancheTotal} (actuelle) :**`,
  );
  if (currentFoundWords.length > 0) {
    const progress =
      totalValidWords != null
        ? ` (${currentFoundWords.length}/${totalValidWords})`
        : "";
    lines.push(`- Tu as trouvé : ${currentFoundWords.join(", ")}${progress}`);
    lines.push(`- Tu as marqué ${currentScore} points`);
  } else {
    lines.push("- Tu n'as pas encore trouvé de carte sur cette manche");
  }
  lines.push(
    `- ${foundPlayersCount} joueur${foundPlayersCount > 1 ? "s" : ""} (sur ${totalParticipants}) ${foundPlayersCount > 1 ? "ont" : "a"} trouvé au moins une carte pour le moment`,
  );

  for (const m of pastManches) {
    lines.push("");
    lines.push(
      `**Saison ${toPublicSeasonId(seasonId)} · Manche ${m.seasonManche}/${seasonMancheTotal} :**`,
    );
    if (m.played) {
      lines.push(`- Tu as trouvé : ${m.reponse}`);
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
    title: `🔤 Scores de ${pseudo}`,
    description: lines.join("\n"),
    color: PELEMELE_COLOR,
  };
}

function buildPeleMeleStatsComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "🔄 Rafraîchir",
          custom_id: "pelemele_stats_refresh",
        },
      ],
    },
  ];
}

export async function handlePeleMeleStatsCommand(
  webhookUrl,
  discordId,
  username,
) {
  try {
    const state = await readState();
    if (!state) {
      await postEphemeral(
        webhookUrl,
        "⚠️ Aucune partie Pêle-mêle n'a encore été lancée.",
      );
      return;
    }

    const [
      participant,
      seasonResults,
      seasonManches,
      gameRanking,
      inProgress,
      seasonRanking,
    ] = await Promise.all([
      readParticipant(state.gameId, discordId),
      getPlayerSeasonResults(state.seasonId, discordId),
      getSeasonManches(state.seasonId),
      computeGameRanking(state.gameId),
      listGamePlayersInProgress(state.gameId),
      computeSeasonRanking(state.seasonId),
    ]);

    const currentFoundWords = participant?.foundWords ?? [];
    const currentScore = participant?.score ?? 0;
    const foundPlayersCount = gameRanking.length;
    const totalParticipants = foundPlayersCount + inProgress.length;

    const hasSeasonRank = seasonResults.length > 0;
    const seasonRank = hasSeasonRank
      ? findTiedRank(seasonRanking, discordId, "totalScore")
      : null;
    const seasonRankTotal = seasonRanking.length;

    const pastGameIds = seasonManches.filter(
      (gameId) => gameId !== state.gameId,
    );
    const pastManches = (
      await Promise.all(
        pastGameIds.map(async (gameId) => {
          const result = seasonResults.find((r) => r.gameId === gameId);
          return {
            seasonManche: await getSeasonMancheNumber(state.seasonId, gameId),
            played: !!result,
            score: result?.score ?? 0,
            reponse: result?.reponse ?? null,
          };
        }),
      )
    )
      .filter((m) => m.seasonManche != null)
      .sort((a, b) => b.seasonManche - a.seasonManche);

    const seasonTotal = seasonResults.reduce((sum, r) => sum + r.score, 0);

    const embed = buildPeleMeleStatsEmbed({
      pseudo: username,
      seasonId: state.seasonId,
      currentSeasonManche: state.seasonManche,
      seasonMancheTotal: state.seasonMancheTotal,
      currentFoundWords,
      currentScore,
      totalValidWords: state.totalValidWords,
      foundPlayersCount,
      totalParticipants,
      pastManches,
      seasonTotal,
      seasonRank,
      seasonRankTotal,
    });

    await postEphemeralEmbed(
      webhookUrl,
      embed,
      buildPeleMeleStatsComponents(),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
