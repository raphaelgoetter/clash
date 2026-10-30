// Duels autonomes (1 ou 2 joueurs) : /blackjack, /gobelet, /grille,
// /quatre, /punto et leurs boutons (blackjackduel_*, gobeletduel_*,
// grilleduel_*, quatreduel_*, puntoduel_*).
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  handleBlackjackCommand as handleBlackjackDuelCommand,
  handleBlackjackRoleRejected as handleBlackjackDuelRoleRejected,
  memberHasMiniJeuxRole as blackjackDuelMemberHasMiniJeuxRole,
  handleJouer as handleBlackjackDuelJouer,
  handlePiocher as handleBlackjackDuelPiocher,
  handleArreter as handleBlackjackDuelArreter,
  handleRegles as handleBlackjackDuelRegles,
  extractMember as extractBlackjackDuelMember,
} from "../handlers/blackjackDuel.js";
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
} from "../handlers/gobeletDuel.js";
import {
  memberHasMiniJeuxRole as grilleMemberHasMiniJeuxRole,
  extractMember as grilleExtractMember,
  handleGrilleRoleRejected,
  handleGrilleCommand,
  handleGrillePvpCommand,
  handleGrilleOuvrir,
  handleGrillePoser,
  handleGrilleRegles,
} from "../handlers/grilleDuel.js";
import {
  memberHasMiniJeuxRole as quatreMemberHasMiniJeuxRole,
  extractMember as quatreExtractMember,
  handleQuatreRoleRejected,
  handleQuatreCommand,
  handleQuatrePvpCommand,
  handleQuatreOuvrir,
  handleQuatrePoser,
  handleQuatreRegles,
  handleQuatreAbandon,
} from "../handlers/quatreDuel.js";
import {
  memberHasMiniJeuxRole as puntoMemberHasMiniJeuxRole,
  extractMember as puntoExtractMember,
  handlePuntoRoleRejected,
  handlePuntoCommand,
  handlePuntoPvpCommand,
  handlePuntoOuvrir,
  handlePuntoPoser,
  handlePuntoRegles,
  handlePuntoAbandon,
} from "../handlers/puntoDuel.js";
import { runBackground, buildDiscordWebhookUrl } from "@clash/commun/discordInteractions.js";

