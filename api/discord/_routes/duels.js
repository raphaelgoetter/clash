// Duels autonomes (1-3 joueurs) : /blackjack, /bang, /gobelet et leurs
// boutons (blackjackduel_*, bangduel_*, gobeletduel_*).
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  memberHasMiniJeuxRole as bangDuelMemberHasMiniJeuxRole,
  extractMember as bangDuelExtractMember,
  handleBangDuelRoleRejected,
  handleBangDuelCommand,
  handleBangDuelPiocher,
  handleBangDuelPlacer,
  handleBangDuelCarte,
  handleBangDuelRegles,
  handleBangDuelPvpCommand,
  handleBangDuelOuvrir,
} from "../_handlers/bangDuel.js";
import {
  handleBlackjackCommand as handleBlackjackDuelCommand,
  handleBlackjackRoleRejected as handleBlackjackDuelRoleRejected,
  memberHasMiniJeuxRole as blackjackDuelMemberHasMiniJeuxRole,
  handleJouer as handleBlackjackDuelJouer,
  handlePiocher as handleBlackjackDuelPiocher,
  handleArreter as handleBlackjackDuelArreter,
  handleRegles as handleBlackjackDuelRegles,
  extractMember as extractBlackjackDuelMember,
} from "../_handlers/blackjackDuel.js";
import {
  handleGobeletCommand as handleGobeletDuelCommand,
  handleGobeletRoleRejected as handleGobeletDuelRoleRejected,
  memberHasMiniJeuxRole as gobeletDuelMemberHasMiniJeuxRole,
  handleJouer as handleGobeletDuelJouer,
  handleToggle as handleGobeletDuelToggle,
  handleRelancer as handleGobeletDuelRelancer,
  handleValider as handleGobeletDuelValider,
  handleChoisir as handleGobeletDuelChoisir,
  handleRegles as handleGobeletDuelRegles,
  extractMember as extractGobeletDuelMember,
} from "../_handlers/gobeletDuel.js";
import { runBackground, buildDiscordWebhookUrl } from "../_lib/commun.js";

