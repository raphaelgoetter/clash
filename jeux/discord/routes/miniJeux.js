// Mini-jeux quotidiens : Frame, Anagram, Zoom, Blind Royale, La Juste
// Carte, Pêle-Mêle, Palette, Trivia, Quiz, sondage d'idées, /mini-jeux et
// /mini-jeux-history (commandes, boutons, modals de réponse).
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  buildAnswerModal as buildFrameAnswerModal,
  handleHintButton as handleFrameHintButton,
  handleModalSubmit as handleFrameModalSubmit,
} from "../handlers/frames.js";
import {
  buildAnswerModal as buildAnagramAnswerModal,
  handleModalSubmit as handleAnagramModalSubmit,
} from "../handlers/anagrams.js";
import {
  buildAnswerModal as buildZoomAnswerModal,
  handleHintButton as handleZoomHintButton,
  handleModalSubmit as handleZoomModalSubmit,
} from "../handlers/zoom.js";
import {
  buildAnswerModal as buildZoom2AnswerModal,
  handleHintButton as handleZoom2HintButton,
  handleModalSubmit as handleZoom2ModalSubmit,
} from "../handlers/zoom2.js";
import {
  buildAnswerModal as buildJusteCarteAnswerModal,
  handleModalSubmit as handleJusteCarteModalSubmit,
  handleHintButton as handleJusteCarteHintButton,
  handleExcludedListButton as handleJusteCarteExcludedListButton,
} from "../handlers/lajustecarte.js";
import {
  buildAnswerModal as buildPeleMeleAnswerModal,
  handleModalSubmit as handlePeleMeleModalSubmit,
  buildRulesEmbed as buildPeleMeleRulesEmbed,
  handleJournalButton as handlePeleMeleJournalButton,
} from "../handlers/pelemele.js";
import {
  buildAnswerModal as buildBlindRoyaleAnswerModal,
  handleHintButton as handleBlindRoyaleHintButton,
  handleModalSubmit as handleBlindRoyaleModalSubmit,
} from "../handlers/blindroyale.js";
import { handleQuizVote } from "../handlers/quiz.js";
// En alternance avec Zoom carte sous "Jeux visuels" (voir jeuxvisuels.js) —
// publication via jeux/scripts/postJeuxVisuels.js (ou jeux/scripts/postPalette.js en
// direct), jamais depuis ce fichier de routing.
import { handleAnswerButton as handlePaletteAnswer } from "../handlers/palette.js";
// En alternance avec Frame sous "Mini-jeux de Culture" (voir
// jeuxculture.js) — publication via jeux/scripts/postJeuxCulture.js (ou
// jeux/scripts/postTrivia.js en direct), jamais depuis ce fichier de routing.
import { handleAnswerButton as handleTriviaAnswer } from "../handlers/trivia.js";
import { handleAnswerButton as handleTriviaGeekAnswer } from "../handlers/triviageek.js";
import {
  handleHintButton as handleConceptHintButton,
  handleModalSubmit as handleConceptModalSubmit,
  buildAnswerModal as buildConceptAnswerModal,
} from "../handlers/concept.js";
import {
  handleHintButton as handleSynopsisHintButton,
  handleModalSubmit as handleSynopsisModalSubmit,
  buildAnswerModal as buildSynopsisAnswerModal,
} from "../handlers/synopsis.js";
import {
  handleHintButton as handlePlatPaysHintButton,
  handleModalSubmit as handlePlatPaysModalSubmit,
  buildAnswerModal as buildPlatPaysAnswerModal,
} from "../handlers/platpays.js";
import {
  buildIdeaModal as buildPollIdeaModal,
  handleIdeaModalSubmit as handlePollIdeaModalSubmit,
} from "../handlers/poll.js";
import {
  handleMiniJeuxCommand,
  handleMiniJeuxParticipation,
  handleMiniJeuxStats,
} from "../handlers/minijeux.js";
import {
  handleMiniJeuxHistory,
  handleMiniJeuxHistoryPage,
} from "../handlers/miniJeuxHistory.js";
import { runBackground, buildDiscordWebhookUrl } from "@clash/commun/discordInteractions.js";

