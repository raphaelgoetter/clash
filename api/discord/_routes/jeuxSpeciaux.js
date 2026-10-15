// Jeux spéciaux sur 7 jours : Blackjack, Gobelet, Tamagotchi, Robinson,
// Boss Raid, Goblin Hunters, Mario Clash, Bang!, Qui est-ce ?
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  handleVoteButton as handleTamagotchiVote,
  handleRegles as handleTamagotchiRegles,
  handlePilule as handleTamagotchiPilule,
} from "../_handlers/tamagotchi.js";
import {
  handleVoteButton as handleRobinsonVote,
  handleJournal as handleRobinsonJournal,
  handleRegles as handleRobinsonRegles,
} from "../_handlers/robinson.js";
import {
  handleVoteButton as handleBossRaidVote,
  handlePrincesse as handleBossRaidPrincesse,
  handleRegles as handleBossRaidRegles,
  handleJournal as handleBossRaidJournal,
  handleTuto as handleBossRaidTuto,
} from "../_handlers/bossraid.js";
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
} from "../_handlers/goblinhunters.js";
import {
  handleDiceButton as handleMarioClashDice,
  handleDiceSelect as handleMarioClashDiceSelect,
  handleBoutiqueButton as handleMarioClashBoutique,
  handleBoutiqueSelect as handleMarioClashBoutiqueSelect,
  handleItemTargetSelect as handleMarioClashItemTarget,
  handleSpellButton as handleMarioClashSpell,
  handleSpellConfirm as handleMarioClashSpellConfirm,
  handleJournal as handleMarioClashJournal,
  handleRegles as handleMarioClashRegles,
} from "../_handlers/marioclash.js";
import {
  handleJouer as handleBangJouer,
  handlePiocher as handleBangPiocher,
  handleNbPioche as handleBangNbPioche,
  handleCarte as handleBangCarte,
  handleCible as handleBangCible,
  handlePlacer as handleBangPlacer,
  handleRegles as handleBangRegles,
  handleJournal as handleBangJournal,
} from "../_handlers/bang.js";
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
} from "../_handlers/quiestce.js";
import {
  handleJouer as handleBlackjackJouer,
  handlePiocher as handleBlackjackPiocher,
  handleArreter as handleBlackjackArreter,
  handleRegles as handleBlackjackRegles,
  handleJournal as handleBlackjackJournal,
} from "../_handlers/blackjack.js";
import {
  handleJouer as handleGobeletJouer,
  handleToggle as handleGobeletToggle,
  handleRelancer as handleGobeletRelancer,
  handleValider as handleGobeletValider,
  handleChoisir as handleGobeletChoisir,
  handleRegles as handleGobeletRegles,
  handleJournal as handleGobeletJournal,
} from "../_handlers/gobelet.js";
import { runBackground, buildDiscordWebhookUrl } from "../_lib/commun.js";

