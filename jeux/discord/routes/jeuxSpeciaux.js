// Jeux spéciaux sur 7 jours : Blackjack, Gobelet, Robinson, Goblin Hunters,
// Mario Clash, Qui est-ce ? (archivé), Meow, Pont du Troll
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  handleVoteButton as handleRobinsonVote,
  handleEmbarquer as handleRobinsonEmbarquer,
  handleRegles as handleRobinsonRegles,
} from "../handlers/robinson.js";
import {
  handleRegisterButton as handleGoblinHuntersRegister,
  handleUnregisterButton as handleGoblinHuntersUnregister,
  handleLieuButton as handleGoblinHuntersLieu,
  handleEclaireurSecond as handleGoblinHuntersSecond,
  handleTargetSelect as handleGoblinHuntersTarget,
  handleRegles as handleGoblinHuntersRegles,
  handleJournal as handleGoblinHuntersJournal,
  handleMessagerie as handleGoblinHuntersMessagerie,
  handleMessagerieSubmit as handleGoblinHuntersMessagerieSubmit,
  buildMessagerieModal as buildGoblinHuntersMessagerieModal,
} from "../handlers/goblinhunters.js";
import {
  handleDiceButton as handleMarioClashDice,
  handleDiceSelect as handleMarioClashDiceSelect,
  handleBoutiqueButton as handleMarioClashBoutique,
  handleBoutiqueSelect as handleMarioClashBoutiqueSelect,
  handleItemTargetSelect as handleMarioClashItemTarget,
  handleSpellButton as handleMarioClashSpell,
  handleVehiculeSelect as handleMarioClashVehicule,
  handleVehiculeVoir as handleMarioClashVehiculeVoir,
  handleSpellConfirm as handleMarioClashSpellConfirm,
  handleJournal as handleMarioClashJournal,
  handleRegles as handleMarioClashRegles,
} from "../handlers/marioclash.js";
import {
  handleParticiper as handleQuiEstCeParticiper,
  handleDesinscrire as handleQuiEstCeDesinscrire,
  handleEnqueter as handleQuiEstCeEnqueter,
  handleQuestion as handleQuiEstCeQuestion,
  handleAccuser as handleQuiEstCeAccuser,
  handleObjet as handleQuiEstCeObjet,
  handleCible as handleQuiEstCeCible,
  handleJournal as handleQuiEstCeJournal,
  handleRegles as handleQuiEstCeRegles,
} from "../handlers/quiestce.js";
import {
  handleJouer as handleBlackjackJouer,
  handlePiocher as handleBlackjackPiocher,
  handleArreter as handleBlackjackArreter,
  handleDoubler as handleBlackjackDoubler,
  handleRegles as handleBlackjackRegles,
  handleJournal as handleBlackjackJournal,
} from "../handlers/blackjack.js";
import {
  handleJouer as handleGobeletJouer,
  handleToggle as handleGobeletToggle,
  handleRelancer as handleGobeletRelancer,
  handleValider as handleGobeletValider,
  handleChoisir as handleGobeletChoisir,
  handleRegles as handleGobeletRegles,
  handleJournal as handleGobeletJournal,
} from "../handlers/gobelet.js";
import {
  handleParticiper as handleMeowParticiper,
  handleDesinscrire as handleMeowDesinscrire,
  handleJouer as handleMeowJouer,
  handleAppelCoin as handleMeowAppelCoin,
  handleSquat as handleMeowSquat,
  handleDeplacer as handleMeowDeplacer,
  handleCombat as handleMeowCombat,
  handleJournal as handleMeowJournal,
  handleRegles as handleMeowRegles,
  handleBande as handleMeowBande,
  handleMessageSubmit as handleMeowMessageSubmit,
  buildMessageModal as buildMeowMessageModal,
} from "../handlers/meow.js";
import {
  handleTraverser as handlePontTraverser,
  handleRumeurs as handlePontRumeurs,
  handleRumeurChoix as handlePontRumeurChoix,
  handleIndice as handlePontIndice,
  handleRegles as handlePontRegles,
  handleVraiFaux as handlePontVraiFaux,
} from "../handlers/pont.js";
import { runBackground, buildDiscordWebhookUrl } from "@clash/commun/discordInteractions.js";

