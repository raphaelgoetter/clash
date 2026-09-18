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
// ⚠️ Statut : phase de TEST UNIQUEMENT. scripts/postPeleMele.js ne
// poste QUE sur le salon de test (DISCORD_CHANNEL_FRAME_TEST, réutilisé —
// voir CONTRIBUTING.md, pas de nouveau salon dédié) et n'expose
// volontairement PAS d'option --public : ce jeu doit remplacer un mini-jeu
// existant dont le choix n'est pas encore arrêté. Ne pas ajouter de cron
// GitHub Actions tant que cette décision n'est pas prise.
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
} from "../../../backend/services/pelemele.js";

const PELEMELE_COLOR = 0x9b59b6;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// L'image (chevalet de tuiles, voir pelemeleImage.js) n'existe que pour
// une manche RÉELLEMENT démarrée (gameId != null) — en dry-run/preview,
// aucun tirage n'a encore été généré (voir postPeleMele), donc pas
// d'image à référencer.
function buildPeleMeleEmbed({ seasonId, seasonManche, seasonMancheTotal, gameId, totalValidWords }) {
  return {
    title: "🔤 [TEST] Pêle-mêle",
    description:
      `**Manche ${seasonManche}/${seasonMancheTotal}**\n\n` +
      `Plusieurs cartes Clash Royale se cachent derrière ces ${DRAW_SIZE} lettres. Sauras-tu toutes les retrouver ?\n\n` +
      "🏆 **5 points** pour la carte la plus longue, **+1 point** bonus par carte supplémentaire.\n" +
      "♾️ Tu as autant d'essais que tu veux !\n\n" +
      (totalValidWords != null ? `🎯 **${totalValidWords} carte${totalValidWords > 1 ? "s" : ""} valide${totalValidWords > 1 ? "s" : ""} sur ce tirage** — à toi de toutes les trouver !\n\n` : "") +
      "📜 Détails (orthographe, accents, ponctuation...) dans le bouton **Règles**.\n\n" +
      "🚧 Jeu en test — les résultats de cette manche ne comptent pas encore pour un classement de saison officiel.",
    color: PELEMELE_COLOR,
    // Cache-buster (?v=) — même pattern que frames.js/zoom.js/lajustecarte.js :
    // Discord met en cache l'aperçu d'un embed PAR URL.
    ...(gameId ? { image: { url: `${TRUST_ROYALE_URL}/api/pelemele/image?gameId=${gameId}&v=${Date.now()}` } } : {}),
    footer: { text: "Manche ouverte jusqu'à la prochaine (jour de publication pas encore fixé)." },
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
      "• Les accents ne sont pas obligatoires (é/e, à/a... acceptés indifféremment).\n" +
      "• La casse n'a pas d'importance (majuscules/minuscules).\n" +
      "• Les points et autre ponctuation dans un nom de carte sont ignorés : **P.E.K.K.A** s'écrit simplement **PEKKA**.\n" +
      "• Les espaces entre les mots d'un nom sont optionnels.\n" +
      "• Les cartes dont le nom contient une **apostrophe** (ex. Barbares d'élite) ne font pas partie de ce jeu.",
    color: PELEMELE_COLOR,
  };
}

// custom_id du bouton "Règles" SANS gameId : les règles ne dépendent pas de
// la manche en cours, même routing/handler quel que soit le tirage — voir
// buildRulesEmbed (contenu 100% statique, pas de lecture d'état).
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

// ── Publication (appelée uniquement par scripts/postPeleMele.js) ──
// Volontairement plus simple que lajustecarte.js : pas de récap de fin de
// saison (le jeu n'est pas encore rattaché à un vrai classement de saison
// tant qu'il est en test), pas de ping de rôle (jamais utile sur le salon
// de test).
export async function postPeleMele(channelId, { dryRun = false, force = false } = {}) {
  if (dryRun) {
    const pool = await loadEligiblePool();
    const seasonId = await getCurrentSeasonId();
    const seasonManche = await previewSeasonManche(seasonId);
    const seasonMancheTotal = computeSeasonMancheTotal(seasonManche);
    const embed = buildPeleMeleEmbed({ seasonId, seasonManche, seasonMancheTotal });
    return { dryRun: true, poolSize: pool.length, embed, components: buildAnswerComponents("preview") };
  }

  if (!force && (await alreadyPostedThisWeek())) {
    return { skipped: true, reason: "already-posted-this-week" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state } = await startNewGame(channelId);
  const embed = buildPeleMeleEmbed(state);
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
    console.error("[Pêle-mêle] Échec PATCH réponse éphémère:", err.message);
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
        `🚫 **${result.entry.fr}** existe dans Clash Royale, mais ne fait pas partie du pool de ce jeu (apostrophe dans le nom, ou plus de ${DRAW_SIZE} lettres). Cette tentative n'a pas été comptabilisée.\n${formatHistoryLine(history)}`,
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
      await postEphemeral(webhookUrl, `✅ Tu avais déjà trouvé **${word}**. Il en reste peut-être d'autres à chercher !`);
      return;
    }

    const isLongest = result.length === state.maxWordLength;
    const foundAll = state.totalValidWords != null && foundCount === state.totalValidWords;
    const progress = state.totalValidWords != null ? ` (${foundCount}/${state.totalValidWords} mots trouvés)` : "";

    await postEphemeral(
      webhookUrl,
      `${isLongest ? "🏆" : "🎉"} **${word}** (${result.length} lettre${result.length > 1 ? "s" : ""}) — +${points} pt${points > 1 ? "s" : ""} ! ` +
        `Score total sur cette manche : **${participant.score} pts**${progress}.` +
        (foundAll ? "\n\n🎊 Tu as trouvé TOUS les mots de cette manche, bravo !" : ""),
    );
  } catch (err) {
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