export async function routeJeuxSpeciaux(body, res) {
  // ── Tamagoshi : boutons d'action (vote) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("tamagotchi_vote:")
  ) {
    const [, jour, actionId] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : on répond
    // toujours en privé à l'auteur du clic (confirmation/rejet du vote), le
    // message public est mis à jour séparément via un PATCH direct au salon.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleTamagotchiVote(webhookUrl, jour, actionId, discordId, username, process.env.DISCORD_TOKEN),
    );
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

  // ── Blackjack : boutons "Piocher" / "Arrêter" (sur le message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("blackjack_piocher:") ||
      body.data.custom_id.startsWith("blackjack_arreter:"))
  ) {
    const [action, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché (pas de nouveau message, comme goblinhunters_target).
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const handler = action === "blackjack_piocher" ? handleBlackjackPiocher : handleBlackjackArreter;
    runBackground(() => handler(webhookUrl, jour, discordId));
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
    const [, jour, index] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjack_piocher:/blackjack_arreter:.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletToggle(webhookUrl, jour, index, discordId));
    return;
  }

  // ── Gobelet : bouton "Relancer" (relance les dés non conservés) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_relancer:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletRelancer(webhookUrl, jour, discordId));
    return;
  }

  // ── Gobelet : bouton "Valider" (fige la main immédiatement si une
  // combinaison est déjà atteinte, sans attendre les 2 relances) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_valider:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletValider(webhookUrl, jour, discordId));
    return;
  }

  // ── Gobelet : select de choix de la combinaison (fin de main) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobelet_choix:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const category = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletChoisir(webhookUrl, jour, discordId, category));
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

  // ── Tamagoshi : bouton "Règles du jeu" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "tamagotchi_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleTamagotchiRegles(webhookUrl));
    return;
  }

  // ── Tamagoshi : bouton "Pilule" (Jours 4-10, effet instantané, 1/jour + 2/manche max) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("tamagotchi_pilule:")
  ) {
    const jour = body.data.custom_id.split(":")[1];
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    // Comme tamagotchi_vote: : la Pilule mute les jauges et doit repatcher
    // le message public, elle a donc besoin du bot token.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleTamagotchiPilule(webhookUrl, jour, discordId, username, process.env.DISCORD_TOKEN),
    );
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
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : chaque
    // récolte a un résultat individuel à révéler en privé, le message public
    // est mis à jour séparément par un PATCH direct au salon (comme Tamagotchi).
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleRobinsonVote(webhookUrl, jour, actionId, discordId, username, process.env.DISCORD_TOKEN),
    );
    return;
  }

  // ── Robinson : bouton "Journal de Bord" (lecture seule, hors-vote) ──
  if (body.type === 3 && body.data?.custom_id === "robinson_journal") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleRobinsonJournal(webhookUrl));
    return;
  }

  // ── Robinson : bouton "Règles du jeu" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "robinson_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleRobinsonRegles(webhookUrl));
    return;
  }

  // ── Boss Raid : boutons de vote (Chevalier/Voleuse/Sorcier/Archères) ──
  // Vote DÉFINITIF dès qu'il est posé : type 6, édite le message public en
  // place au premier vote ; un revote envoie un followup éphémère (le
  // message public ne bouge pas) — voir handleVoteButton().
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("bossraid_vote:")
  ) {
    const [, jour, roleId] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBossRaidVote(webhookUrl, jour, roleId, discordId, username));
    return;
  }

  // ── Boss Raid : bouton Princesse — exception, réponse éphémère avec
  // projection live des dégâts du jour + événement du lendemain ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("bossraid_princesse:")
  ) {
    const [, jour] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick ||
      body.member?.user?.global_name ||
      body.member?.user?.username ||
      "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() =>
      handleBossRaidPrincesse(webhookUrl, jour, discordId, username, process.env.DISCORD_TOKEN),
    );
    return;
  }

  // ── Boss Raid : bouton "Règles & Rôles" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "bossraid_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBossRaidRegles(webhookUrl));
    return;
  }

  // ── Boss Raid : bouton "Journal" (lecture seule, hors-vote) ──
  if (body.type === 3 && body.data?.custom_id === "bossraid_journal") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBossRaidJournal(webhookUrl));
    return;
  }

  // ── Boss Raid : bouton "Tuto complet" (jour d'annonce uniquement) ──
  if (body.type === 3 && body.data?.custom_id === "bossraid_tuto") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBossRaidTuto(webhookUrl));
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
  // Réponse synchrone immédiate obligatoire (pas de runBackground ici), même
  // mécanisme que le bouton "Répondre" d'Anagram.
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
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "marioclash_dice") runBackground(() => handleMarioClashDice(webhookUrl, jour, discordId, username));
    else if (action === "marioclash_boutique") runBackground(() => handleMarioClashBoutique(webhookUrl, jour, discordId, username));
    else if (action === "marioclash_spell") runBackground(() => handleMarioClashSpell(webhookUrl, jour, discordId, username));
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

  // ── Bang! : boutons du message officiel (nouveau deck éphémère) ──
  // custom_id : bang_piocher, bang_jouer, bang_journal, bang_regles
  if (body.type === 3 && ["bang_piocher", "bang_jouer", "bang_journal", "bang_regles"].includes(body.data?.custom_id)) {
    const action = body.data.custom_id;
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "bang_regles") runBackground(() => handleBangRegles(webhookUrl));
    else if (action === "bang_journal") runBackground(() => handleBangJournal(webhookUrl, discordId));
    else if (action === "bang_piocher") runBackground(() => handleBangPiocher(webhookUrl, discordId, username));
    else runBackground(() => handleBangJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Bang! : composants du deck éphémère, édition en place ──
  // custom_id : bang_e_piocher, bang_annuler (boutons), bang_nbpioche,
  // bang_carte, bang_cible:<carte>, bang_placer (menus)
  if (body.type === 3 && typeof body.data?.custom_id === "string" && /^bang_(e_piocher|annuler|nbpioche|carte|cible:|placer)/.test(body.data.custom_id)) {
    const [action, carte] = body.data.custom_id.split(":");
    const discordId = body.member?.user?.id;
    const username =
      body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
    const value = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "bang_e_piocher") runBackground(() => handleBangPiocher(webhookUrl, discordId, username));
    else if (action === "bang_nbpioche") runBackground(() => handleBangNbPioche(webhookUrl, discordId, username, value));
    else if (action === "bang_carte") runBackground(() => handleBangCarte(webhookUrl, discordId, username, value));
    else if (action === "bang_cible") runBackground(() => handleBangCible(webhookUrl, discordId, username, carte, value));
    else if (action === "bang_placer") runBackground(() => handleBangPlacer(webhookUrl, discordId, username, value));
    else runBackground(() => handleBangJouer(webhookUrl, discordId, username));
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
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "quiestce_regles") runBackground(() => handleQuiEstCeRegles(webhookUrl));
    else if (action === "quiestce_journal") runBackground(() => handleQuiEstCeJournal(webhookUrl, discordId));
    else if (action === "quiestce_participer") runBackground(() => handleQuiEstCeParticiper(webhookUrl, discordId, username));
    else if (action === "quiestce_desinscrire") runBackground(() => handleQuiEstCeDesinscrire(webhookUrl, discordId));
    else runBackground(() => handleQuiEstCeEnqueter(webhookUrl, discordId, username));
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
}