export async function routeDuels(body, res) {
  // ── /blackjack : lance un duel Blackjack autonome (1-3 joueurs, N
  // manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX : le check se fait ici en arrière-plan
  // (getRoleIdByName fait un appel réseau, trop risqué dans la fenêtre de
  // 3s d'accusé de réception) — d'où le defer éphémère systématique, suivi
  // soit du rejet, soit du lancement réel.
  if (body.type === 2 && body.data?.name === "blackjack") {
    const joueursOpt = body.data.options?.find((o) => o.name === "joueurs");
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    const maxPlayers = Number(joueursOpt?.value) || 1;
    const totalManches = Number(manchesOpt?.value) || 5;

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await blackjackDuelMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleBlackjackDuelRoleRejected(webhookUrl);
        return;
      }
      await handleBlackjackDuelCommand(webhookUrl, body, { maxPlayers, totalManches });
    });
    return;
  }

  // ── /bang adversaire:bot : Bang! Duel contre Kévina (partie privée, éphémère) ;
  // adversaire:1v1 : contre un joueur (message public). Réservé au rôle MINI-JEUX pour lancer,
  // même principe que /blackjack ci-dessus.
  if (body.type === 2 && body.data?.name === "bang") {
    const discordId = body.member?.user?.id;
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await bangDuelMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleBangDuelRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleBangDuelPvpCommand(webhookUrl, body);
      else await handleBangDuelCommand(webhookUrl, discordId);
    });
    return;
  }

  // ── Bang! Duel : composants des messages (édition en place) ──
  // custom_id : bangduel_<action> contre Kévina, bangduel_<action>:pvp en
  // 1v1 ; actions : piocher (bouton), carte,
  // placer (menus). bangduel_ouvrir (Jouer du message public 1v1) et
  // bangduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("bangduel_")) {
    const [action, mode] = body.data.custom_id.split(":");
    const pvp = mode === "pvp";
    const discordId = body.member?.user?.id;
    const value = body.data.values?.[0];
    // Salon et pseudo : contre Kévina, le résultat final y est publié
    const channelId = body.channel_id;
    const pseudo = bangDuelExtractMember(body).username;
    if (action === "bangduel_regles" || action === "bangduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "bangduel_regles") runBackground(() => handleBangDuelRegles(webhookUrl));
      else runBackground(() => handleBangDuelOuvrir(webhookUrl, body));
      return;
    }
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (action === "bangduel_piocher") runBackground(() => handleBangDuelPiocher(webhookUrl, discordId, { pvp, channelId, pseudo }));
    else if (action === "bangduel_placer") runBackground(() => handleBangDuelPlacer(webhookUrl, discordId, value, { pvp, channelId, pseudo }));
    else if (action === "bangduel_carte") runBackground(() => handleBangDuelCarte(webhookUrl, discordId, value, { pvp, channelId, pseudo }));
    return;
  }

  // ── /gobelet : lance un duel du Jeu du Gobelet autonome (1-3 joueurs, N
  // manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX, même principe que /blackjack ci-dessus.
  if (body.type === 2 && body.data?.name === "gobelet") {
    const joueursOpt = body.data.options?.find((o) => o.name === "joueurs");
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    const maxPlayers = Number(joueursOpt?.value) || 1;
    const totalManches = Number(manchesOpt?.value) || 5;

    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await gobeletDuelMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleGobeletDuelRoleRejected(webhookUrl);
        return;
      }
      await handleGobeletDuelCommand(webhookUrl, body, { maxPlayers, totalManches });
    });
    return;
  }

  // ── Blackjack Duel : bouton "Jouer" (inscription + main, message public) ──
  if (body.type === 3 && body.data?.custom_id === "blackjackduel_jouer") {
    const { discordId, username } = extractBlackjackDuelMember(body);
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : crée le
    // message éphémère "ta main", comme blackjack_jouer: du jeu spécial.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Blackjack Duel : boutons "Piocher" / "Arrêter" (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("blackjackduel_piocher:") ||
      body.data.custom_id.startsWith("blackjackduel_arreter:"))
  ) {
    const [action] = body.data.custom_id.split(":");
    const { discordId } = extractBlackjackDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjack_piocher:/blackjack_arreter: existants.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const handler = action === "blackjackduel_piocher" ? handleBlackjackDuelPiocher : handleBlackjackDuelArreter;
    runBackground(() => handler(webhookUrl, discordId));
    return;
  }

  // ── Blackjack Duel : bouton "Manche suivante" (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blackjackduel_suivante:")
  ) {
    const { discordId, username } = extractBlackjackDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : la main de la nouvelle manche
    // remplace la précédente dans le même message éphémère.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Blackjack Duel : bouton "Règles" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "blackjackduel_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelRegles(webhookUrl));
    return;
  }

  // ── Gobelet Duel : bouton "Jouer" (inscription + main, message public) ──
  if (body.type === 3 && body.data?.custom_id === "gobeletduel_jouer") {
    const { discordId, username } = extractGobeletDuelMember(body);
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : crée le
    // message éphémère "ta main", comme gobelet_jouer: du jeu spécial.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Gobelet Duel : boutons de sélection des dés à conserver (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_toggle:")
  ) {
    const [, , index] = body.data.custom_id.split(":");
    const { discordId } = extractGobeletDuelMember(body);
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelToggle(webhookUrl, discordId, index));
    return;
  }

  // ── Gobelet Duel : bouton "Relancer" (relance les dés non conservés) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_relancer:")
  ) {
    const { discordId } = extractGobeletDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjackduel_piocher:/blackjackduel_arreter:.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelRelancer(webhookUrl, discordId));
    return;
  }

  // ── Gobelet Duel : bouton "Valider" (fige la main immédiatement si une
  // combinaison est déjà atteinte, sans attendre les 2 relances) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_valider:")
  ) {
    const { discordId } = extractGobeletDuelMember(body);
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelValider(webhookUrl, discordId));
    return;
  }

  // ── Gobelet Duel : select de choix de la combinaison (fin de main) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_choix:")
  ) {
    const { discordId } = extractGobeletDuelMember(body);
    const category = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelChoisir(webhookUrl, discordId, category));
    return;
  }

  // ── Gobelet Duel : bouton "Manche suivante" (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_suivante:")
  ) {
    const { discordId, username } = extractGobeletDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : la main de la nouvelle manche
    // remplace la précédente dans le même message éphémère.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelJouer(webhookUrl, discordId, username));
    return;
  }

  // ── Gobelet Duel : bouton "Règles" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "gobeletduel_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelRegles(webhookUrl));
    return;
  }
}