export async function routeMiniJeux(body, res) {
  // ── Jeu Frame : boutons indices ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("frame_hint1:") ||
      body.data.custom_id.startsWith("frame_hint2:"))
  ) {
    const [prefix, gameId] = body.data.custom_id.split(":");
    const hintKey = prefix === "frame_hint1" ? "indice1" : "indice2";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleFrameHintButton(webhookUrl, gameId, hintKey, discordId, username),
    );
    return;
  }

  // ── Jeu Synopsis éclaté : boutons indice (année, réalisation) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("synopsis_hint1:") ||
      body.data.custom_id.startsWith("synopsis_hint2:"))
  ) {
    const [prefix, gameId] = body.data.custom_id.split(":");
    const hintKey = prefix === "synopsis_hint1" ? "indice1" : "indice2";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleSynopsisHintButton(webhookUrl, gameId, hintKey, discordId, username));
    return;
  }

  // ── Jeu Synopsis éclaté : bouton "Répondre" → ouverture de la Modal (synchrone) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("synopsis_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res.status(200).json({ type: 9, data: buildSynopsisAnswerModal(gameId) });
  }

  // ── Jeu Synopsis éclaté : soumission de la Modal (body.type 5 = MODAL_SUBMIT) ──
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("synopsis_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleSynopsisModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer));
    return;
  }

  // ── Jeu Plat Pays : boutons indice (ingrédients, continent) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("platpays_hint1:") ||
      body.data.custom_id.startsWith("platpays_hint2:"))
  ) {
    const [prefix, gameId] = body.data.custom_id.split(":");
    const hintKey = prefix === "platpays_hint1" ? "indice1" : "indice2";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePlatPaysHintButton(webhookUrl, gameId, hintKey, discordId, username));
    return;
  }

  // ── Jeu Plat Pays : bouton "Répondre" → ouverture de la Modal (synchrone) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("platpays_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res.status(200).json({ type: 9, data: buildPlatPaysAnswerModal(gameId) });
  }

  // ── Jeu Plat Pays : soumission de la Modal (body.type 5 = MODAL_SUBMIT) ──
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("platpays_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePlatPaysModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer));
    return;
  }

  // ── Jeu Concept : bouton indice (catégorie) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("concept_hint:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleConceptHintButton(webhookUrl, gameId, discordId, username));
    return;
  }

  // ── Jeu Concept : bouton "Répondre" → ouverture de la Modal (synchrone) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("concept_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res.status(200).json({ type: 9, data: buildConceptAnswerModal(gameId) });
  }

  // ── Jeu Concept : soumission de la Modal (body.type 5 = MODAL_SUBMIT) ──
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("concept_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleConceptModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer));
    return;
  }

  // ── Jeu Frame : bouton "Valider" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("frame_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildFrameAnswerModal(gameId) });
  }

  // ── Jeu Frame : soumission de la Modal (réponse du joueur) ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier — deux enums Discord distinctes qui
  // partagent des valeurs numériques.
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("frame_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleFrameModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── Jeu Anagram : bouton "Répondre" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici). Pas de bouton indice
  // pour ce jeu (contrairement à Frame).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("anagram_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildAnagramAnswerModal(gameId) });
  }

  // ── Jeu Anagram : soumission de la Modal (réponse du joueur) ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier — deux enums Discord distinctes qui
  // partagent des valeurs numériques.
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("anagram_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleAnagramModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── Jeu Zoom carte : bouton indice ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom_hint:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleZoomHintButton(webhookUrl, gameId, discordId, username),
    );
    return;
  }

  // ── Jeu Zoom carte : bouton "Répondre" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildZoomAnswerModal(gameId) });
  }

  // ── Jeu Zoom carte : soumission de la Modal (réponse du joueur) ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier — deux enums Discord distinctes qui
  // partagent des valeurs numériques.
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleZoomModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── Jeu Zoom logo : bouton indice ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom2_hint:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleZoom2HintButton(webhookUrl, gameId, discordId, username));
    return;
  }

  // ── Jeu Zoom logo : bouton "Répondre" → ouverture de la Modal (synchrone) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom2_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res.status(200).json({ type: 9, data: buildZoom2AnswerModal(gameId) });
  }

  // ── Jeu Zoom logo : soumission de la Modal (body.type 5 = MODAL_SUBMIT) ──
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("zoom2_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleZoom2ModalSubmit(webhookUrl, gameId, discordId, username, rawAnswer));
    return;
  }

  // ── Jeu Blind Royale : bouton indice "Rareté" ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blindroyale_hint:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleBlindRoyaleHintButton(webhookUrl, gameId, discordId, username),
    );
    return;
  }

  // ── Jeu Blind Royale : bouton "Répondre" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blindroyale_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildBlindRoyaleAnswerModal(gameId) });
  }

  // ── Jeu Blind Royale : soumission de la Modal (réponse du joueur) ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), voir le
  // commentaire équivalent dans le bloc Zoom carte ci-dessus.
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blindroyale_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleBlindRoyaleModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── /mini-jeux : état des lieux des mini-jeux réguliers + jeu spécial
  // du moment — réponse publique (pas de flags: 64), c'est un tableau de
  // bord partagé, pas une info personnelle.
  if (body.type === 2 && body.data?.name === "mini-jeux") {
    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMiniJeuxCommand(webhookUrl));
    return;
  }

  // ── /mini-jeux : bouton "Ma participation" ──
  // Les anciens messages /mini-jeux portent encore "minijeux_refresh" :
  // même traitement, le bouton ouvrant de toute façon un message à part.
  if (
    body.type === 3 &&
    (body.data?.custom_id === "minijeux_participation" ||
      body.data?.custom_id === "minijeux_refresh")
  ) {
    const discordId = body.member?.user?.id ?? body.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 + flags 64 : NOUVEAU message éphémère (personnel), le tableau
    // de bord public reste inchangé.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleMiniJeuxParticipation(webhookUrl, discordId, username),
    );
    return;
  }

  // ── /mini-jeux : bouton "📊 Stats" (message éphémère, stats globales) ──
  if (body.type === 3 && body.data?.custom_id === "minijeux_stats") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMiniJeuxStats(webhookUrl));
    return;
  }

  // ── /mini-jeux-history : historique des vainqueurs de saisons mini-jeux ──
  if (body.type === 2 && body.data?.name === "mini-jeux-history") {
    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMiniJeuxHistory(webhookUrl));
    return;
  }

  // ── /mini-jeux-history : bouton "Précédentes" ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("minijeux_history_page:")
  ) {
    const [, offsetStr] = body.data.custom_id.split(":");
    const offset = parseInt(offsetStr, 10) || 0;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;
    runBackground(() => handleMiniJeuxHistoryPage(originalWebhookUrl, offset));
    return;
  }

  // ── Jeu La Juste Carte : bouton "Cartes non incluses" sur le post ──
  // Nouvelle réponse éphémère séparée — type 5 comme pour une commande
  // initiale.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id === "lajustecarte_excluded_list"
  ) {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleJusteCarteExcludedListButton(webhookUrl));
    return;
  }

  // ── Jeu La Juste Carte : bouton "Indice : rareté" ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("lajustecarte_hint:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleJusteCarteHintButton(webhookUrl, gameId, discordId, username),
    );
    return;
  }

  // ── Jeu La Juste Carte : bouton "Proposer/Reproposer une carte" → Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici). Même custom_id que
  // le bouton du post initial et que le bouton "Reproposer" renvoyé après
  // chaque tentative infructueuse — les deux rouvrent la même Modal.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("lajustecarte_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildJusteCarteAnswerModal(gameId) });
  }

  // ── Jeu La Juste Carte : soumission de la Modal (réponse du joueur) ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier — deux enums Discord distinctes qui
  // partagent des valeurs numériques.
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("lajustecarte_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleJusteCarteModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── Jeu Pêle-mêle : bouton "Proposer un mot" → Modal ──
  // Même mécanique que La Juste Carte (voir juste au-dessus), sauf qu'ici le
  // MÊME bouton sert à toutes les tentatives (pas de bouton "Reproposer"
  // séparé) puisqu'il n'y a pas de notion de victoire qui change son libellé.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("pelemele_answer:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    return res
      .status(200)
      .json({ type: 9, data: buildPeleMeleAnswerModal(gameId) });
  }

  // ── Jeu Pêle-mêle : bouton "Règles" ──
  // Contenu 100% statique (aucune lecture d'état/Redis) : réponse synchrone
  // directe, pas besoin du différé+webhook utilisé pour la soumission de mot.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id === "pelemele_rules"
  ) {
    return res
      .status(200)
      .json({ type: 4, data: { embeds: [buildPeleMeleRulesEmbed()], flags: 64 } });
  }

  // ── Jeu Pêle-mêle : bouton "Journal" ──
  // Lecture Redis (participant + historique de saison) : différé + webhook,
  // même mécanique que la soumission de mot ci-dessous.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id === "pelemele_journal"
  ) {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePeleMeleJournalButton(webhookUrl, discordId));
    return;
  }

  // ── Jeu Pêle-mêle : soumission de la Modal ──
  if (
    body.type === 5 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("pelemele_answer_modal:")
  ) {
    const gameId = body.data.custom_id.split(":")[1];
    const rawAnswer = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handlePeleMeleModalSubmit(
        webhookUrl,
        gameId,
        discordId,
        username,
        rawAnswer,
      ),
    );
    return;
  }

  // ── Quiz thématique : boutons de vote ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("quiz_vote:")
  ) {
    const [, manche, jour, choiceIndex] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : confirmation
    // privée uniquement — contrairement à Tamagoshi, le message public n'est
    // JAMAIS repatché (aucun compteur de votes affiché avant la révélation).
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleQuizVote(webhookUrl, manche, jour, choiceIndex, discordId, username));
    return;
  }

  // ── Jeu Palette : boutons de réponse A/B/C/D ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("palette_answer:")
  ) {
    const [, gameId, letter] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : réponse
    // définitive au premier clic, un simple QCM ne nécessite pas de Modal
    // (contrairement au bouton "Répondre" de Zoom) — même principe d'ACK
    // que quiz_vote ci-dessus.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePaletteAnswer(webhookUrl, gameId, letter, discordId, username));
    return;
  }

  // ── Jeu Trivia : boutons de réponse A/B/C/D ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("trivia_answer:")
  ) {
    const [, gameId, letter] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : réponse
    // définitive au premier clic, un simple QCM ne nécessite pas de Modal —
    // même principe d'ACK que palette_answer ci-dessus.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleTriviaAnswer(webhookUrl, gameId, letter, discordId, username));
    return;
  }

  // ── Jeu Trivia Geek : boutons de réponse A/B/C/D (même ACK que Trivia) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("triviageek_answer:")
  ) {
    const [, gameId, letter] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleTriviaGeekAnswer(webhookUrl, gameId, letter, discordId, username));
    return;
  }

  // ── Sondage public : bouton "Proposer une idée" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire : l'ouverture d'une Modal ne
  // peut pas être différée (pas de runBackground ici).
  if (body.type === 3 && body.data?.custom_id === "poll_idea") {
    return res.status(200).json({ type: 9, data: buildPollIdeaModal() });
  }

  // ── Sondage public : soumission de la Modal "idée de jeu" ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier — deux enums Discord distinctes qui
  // partagent des valeurs numériques.
  if (body.type === 5 && body.data?.custom_id === "poll_idea_modal") {
    const rawText = body.data.components?.[0]?.components?.[0]?.value || "";
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePollIdeaModalSubmit(webhookUrl, discordId, username, rawText));
    return;
  }
}
