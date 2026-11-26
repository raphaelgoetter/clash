// ============================================================
// pelemele.js — Handlers Discord pour le jeu "Pêle-mêle"
// (DRAW_SIZE lettres tirées, retrouver les noms du thème de la manche,
// Pokémon ou capitales, qu'on peut former avec). Embed, bouton, modal. Deux particularités (voir
// jeux/services/pelemele.js pour le détail complet) :
// - pas de nom secret : n'importe quel nom du pool qui rentre dans
//   le tirage est une réponse valide, il n'y a donc pas de notion de
//   victoire qui termine la manche ;
// - un joueur peut reproposer autant de fois qu'il veut ; TOUS ses mots
//   distincts trouvés comptent (barème : LONGEST_WORD_BONUS pour le(s) mot(s)
//   le(s) plus long(s) possible(s) du tirage, EXTRA_WORD_POINTS pour chaque
//   autre — voir pelemele.js), pas juste le meilleur — le bouton
//   "Proposer un mot" reste donc identique après chaque tentative.
//
// Production : alterne avec Concept, une saison sur deux, dans le groupe
// "Jeux de mots" — voir
// jeux/services/jeuxdelettres.js. En production, la publication passe
// UNIQUEMENT par jeux/scripts/postJeuxDeLettres.js (qui décide quel jeu est actif
// et gère le récap de fin de saison du jeu qui vient de se terminer, quel
// qu'il soit) ; jeux/scripts/postPeleMele.js reste utilisable pour forcer un post
// direct de CE jeu précis (test, rattrapage manuel).
// ============================================================

import {
  DRAW_SIZE,
  loadEligiblePool,
  loadFullList,
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
  getSeasonMancheNumber,
  computeSeasonRanking,
  getAllArchivedResults,
  findTiedRank,
  themeOf,
  nextTheme,
} from "../../services/pelemele.js";
import { nomSaison } from "../../services/saison.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { deletePreviousRoundMessage } from "@clash/commun/discordMessages.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const PELEMELE_COLOR = 0x9b59b6;

// Libellés joueurs de chaque thème (voir THEME_ORDER dans le service).
const THEME_TEXTES = {
  pokemon: {
    caches: "Pokémon de la 1re génération se cachent",
    tous: "tous",
    unTrouve: "Pokémon trouvé",
    trouves: "Pokémon trouvés",
    tousLes: "TOUS les Pokémon",
  },
  capitales: {
    caches: "capitales du monde se cachent",
    tous: "toutes",
    unTrouve: "capitale trouvée",
    trouves: "capitales trouvées",
    tousLes: "TOUTES les capitales",
  },
};