export async function routeDuels(body, res) {
  // ── /blackjack : lance un duel Blackjack autonome (1 ou 2 joueurs, N
  // manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX : le check se fait ici en arrière-plan
  // (getRoleIdByName fait un appel réseau, trop risqué dans la fenêtre de
  // 3s d'accusé de réception) — d'où le defer éphémère systématique, suivi
  // soit du rejet, soit du lancement réel.
  if (body.type === 2 && body.data?.name === "blackjack") {
    const joueursOpt = body.data.options?.find((o) => o.name === "joueurs");
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    // 2 joueurs au plus, comme les autres duels (ancienne commande à 3 places comprise)
    const maxPlayers = Math.min(Number(joueursOpt?.value) || 1, 2);
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

  // ── /grille adversaire:bot : La Grille contre Kévina (plateau public,
  // boutons dans une vue éphémère) ; adversaire:1v1 : contre un joueur (message public). Réservé
  // au rôle MINI-JEUX pour lancer, même principe que /blackjack ci-dessus.
  if (body.type === 2 && body.data?.name === "grille") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await grilleMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleGrilleRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleGrillePvpCommand(webhookUrl, body);
      else await handleGrilleCommand(webhookUrl, body);
    });
    return;
  }

  // ── La Grille : composants. grilleduel_poser:<colonne>[:pvp] édite la vue en
  // place ; grilleduel_ouvrir (Jouer du message public 1v1) et
  // grilleduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("grilleduel_")) {
    const [action, colonne, mode] = body.data.custom_id.split(":");
    if (action === "grilleduel_regles" || action === "grilleduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "grilleduel_regles") runBackground(() => handleGrilleRegles(webhookUrl));
      else runBackground(() => handleGrilleOuvrir(webhookUrl, body));
      return;
    }
    if (action === "grilleduel_poser") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Contre Kévina, le résultat final est publié dans le salon du clic
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: grilleExtractMember(body).username };
      runBackground(() => handleGrillePoser(webhookUrl, discordId, Number(colonne), opts));
      return;
    }
  }

  // ── /quatre adversaire:bot : Quatre à la suite contre Kévina (plateau
  // public, boutons dans une vue éphémère) ; adversaire:1v1 : contre un
  // joueur (message public).
  // Réservé au rôle MINI-JEUX pour lancer, même principe que /blackjack.
  if (body.type === 2 && body.data?.name === "quatre") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await quatreMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleQuatreRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleQuatrePvpCommand(webhookUrl, body);
      else await handleQuatreCommand(webhookUrl, body);
    });
    return;
  }

  // ── Quatre à la suite : composants. quatreduel_poser:<colonne>[:pvp]
  // édite la vue en place ; quatreduel_ouvrir (Jouer du message public 1v1)
  // et quatreduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("quatreduel_")) {
    const [action, colonne, mode] = body.data.custom_id.split(":");
    if (action === "quatreduel_regles" || action === "quatreduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "quatreduel_regles") runBackground(() => handleQuatreRegles(webhookUrl));
      else runBackground(() => handleQuatreOuvrir(webhookUrl, body));
      return;
    }
    if (action === "quatreduel_poser") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Contre Kévina, le résultat final est publié dans le salon du clic
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: quatreExtractMember(body).username };
      runBackground(() => handleQuatrePoser(webhookUrl, discordId, Number(colonne), opts));
      return;
    }
    // [🏳️] : quatreduel_abandon[:pvp] (confirmation), quatreduel_abandon_ok /
    // quatreduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { quatreduel_abandon: "demande", quatreduel_abandon_ok: "ok", quatreduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Le suffixe :pvp est en 2ᵉ position (pas de colonne)
      const opts = { pvp: colonne === "pvp", channelId: body.channel_id, pseudo: quatreExtractMember(body).username };
      runBackground(() => handleQuatreAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /punto adversaire:bot : Punto contre Kévina (plateau public, plateau
  // en boutons dans une vue éphémère) ; adversaire:1v1 : contre un joueur
  // (message public). Réservé au rôle MINI-JEUX pour lancer, même principe
  // que /blackjack.
  if (body.type === 2 && body.data?.name === "punto") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await puntoMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handlePuntoRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handlePuntoPvpCommand(webhookUrl, body);
      else await handlePuntoCommand(webhookUrl, body);
    });
    return;
  }

  // ── Punto : composants. puntoduel_poser:<case>:<coup>[:pvp] édite la vue
  // en place ; puntoduel_ouvrir (Jouer du message public 1v1) et
  // puntoduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("puntoduel_")) {
    const [action, arg, ...suite] = body.data.custom_id.split(":");
    if (action === "puntoduel_regles" || action === "puntoduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "puntoduel_regles") runBackground(() => handlePuntoRegles(webhookUrl));
      else runBackground(() => handlePuntoOuvrir(webhookUrl, body));
      return;
    }
    if (action === "puntoduel_poser") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Contre Kévina, le résultat final est publié dans le salon du clic
      const [coup, mode] = suite;
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: puntoExtractMember(body).username };
      runBackground(() => handlePuntoPoser(webhookUrl, discordId, Number(arg), Number(coup), opts));
      return;
    }
    // [🏳️] : puntoduel_abandon[:pvp] (confirmation), puntoduel_abandon_ok /
    // puntoduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { puntoduel_abandon: "demande", puntoduel_abandon_ok: "ok", puntoduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Le suffixe :pvp est en 2ᵉ position (pas de case)
      const opts = { pvp: arg === "pvp", channelId: body.channel_id, pseudo: puntoExtractMember(body).username };
      runBackground(() => handlePuntoAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /gobelet : lance un duel du Jeu du Gobelet autonome (1 ou 2 joueurs, N
  // manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX, même principe que /blackjack ci-dessus.
  if (body.type === 2 && body.data?.name === "gobelet") {
    const joueursOpt = body.data.options?.find((o) => o.name === "joueurs");
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    // 2 joueurs au plus, comme les autres duels (ancienne commande à 3 places comprise)
    const maxPlayers = Math.min(Number(joueursOpt?.value) || 1, 2);
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

  // ── Blackjack Duel : bouton "Jouer" (inscription + main, message public).
  // custom_id `blackjackduel_jouer:<partie>` (sans partie : ancien message,
  // traité comme une partie expirée).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id === "blackjackduel_jouer" || body.data.custom_id.startsWith("blackjackduel_jouer:"))
  ) {
    const gid = body.data.custom_id.split(":")[1];
    const { discordId, username } = extractBlackjackDuelMember(body);
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : crée le
    // message éphémère "ta main", comme blackjack_jouer: du jeu spécial.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelJouer(webhookUrl, gid, discordId, username));
    return;
  }

  // ── Blackjack Duel : boutons "Piocher" / "Arrêter" (message éphémère),
  // custom_id `<action>:<manche>:<partie>` ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id.startsWith("blackjackduel_piocher:") ||
      body.data.custom_id.startsWith("blackjackduel_arreter:"))
  ) {
    const [action, , gid] = body.data.custom_id.split(":");
    const { discordId } = extractBlackjackDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjack_piocher:/blackjack_arreter: existants.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const handler = action === "blackjackduel_piocher" ? handleBlackjackDuelPiocher : handleBlackjackDuelArreter;
    runBackground(() => handler(webhookUrl, gid, discordId));
    return;
  }

  // ── Blackjack Duel : bouton "Manche suivante" (message éphémère),
  // custom_id `blackjackduel_suivante:<manche>:<partie>` ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("blackjackduel_suivante:")
  ) {
    const gid = body.data.custom_id.split(":")[2];
    const { discordId, username } = extractBlackjackDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : la main de la nouvelle manche
    // remplace la précédente dans le même message éphémère.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelJouer(webhookUrl, gid, discordId, username));
    return;
  }

  // ── Blackjack Duel : bouton "Règles" (éphémère, statique) ──
  if (body.type === 3 && body.data?.custom_id === "blackjackduel_regles") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlackjackDuelRegles(webhookUrl));
    return;
  }

  // ── Gobelet Duel : bouton "Jouer" (inscription + main, message public).
  // custom_id `gobeletduel_jouer:<partie>` ; les autres boutons finissent
  // aussi par `:<partie>` (sans partie : ancien message, traité comme une
  // partie expirée).
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    (body.data.custom_id === "gobeletduel_jouer" || body.data.custom_id.startsWith("gobeletduel_jouer:"))
  ) {
    const gid = body.data.custom_id.split(":")[1];
    const { discordId, username } = extractGobeletDuelMember(body);
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (éphémère) : crée le
    // message éphémère "ta main", comme gobelet_jouer: du jeu spécial.
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelJouer(webhookUrl, gid, discordId, username));
    return;
  }

  // ── Gobelet Duel : boutons de sélection des dés à conserver (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_toggle:")
  ) {
    const [, , index, gid] = body.data.custom_id.split(":");
    const { discordId } = extractGobeletDuelMember(body);
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelToggle(webhookUrl, gid, discordId, index));
    return;
  }

  // ── Gobelet Duel : bouton "Relancer" (relance les dés non conservés) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_relancer:")
  ) {
    const gid = body.data.custom_id.split(":")[2];
    const { discordId } = extractGobeletDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : édite en place le message éphémère
    // déjà affiché, comme blackjackduel_piocher:/blackjackduel_arreter:.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelRelancer(webhookUrl, gid, discordId));
    return;
  }

  // ── Gobelet Duel : bouton "Valider" (fige la main immédiatement si une
  // combinaison est déjà atteinte, sans attendre les 2 relances) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_valider:")
  ) {
    const gid = body.data.custom_id.split(":")[2];
    const { discordId } = extractGobeletDuelMember(body);
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelValider(webhookUrl, gid, discordId));
    return;
  }

  // ── Gobelet Duel : select de choix de la combinaison (fin de main) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_choix:")
  ) {
    const gid = body.data.custom_id.split(":")[2];
    const { discordId } = extractGobeletDuelMember(body);
    const category = body.data.values?.[0];
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelChoisir(webhookUrl, gid, discordId, category));
    return;
  }

  // ── Gobelet Duel : bouton "Manche suivante" (message éphémère) ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("gobeletduel_suivante:")
  ) {
    const gid = body.data.custom_id.split(":")[2];
    const { discordId, username } = extractGobeletDuelMember(body);
    // type 6 = DEFERRED_UPDATE_MESSAGE : la main de la nouvelle manche
    // remplace la précédente dans le même message éphémère.
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleGobeletDuelJouer(webhookUrl, gid, discordId, username));
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