export async function routeJeuxSpeciaux(body, res) {
  // ── Pont du Troll : boutons du message public (nouvel éphémère) ──
  // custom_id : pont_pierre:<jour>, pont_cordes:<jour>, pont_rumeurs:<jour>,
  // pont_indice:<jour>, pont_regles
  if (body.type === 3 && typeof body.data?.custom_id === "string" && /^pont_(pierre|cordes|rumeurs|indice):\d+$|^pont_regles$/.test(body.data.custom_id)) {
    const [action, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    // Hash de l'avatar Discord (passants en image), null sans avatar
    const avatar = body.member?.user?.avatar ?? null;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "pont_regles") runBackground(() => handlePontRegles(webhookUrl));
    else if (action === "pont_rumeurs") runBackground(() => handlePontRumeurs(webhookUrl, jour, discordId));
    else if (action === "pont_indice") runBackground(() => handlePontIndice(webhookUrl, jour, discordId));
    else runBackground(() => handlePontTraverser(webhookUrl, jour, action === "pont_pierre" ? "pierre" : "cordes", discordId, username, avatar));
    return;
  }

  // ── Pont du Troll : Vrai/Faux du matin (nouvel éphémère) ──
  // custom_id : pont_vf:<jour>:vrai, pont_vf:<jour>:faux
  if (body.type === 3 && typeof body.data?.custom_id === "string" && /^pont_vf:\d+:(vrai|faux)$/.test(body.data.custom_id)) {
    const [, jour, reponse] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePontVraiFaux(webhookUrl, jour, reponse === "vrai", discordId, username));
    return;
  }

  // ── Pont du Troll : menu des rumeurs (édition en place de l'éphémère) ──
  if (body.type === 3 && typeof body.data?.custom_id === "string" && /^pont_rumeur:\d+$/.test(body.data.custom_id)) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const mode = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePontRumeurChoix(webhookUrl, jour, discordId, mode));
    return;
  }

  // ── Blackjack : bouton "Jouer" (1ʳᵉ carte du jour, sur le message public) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blackjack_jouer:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : premier clic
    // depuis le message public, crée le message éphémère "ta main".
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackJouer(webhookUrl, jour, discordId, username));
    return;
  }

  // ── Blackjack : boutons "Piocher" / "Arrêter" / "Doubler" (sur le message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("blackjack_piocher:") ||
      body.data.custom_id.startsWith("blackjack_arreter:") ||
      body.data.custom_id.startsWith("blackjack_doubler:"))
  ) {
    // `<action>:<jour>:<créneau>` (créneau absent = journée)
    const [action, jour, creneau] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché (pas de nouveau message, comme goblinhunters_target).
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const handler =
      action === "blackjack_piocher"
        ? handleBlackjackPiocher
        : action === "blackjack_doubler"
          ? handleBlackjackDoubler
          : handleBlackjackArreter;
    runBackground(() => handler(webhookUrl, jour, creneau, discordId));
    return;
  }

  // ── Blackjack : boutons "Journal" / "Règles" (éphémères) ──
  if (body.type === 3 && body.data?.custom_id === "blackjack_journal") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackJournal(webhookUrl, discordId));
    return;
  }

  if (body.type === 3 && body.data?.custom_id === "blackjack_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackRegles(webhookUrl));
    return;
  }

  // ── Gobelet : bouton "Jouer" (1ᵉʳ tirage du jour, sur le message public) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_jouer:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : premier clic
    // depuis le message public, crée le message éphémère "ta main".
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletJouer(webhookUrl, jour, discordId, username));
    return;
  }

  // ── Gobelet : boutons de sélection des dés à conserver (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_toggle:")
  ) {
    // `gobelet_toggle:<jour>:<dé>:<créneau>` (créneau absent = journée)
    const [, jour, index, creneau] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjack_piocher:/blackjack_arreter:.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletToggle(webhookUrl, jour, index, creneau, discordId));
    return;
  }

  // ── Gobelet : bouton "Relancer" (relance les dés non conservés) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_relancer:")
  ) {
    const [, jour, creneau] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletRelancer(webhookUrl, jour, creneau, discordId));
    return;
  }

  // ── Gobelet : bouton "Valider" (fige la main immédiatement si une
  // combinaison est déjà atteinte, sans attendre les 2 relances) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_valider:")
  ) {
    const [, jour, creneau] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletValider(webhookUrl, jour, creneau, discordId));
    return;
  }

  // ── Gobelet : select de choix de la combinaison (fin de main) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_choix:")
  ) {
    const [, jour, creneau] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const category = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletChoisir(webhookUrl, jour, creneau, discordId, category));
    return;
  }

  // ── Gobelet : boutons "Journal" / "Règles" (éphémères) ──
  if (body.type === 3 && body.data?.custom_id === "gobelet_journal") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletJournal(webhookUrl, discordId));
    return;
  }

  if (body.type === 3 && body.data?.custom_id === "gobelet_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletRegles(webhookUrl));
    return;
  }

  // ── Robinson : boutons d'action (vote) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("robinson_vote:")
  ) {
    const [, jour, actionId] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 éphémère : confirmation privée, le message public est mis à
    // jour séparément par un PATCH direct au salon (compteurs, projection).
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleRobinsonVote(webhookUrl, jour, actionId, discordId, username, process.env.DISCORD_TOKEN),
    );
    return;
  }

  // ── Robinson : bouton "Embarquer" (Radeau prêt) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("robinson_embarquer:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleRobinsonEmbarquer(webhookUrl, jour, discordId, process.env.DISCORD_TOKEN));
    return;
  }

  // ── Robinson : bouton "Règles du jeu" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "robinson_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleRobinsonRegles(webhookUrl));
    return;
  }

  // ── Goblin Hunters : boutons S'inscrire / Se désinscrire ──
  if (body.type === 3 && body.data?.custom_id === "goblinhunters_register") {
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersRegister(webhookUrl, discordId, username, process.env.DISCORD_TOKEN));
    return;
  }

  if (body.type === 3 && body.data?.custom_id === "goblinhunters_unregister") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersUnregister(webhookUrl, discordId, process.env.DISCORD_TOKEN));
    return;
  }

  // ── Goblin Hunters : choix de lieu (custom_id: goblinhunters_lieu:<jour>:<lieu>:<slot>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("goblinhunters_lieu:")
  ) {
    const [, jour, lieu, slot] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersLieu(webhookUrl, jour, lieu, slot, discordId, username));
    return;
  }

  // ── Goblin Hunters : confirmation du lieu (édite le message éphémère en place) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("goblinhunters_lieuok:")
  ) {
    const [, jour, lieu, slot] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersLieu(webhookUrl, jour, lieu, slot, discordId, username, true));
    return;
  }

  if (body.type === 3 && body.data?.custom_id === "goblinhunters_lieuko") {
    res.status(200).json({
      type: 7,
      data: { content: "Choix annulé — clique sur un autre lieu dans le message du jour.", components: [] },
    });
    return;
  }

  // ── Goblin Hunters : bouton "Choisir ma 2ᵉ action" (Éclaireur uniquement) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("goblinhunters_second:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersSecond(webhookUrl, jour, discordId));
    return;
  }

  // ── Goblin Hunters : select de cible (édite le message éphémère en place) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("goblinhunters_target:")
  ) {
    const [, jour, lieu, slot] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const selected = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersTarget(webhookUrl, jour, lieu, slot, discordId, username, selected));
    return;
  }

  // ── Goblin Hunters : boutons "Règles" / "Journal" (éphémères, statiques) ──
  if (body.type === 3 && body.data?.custom_id === "goblinhunters_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersRegles(webhookUrl));
    return;
  }

  if (body.type === 3 && body.data?.custom_id === "goblinhunters_journal") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersJournal(webhookUrl, discordId));
    return;
  }

  // ── Goblin Hunters : bouton "Messagerie" (mur de messages anonymes) ──
  if (body.type === 3 && body.data?.custom_id === "goblinhunters_messagerie") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersMessagerie(webhookUrl, discordId));
    return;
  }

  // ── Goblin Hunters : bouton "Écrire un message" → ouverture de la Modal ──
  // Réponse synchrone immédiate obligatoire (pas de runBackground ici) : une
  // Modal ne peut pas être différée.
  if (body.type === 3 && body.data?.custom_id === "goblinhunters_messagerie_write") {
    return res.status(200).json({ type: 9, data: buildGoblinHuntersMessagerieModal() });
  }

  // ── Goblin Hunters : soumission de la Modal Messagerie ──
  // body.type === 5 ici est un MODAL_SUBMIT (InteractionType), à ne pas
  // confondre avec le type de réponse 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
  // utilisé plus haut dans ce fichier.
  if (body.type === 5 && body.data?.custom_id === "goblinhunters_messagerie_modal") {
    const discordId = body.member?.user?.id;
    const rawMessage = body.data.components?.[0]?.components?.[0]?.value || "";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGoblinHuntersMessagerieSubmit(webhookUrl, discordId, rawMessage));
    return;
  }

  // ── Mario Clash : boutons du jour (dé / boutique / sort) ──
  // Plus de bouton "Utiliser objet" séparé : la boutique achète ET active
  // l'objet en une seule fois (voir handleBoutiqueSelect).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("marioclash_dice:") ||
      body.data.custom_id.startsWith("marioclash_boutique:") ||
      body.data.custom_id.startsWith("marioclash_spell:"))
  ) {
    const [action, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    // Hash de l'avatar Discord (pion du plateau), null sans avatar
    const avatar = body.member?.user?.avatar ?? null;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "marioclash_dice") runBackground(() => handleMarioClashDice(webhookUrl, jour, discordId, username, avatar));
    else if (action === "marioclash_boutique") runBackground(() => handleMarioClashBoutique(webhookUrl, jour, discordId, username, avatar));
    else if (action === "marioclash_spell") runBackground(() => handleMarioClashSpell(webhookUrl, jour, discordId, username, avatar));
    return;
  }

  // ── Mario Clash : confirmation du sort (custom_id: marioclash_spell_confirm:<jour>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_spell_confirm:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashSpellConfirm(webhookUrl, jour, discordId, username));
    return;
  }

  // ── Mario Clash : annulation du sort (remplace la confirmation éphémère) ──
  if (body.type === 3 && body.data?.custom_id === "marioclash_spell_cancel") {
    res.status(200).json({ type: 7, data: { content: "Sort annulé.", embeds: [], components: [] } });
    return;
  }

  // ── Mario Clash : onglet d'une fiche véhicule (custom_id: marioclash_vehicule_voir:<jour>:<action>:<véhicule>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_vehicule_voir:")
  ) {
    const [, jour, action, vehiculeId] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashVehiculeVoir(webhookUrl, jour, action, discordId, vehiculeId));
    return;
  }

  // ── Mario Clash : choix du véhicule (custom_id: marioclash_vehicule:<jour>:<action>:<véhicule>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_vehicule:")
  ) {
    const [, jour, action, vehiculeId] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashVehicule(webhookUrl, jour, action, discordId, username, vehiculeId));
    return;
  }

  // ── Mario Clash : select du type de dé (custom_id: marioclash_dice_select:<jour>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_dice_select:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const deId = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashDiceSelect(webhookUrl, jour, discordId, username, deId));
    return;
  }

  // ── Mario Clash : select d'achat boutique (custom_id: marioclash_boutique_select:<jour>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_boutique_select:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const itemId = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashBoutiqueSelect(webhookUrl, jour, discordId, username, itemId));
    return;
  }

  // ── Mario Clash : select de cible objet (custom_id: marioclash_item_target:<jour>) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("marioclash_item_target:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const selected = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashItemTarget(webhookUrl, jour, discordId, selected));
    return;
  }

  // ── Mario Clash : bouton "Journal" (classement + bilan, éphémère) ──
  if (body.type === 3 && body.data?.custom_id === "marioclash_journal") {
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashJournal(webhookUrl, discordId));
    return;
  }

  // ── Mario Clash : bouton "Règles" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "marioclash_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMarioClashRegles(webhookUrl));
    return;
  }

  // ── Qui est-ce ? : boutons du message officiel (nouvel éphémère) ──
  // custom_id : quiestce_participer (S'inscrire), quiestce_desinscrire,
  // quiestce_enqueter, quiestce_journal, quiestce_regles
  if (
    body.type === 3 &&
    ["quiestce_participer", "quiestce_desinscrire", "quiestce_enqueter", "quiestce_journal", "quiestce_regles"].includes(
      body.data?.custom_id,
    )
  ) {
    const action = body.data.custom_id;
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    // Hash de l'avatar Discord (tableau des enquêtes en image), null sans avatar
    const avatar = body.member?.user?.avatar ?? null;
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "quiestce_regles") runBackground(() => handleQuiEstCeRegles(webhookUrl));
    else if (action === "quiestce_journal") runBackground(() => handleQuiEstCeJournal(webhookUrl, discordId));
    else if (action === "quiestce_participer") runBackground(() => handleQuiEstCeParticiper(webhookUrl, discordId, username, avatar));
    else if (action === "quiestce_desinscrire") runBackground(() => handleQuiEstCeDesinscrire(webhookUrl, discordId));
    else runBackground(() => handleQuiEstCeEnqueter(webhookUrl, discordId, username, avatar));
    return;
  }

  // ── Qui est-ce ? : composants de l'éphémère, édition en place ──
  // custom_id : quiestce_question, quiestce_accuser:<n>, quiestce_objet,
  // quiestce_cible_menu (menus), quiestce_cible:<id> (bouton)
  // (boutons de navigation)
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    /^quiestce_(question|accuser|objet|cible)/.test(body.data.custom_id)
  ) {
    const [action, param] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const value = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "quiestce_question") runBackground(() => handleQuiEstCeQuestion(webhookUrl, discordId, username, value));
    else if (action === "quiestce_accuser") runBackground(() => handleQuiEstCeAccuser(webhookUrl, discordId, username, value));
    else if (action === "quiestce_objet") runBackground(() => handleQuiEstCeObjet(webhookUrl, discordId, username, value));
    else if (action === "quiestce_cible") runBackground(() => handleQuiEstCeCible(webhookUrl, discordId, username, param));
    else if (action === "quiestce_cible_menu") runBackground(() => handleQuiEstCeCible(webhookUrl, discordId, username, value));
    return;
  }

  // ── Meow : boutons du message officiel (nouvel éphémère) ──
  // custom_id : meow_participer (S'inscrire), meow_desinscrire, meow_jouer,
  // meow_bande, meow_journal, meow_regles
  if (body.type === 3 && ["meow_participer", "meow_desinscrire", "meow_jouer", "meow_bande", "meow_journal", "meow_regles"].includes(body.data?.custom_id)) {
    const action = body.data.custom_id;
    const discordId = body.member?.user?.id;
    const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "meow_regles") runBackground(() => handleMeowRegles(webhookUrl));
    else if (action === "meow_journal") runBackground(() => handleMeowJournal(webhookUrl, discordId));
    else if (action === "meow_participer") runBackground(() => handleMeowParticiper(webhookUrl, discordId, username));
    else if (action === "meow_desinscrire") runBackground(() => handleMeowDesinscrire(webhookUrl, discordId));
    else if (action === "meow_bande") runBackground(() => handleMeowBande(webhookUrl, discordId, username));
    else runBackground(() => handleMeowJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Meow : composants de l'éphémère, édition en place ──
  // custom_id : meow_appel_coin, meow_squat, meow_deplacer (menus),
  // meow_manche, meow_bout, meow_retraite, meow_vue, meow_bande_vue (boutons)
  if (body.type === 3 && typeof body.data?.custom_id === "string" && /^meow_(appel_coin|squat|deplacer|manche|bout|retraite|vue|bande_vue)/.test(body.data.custom_id)) {
    const [action, coin, n] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const value = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "meow_appel_coin") runBackground(() => handleMeowAppelCoin(webhookUrl, discordId, username, value));
    else if (action === "meow_squat") runBackground(() => handleMeowSquat(webhookUrl, discordId, username, value));
    else if (action === "meow_deplacer") runBackground(() => handleMeowDeplacer(webhookUrl, discordId, username, value));
    else if (action === "meow_vue") runBackground(() => handleMeowJouer(webhookUrl, discordId, username));
    else if (action === "meow_bande_vue") runBackground(() => handleMeowBande(webhookUrl, discordId, username));
    else runBackground(() => handleMeowCombat(webhookUrl, discordId, username, action.slice("meow_".length)));
    return;
  }

  // ── Meow : bouton « Écrire » → fenêtre de saisie ──
  // Réponse synchrone immédiate obligatoire (pas de runBackground), même
  // mécanisme que la Messagerie de Goblin Hunters.
  if (body.type === 3 && body.data?.custom_id === "meow_ecrire") {
    return res.status(200).json({ type: 9, data: buildMeowMessageModal() });
  }

  // ── Meow : envoi de la fenêtre « Écrire » (MODAL_SUBMIT) ──
  // Ouverte depuis l'éphémère « Ma bande » : type 6, la vue est rééditée en
  // place ; sinon nouvel éphémère.
  if (body.type === 5 && body.data?.custom_id === "meow_message_modal") {
    const discordId = body.member?.user?.id;
    const username = body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const texte = body.data.components?.[0]?.components?.[0]?.value || "";
    res.status(200).json(body.message ? { type: 6 } : { type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleMeowMessageSubmit(webhookUrl, discordId, username, texte));
    return;
  }
}