// L'image (chevalet de tuiles, voir pelemeleImage.js) n'existe que pour
// une manche RÉELLEMENT démarrée (gameId != null) — en dry-run/preview,
// aucun tirage n'a encore été généré (voir postPeleMele), donc pas
// d'image à référencer.
function buildPeleMeleEmbed({
  theme,
  seasonId,
  seasonManche,
  seasonMancheTotal,
  gameId,
  totalValidWords,
}) {
  const t = THEME_TEXTES[themeOf({ theme })];
  return {
    title: "🔤 Le jeu du samedi : Pêle-mêle !",
    description:
      `**${nomSaison(seasonId)} · Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      // Nombre de solutions inconnu en dry-run (aucun tirage généré).
      `${totalValidWords != null ? `**${totalValidWords}**` : "Plusieurs"} ${t.caches} derrière ces ${DRAW_SIZE} lettres. Sauras-tu ${t.tous} les retrouver ?\n\n` +
      `🏆 **1 point** par ${t.unTrouve}, **5 points** s'il s'agit du nom le plus long.\n` +
      "♾️ Tu as autant d'essais que tu veux !\n\n" +
      "📜 Détails (orthographe, accents, ponctuation...) dans le bouton **Règles**.\n\n" +
      "**Merci de ne pas spoiler ni tricher, sinon c'est pas drôle !**",
    color: PELEMELE_COLOR,
    // Cache-buster (?v=) — même pattern que frames.js/zoom.js :
    // Discord met en cache l'aperçu d'un embed PAR URL.
    ...(gameId
      ? {
          image: {
            url: `${URL_JEUX}/api/pelemele/image?gameId=${gameId}&v=${Date.now()}`,
          },
        }
      : {}),
    footer: {
      text: "Nouvelle manche : samedi prochain.",
    },
  };
}

// Contenu statique (aucune dépendance à l'état d'une manche précise) — sert
// à la fois au bouton "Règles" sur le post sur le post.
export function buildRulesEmbed() {
  return {
    title: "📜 Règles de Pêle-mêle",
    description:
      `${DRAW_SIZE} lettres sont tirées au sort à chaque manche. Selon la manche, retrouve des **Pokémon de la 1re génération** (les 151 premiers du Pokédex) ou des **capitales du monde** que tu peux former avec ces lettres, autant de fois que tu veux, aucune limite d'essais.\n\n` +
      "**Barème**\n" +
      "🏆 **5 points** pour le (ou les) nom(s) le(s) plus long(s) possible(s) sur ce tirage.\n" +
      "✨ **+1 point** pour chaque autre nom trouvé.\n" +
      "Reproposer un nom déjà trouvé ne rapporte rien : seuls les noms **distincts** comptent.\n\n" +
      "**Orthographe**\n" +
      "• Les accents ne sont pas obligatoires (é/e, à/a… acceptés indifféremment).\n" +
      "• La casse n'a pas d'importance (majuscules/minuscules).\n" +
      "• Les noms sont les noms français officiels. La ponctuation est ignorée : **M. Mime** s'écrit **MMIME**, **N'Djaména** s'écrit **NDJAMENA**.\n" +
      "• Les espaces entre les mots d'un nom sont optionnels.\n" +
      "• Nidoran♀ et Nidoran♂ comptent pour un seul nom : **Nidoran**.\n" +
      "• Toutes les capitales d'un pays qui en a plusieurs sont valides (ex. **La Paz** et **Sucre**).",
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
// lui-même mais uniquement par jeux/scripts/postJeuxDeLettres.js (voir
// postSeasonRecap ci-dessous) : sous l'alternance, ce n'est pas forcément
// Pêle-mêle qui reprend la main juste après SA propre saison — seul
// l'orchestrateur partagé sait quand recaper la bonne saison au bon moment
// (voir jeux/services/jeuxdelettres.js).

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
      return `${label} ${entry.pseudo} (${entry.totalScore} pts)`;
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
    `Bravo à tous ! Rendez-vous juste après pour le lancement de la ${nomSaison(newSeasonId)}.`,
  );

  return {
    title: `🏆 Fin de la ${nomSaison(endedSeasonId)} « Pêle-mêle » !`,
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
// jeux/services/pelemele.js).
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

// Exportée : appelée directement par jeux/scripts/postJeuxDeLettres.js.
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
            label: "Ta réponse",
            placeholder: "Un nom caché dans les lettres…",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

// ── Publication ────────────────────────────────────────────────
// Appelée par jeux/scripts/postJeuxDeLettres.js (production, avec force:true —
// le gating jour/créneau est déjà fait par l'orchestrateur, voir
// jeux/services/jeuxdelettres.js) ou par jeux/scripts/postPeleMele.js
// (test/rattrapage manuel direct de ce jeu précis). skipSeasonRecap n'existe
// PAS ici (contrairement à postAnagram) : ce jeu n'a aucune logique de récap
// interne, seul l'orchestrateur en décide (voir postSeasonRecap ci-dessus).
export async function postPeleMele(
  channelId,
  { dryRun = false, force = false, noPing = false } = {},
) {
  if (dryRun) {
    const theme = nextTheme(await readState());
    const pool = await loadEligiblePool(theme);
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildPeleMeleEmbed({
      theme,
      seasonId,
      seasonManche,
      seasonMancheTotal,
    });
    const pingRoleId = noPing
      ? null
      : await getRoleIdByName(MINI_JEUX_ROLE_NAME);
    return {
      dryRun: true,
      theme,
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

  const previousState = await readState();
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
  await deletePreviousRoundMessage(previousState, "Pêle-mêle");

  return { state, message };
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
      title: "📖 Journal de Pêle-mêle",
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
      loadEligiblePool(themeOf(state)),
      loadFullList(themeOf(state)),
    ]);
    const result = validateSubmission(pool, fullList, state.letters, rawAnswer);

    if (result.status === "invalid") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `🤔 Je ne reconnais pas « ${rawAnswer} », vérifie l'orthographe (le nom doit être en français). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
      );
      return;
    }

    if (result.status === "not-eligible") {
      const history = await getGuessHistory(gameId, discordId);
      await postEphemeral(
        webhookUrl,
        `🚫 **${result.entry.fr}** ne fait pas partie du pool de ce jeu (plus de ${DRAW_SIZE} lettres). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
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

    const t = THEME_TEXTES[themeOf(state)];
    const isLongest = result.length === state.maxWordLength;
    const foundAll =
      state.totalValidWords != null && foundCount === state.totalValidWords;
    const progress =
      state.totalValidWords != null
        ? ` (${foundCount}/${state.totalValidWords} ${t.trouves})`
        : "";

    await postEphemeral(
      webhookUrl,
      `${isLongest ? "🏆" : "🎉"} **${word}** (${result.length} lettre${result.length > 1 ? "s" : ""}) : +${points} pt${points > 1 ? "s" : ""} ! ` +
        `Score total sur cette manche : **${participant.score} pts**${progress}.` +
        (foundAll
          ? `\n\n🎊 Tu as trouvé ${t.tousLes} de cette manche, bravo !`
          : ""),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
