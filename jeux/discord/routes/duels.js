// Duels autonomes (1 ou 2 joueurs) : /blackjack, /gobelet, /grille,
// /quatre, /punto, /tourneboule, /frise, /mascarade, /bac, /pendu, Six (archivé) et leurs
// boutons (blackjackduel_*, gobeletduel_*, grilleduel_*, quatreduel_*, puntoduel_*,
// tourneboulduel_*, friseduel_*, mascaradeduel_*, bacduel_*, penduduel_*, sixduel_*).
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
import {
  memberHasMiniJeuxRole as sixMemberHasMiniJeuxRole,
  extractMember as sixExtractMember,
  handleSixRoleRejected,
  handleSixCommand,
  handleSixPvpCommand,
  handleSixOuvrir,
  handleSixJouer,
  handleSixRegles,
  handleSixAbandon,
} from "../handlers/sixDuel.js";
import {
  memberHasMiniJeuxRole as tourneboulMemberHasMiniJeuxRole,
  extractMember as tourneboulExtractMember,
  handleTournebouleRoleRejected,
  handleTournebouleCommand,
  handleTourneboulePvpCommand,
  handleTournebouleOuvrir,
  handleTourneboulePoser,
  handleTournebouleRegles,
  handleTournebouleAbandon,
} from "../handlers/tourneboulDuel.js";
import {
  memberHasMiniJeuxRole as friseMemberHasMiniJeuxRole,
  extractMember as friseExtractMember,
  handleFriseRoleRejected,
  handleFriseCommand,
  handleFrisePvpCommand,
  handleFriseOuvrir,
  handleFrisePlacer,
  handleFriseChoisir,
  handleFriseRegles,
  handleFriseAbandon,
} from "../handlers/friseDuel.js";
import {
  memberHasMiniJeuxRole as mascaradeMemberHasMiniJeuxRole,
  extractMember as mascaradeExtractMember,
  handleMascaradeRoleRejected,
  handleMascaradeCommand,
  handleMascaradePvpCommand,
  handleMascaradeOuvrir,
  handleMascaradeAction,
  handleMascaradeRegles,
  handleMascaradeAbandon,
} from "../handlers/mascaradeDuel.js";
import {
  memberHasMiniJeuxRole as bacMemberHasMiniJeuxRole,
  extractMember as bacExtractMember,
  buildModalMot as buildBacModalMot,
  handleBacRoleRejected,
  handleBacCommand,
  handleBacPvpCommand,
  handleBacOuvrir,
  handleBacMot,
  handleBacAction,
  handleBacRegles,
  handleBacAbandon,
} from "../handlers/bacDuel.js";
import {
  memberHasMiniJeuxRole as penduMemberHasMiniJeuxRole,
  buildModalMot as buildPenduModalMot,
  handlePenduRoleRejected,
  handlePenduSoloCommand,
  handlePenduPvpCommand,
  handlePenduOuvrir,
  handlePenduLettre,
  handlePenduMot,
  handlePenduRegles,
  handlePenduAbandon,
  handlePenduGeneratorCommand,
} from "../handlers/penduDuel.js";
import { runBackground, buildDiscordWebhookUrl } from "@clash/commun/discordInteractions.js";

// /blackjack et /gobelet : `adversaire:bot|1v1` comme les autres duels ;
// repli sur l'ancienne option `joueurs:1|2` (bornée à 2) tant que les
// commandes ne sont pas ré-enregistrées.
function nombreDeJoueurs(body) {
  const adversaire = body.data.options?.find((o) => o.name === "adversaire")?.value;
  if (adversaire) return adversaire === "1v1" ? 2 : 1;
  const joueurs = body.data.options?.find((o) => o.name === "joueurs")?.value;
  return Math.min(Number(joueurs) || 1, 2);
}

export async function routeDuels(body, res) {
  // ── /blackjack : lance un duel Blackjack autonome (contre Kévina ou à
  // 2 joueurs, N manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX : le check se fait ici en arrière-plan
  // (getRoleIdByName fait un appel réseau, trop risqué dans la fenêtre de
  // 3s d'accusé de réception) — d'où le defer éphémère systématique, suivi
  // soit du rejet, soit du lancement réel.
  if (body.type === 2 && body.data?.name === "blackjack") {
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    const maxPlayers = nombreDeJoueurs(body);
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

  // ── /six adversaire:bot : Six contre Kévina (plateau public, plateau et
  // boutons de coup dans une vue éphémère) ; adversaire:1v1 : contre un
  // joueur (message public). Réservé au rôle MINI-JEUX pour lancer, même
  // principe que /blackjack.
  if (body.type === 2 && body.data?.name === "six") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await sixMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleSixRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleSixPvpCommand(webhookUrl, body);
      else await handleSixCommand(webhookUrl, body);
    });
    return;
  }

  // ── Six : composants. sixduel_jouer:<colonne>:<vue>[:pvp] édite la vue
  // en place ; sixduel_ouvrir (Jouer du message public 1v1) et
  // sixduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("sixduel_")) {
    const [action, arg, ...suite] = body.data.custom_id.split(":");
    if (action === "sixduel_regles" || action === "sixduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "sixduel_regles") runBackground(() => handleSixRegles(webhookUrl));
      else runBackground(() => handleSixOuvrir(webhookUrl, body));
      return;
    }
    if (action === "sixduel_jouer") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Contre Kévina, le résultat final est publié dans le salon du clic
      const [coup, mode] = suite;
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: sixExtractMember(body).username };
      runBackground(() => handleSixJouer(webhookUrl, discordId, Number(arg), Number(coup), opts));
      return;
    }
    // [🏳️] : sixduel_abandon[:pvp] (confirmation), sixduel_abandon_ok /
    // sixduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { sixduel_abandon: "demande", sixduel_abandon_ok: "ok", sixduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Le suffixe :pvp est en 2ᵉ position
      const opts = { pvp: arg === "pvp", channelId: body.channel_id, pseudo: sixExtractMember(body).username };
      runBackground(() => handleSixAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /tourneboule adversaire:bot : Tourneboule contre Kévina (plateau
  // public, plateau en boutons dans une vue éphémère) ; adversaire:1v1 :
  // contre un joueur (message public). Réservé au rôle MINI-JEUX pour
  // lancer, même principe que /blackjack.
  if (body.type === 2 && body.data?.name === "tourneboule") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await tourneboulMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleTournebouleRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleTourneboulePvpCommand(webhookUrl, body);
      else await handleTournebouleCommand(webhookUrl, body);
    });
    return;
  }

  // ── Tourneboule : composants. tourneboulduel_poser:<case>:<vue>[:pvp]
  // édite la vue en place ; tourneboulduel_ouvrir (Jouer du message public
  // 1v1) et tourneboulduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("tourneboulduel_")) {
    const [action, arg, ...suite] = body.data.custom_id.split(":");
    if (action === "tourneboulduel_regles" || action === "tourneboulduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "tourneboulduel_regles") runBackground(() => handleTournebouleRegles(webhookUrl));
      else runBackground(() => handleTournebouleOuvrir(webhookUrl, body));
      return;
    }
    if (action === "tourneboulduel_poser") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Contre Kévina, le résultat final est publié dans le salon du clic
      const [vue, mode] = suite;
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: tourneboulExtractMember(body).username };
      runBackground(() => handleTourneboulePoser(webhookUrl, discordId, Number(arg), Number(vue), opts));
      return;
    }
    // [🏳️] : tourneboulduel_abandon[:pvp] (confirmation), tourneboulduel_abandon_ok /
    // tourneboulduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { tourneboulduel_abandon: "demande", tourneboulduel_abandon_ok: "ok", tourneboulduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // Le suffixe :pvp est en 2ᵉ position
      const opts = { pvp: arg === "pvp", channelId: body.channel_id, pseudo: tourneboulExtractMember(body).username };
      runBackground(() => handleTournebouleAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /frise adversaire:bot : Frise contre Kévina (frise publique, menus
  // de jeu dans une vue éphémère) ; adversaire:1v1 : contre un joueur
  // (message public). Réservé au rôle MINI-JEUX pour lancer.
  if (body.type === 2 && body.data?.name === "frise") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await friseMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleFriseRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleFrisePvpCommand(webhookUrl, body);
      else await handleFriseCommand(webhookUrl, body);
    });
    return;
  }

  // ── Frise : composants. Menus friseduel_carte:<vue>[:pvp] et
  // friseduel_placer:<vue>:<k>[:pvp] (valeur choisie dans data.values),
  // édités en place ; friseduel_ouvrir et friseduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("friseduel_")) {
    const [action, arg, ...suite] = body.data.custom_id.split(":");
    if (action === "friseduel_regles" || action === "friseduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "friseduel_regles") runBackground(() => handleFriseRegles(webhookUrl));
      else runBackground(() => handleFriseOuvrir(webhookUrl, body));
      return;
    }
    if (action === "friseduel_carte" || action === "friseduel_placer") {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      const valeur = Number(body.data.values?.[0]);
      const pvp = suite.includes("pvp");
      if (action === "friseduel_carte") {
        runBackground(() => handleFriseChoisir(webhookUrl, discordId, valeur, Number(arg), { pvp }));
      } else {
        // Contre Kévina, le résultat final est publié dans le salon du choix
        const opts = { pvp, channelId: body.channel_id, pseudo: friseExtractMember(body).username };
        runBackground(() => handleFrisePlacer(webhookUrl, discordId, valeur, Number(arg), opts));
      }
      return;
    }
    // [🏳️] : friseduel_abandon[:pvp] (confirmation), friseduel_abandon_ok /
    // friseduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { friseduel_abandon: "demande", friseduel_abandon_ok: "ok", friseduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      const opts = { pvp: arg === "pvp", channelId: body.channel_id, pseudo: friseExtractMember(body).username };
      runBackground(() => handleFriseAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /mascarade adversaire:bot : Mascarade contre Kévina (table publique,
  // main et boutons dans une vue éphémère) ; adversaire:1v1 : contre un
  // joueur (message public). Réservé au rôle MINI-JEUX pour lancer.
  if (body.type === 2 && body.data?.name === "mascarade") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      const allowed = await mascaradeMemberHasMiniJeuxRole(body);
      if (!allowed) {
        await handleMascaradeRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleMascaradePvpCommand(webhookUrl, body);
      else await handleMascaradeCommand(webhookUrl, body);
    });
    return;
  }

  // ── Mascarade : composants. mascaradeduel_<jouer|bdf|choix>:<arg>:<vue>[:pvp]
  // et mascaradeduel_<retour|suivante>:<vue>[:pvp] éditent la vue en place ;
  // mascaradeduel_ouvrir (Jouer du message public 1v1) et mascaradeduel_regles :
  // nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("mascaradeduel_")) {
    const [action, ...args] = body.data.custom_id.split(":");
    if (action === "mascaradeduel_regles" || action === "mascaradeduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "mascaradeduel_regles") runBackground(() => handleMascaradeRegles(webhookUrl));
      else runBackground(() => handleMascaradeOuvrir(webhookUrl, body));
      return;
    }
    const TYPES = { mascaradeduel_jouer: "jouer", mascaradeduel_bdf: "bdf", mascaradeduel_choix: "choix", mascaradeduel_retour: "retour", mascaradeduel_suivante: "suivante" };
    if (TYPES[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      // retour et suivante n'ont pas d'argument : <vue>[:pvp] directement
      const [arg, vue, mode] = action === "mascaradeduel_retour" || action === "mascaradeduel_suivante" ? [null, ...args] : args;
      const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: mascaradeExtractMember(body).username };
      runBackground(() => handleMascaradeAction(webhookUrl, discordId, TYPES[action], arg, Number(vue), opts));
      return;
    }
    // [🏳️] : mascaradeduel_abandon[:pvp] (confirmation), mascaradeduel_abandon_ok /
    // mascaradeduel_abandon_non[:pvp], tous édités en place
    const ETAPES_ABANDON = { mascaradeduel_abandon: "demande", mascaradeduel_abandon_ok: "ok", mascaradeduel_abandon_non: "non" };
    if (ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      const opts = { pvp: args[0] === "pvp", channelId: body.channel_id, pseudo: mascaradeExtractMember(body).username };
      runBackground(() => handleMascaradeAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /bac adversaire:bot : Petit Bac contre Kévina (table publique, vue
  // éphémère) ; adversaire:1v1 : contre un joueur. Réservé au rôle MINI-JEUX
  // pour lancer.
  if (body.type === 2 && body.data?.name === "bac") {
    const pvp = body.data.options?.find((o) => o.name === "adversaire")?.value === "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      if (!(await bacMemberHasMiniJeuxRole(body))) {
        await handleBacRoleRejected(webhookUrl);
        return;
      }
      if (pvp) await handleBacPvpCommand(webhookUrl, body);
      else await handleBacCommand(webhookUrl, body);
    });
    return;
  }

  // ── Petit Bac : fenêtre de saisie soumise (body.type 5 = MODAL_SUBMIT,
  // à ne pas confondre avec la réponse de type 5) : bacduel_mot:<manche>[:pvp],
  // vue éditée en place (réponse 6, la fenêtre vient d'un bouton de la vue)
  if (body.type === 5 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("bacduel_mot:")) {
    const [, manche, mode] = body.data.custom_id.split(":");
    const mot = body.data.components?.[0]?.components?.[0]?.value ?? "";
    const discordId = body.member?.user?.id;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const opts = { pvp: mode === "pvp", channelId: body.channel_id, pseudo: bacExtractMember(body).username };
    runBackground(() => handleBacMot(webhookUrl, discordId, Number(manche), mot, opts));
    return;
  }

  // ── Petit Bac : composants. bacduel_proposer:<manche>:<thème>:<lettre>[:pvp]
  // ouvre la fenêtre de saisie (réponse synchrone 9, sans rien lire) ;
  // bacduel_<passer|suivante|contester>:<manche>[:pvp] et l'abandon éditent la vue en
  // place ; bacduel_ouvrir (Jouer du 1v1) et bacduel_regles : nouvel éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("bacduel_")) {
    const [action, ...args] = body.data.custom_id.split(":");
    if (action === "bacduel_proposer") {
      const [manche, theme, lettre, mode] = args;
      return res.status(200).json({ type: 9, data: buildBacModalMot(manche, theme, lettre, mode === "pvp") });
    }
    if (action === "bacduel_regles" || action === "bacduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "bacduel_regles") runBackground(() => handleBacRegles(webhookUrl));
      else runBackground(() => handleBacOuvrir(webhookUrl, body));
      return;
    }
    const TYPES = { bacduel_passer: "passer", bacduel_suivante: "suivante", bacduel_contester: "contester" };
    const ETAPES_ABANDON = { bacduel_abandon: "demande", bacduel_abandon_ok: "ok", bacduel_abandon_non: "non" };
    if (TYPES[action] || ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      const pvp = args.at(-1) === "pvp";
      const opts = { pvp, channelId: body.channel_id, pseudo: bacExtractMember(body).username };
      if (TYPES[action]) runBackground(() => handleBacAction(webhookUrl, discordId, TYPES[action], Number(args[0]), opts));
      else runBackground(() => handleBacAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      return;
    }
  }

  // ── /pendu mode:solo|1v1 : Pendu seul, ou en 1v1 (même mot pour les
  // deux, chacun de son côté). Réservé au rôle MINI-JEUX pour lancer.
  if (body.type === 2 && body.data?.name === "pendu") {
    const solo = body.data.options?.find((o) => o.name === "mode")?.value !== "1v1";
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      if (!(await penduMemberHasMiniJeuxRole(body))) {
        await handlePenduRoleRejected(webhookUrl);
        return;
      }
      if (solo) await handlePenduSoloCommand(webhookUrl, body);
      else await handlePenduPvpCommand(webhookUrl, body);
    });
    return;
  }

  // ── /pendu-generator mot resultat [erreurs] [lettres] : image finale
  // d'une partie fictive, postée par Kévina. Réservé au rôle MINI-JEUX.
  if (body.type === 2 && body.data?.name === "pendu-generator") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(async () => {
      if (!(await penduMemberHasMiniJeuxRole(body))) {
        await handlePenduRoleRejected(webhookUrl);
        return;
      }
      await handlePenduGeneratorCommand(webhookUrl, body);
    });
    return;
  }

  // ── Pendu : fenêtre de saisie soumise (body.type 5 = MODAL_SUBMIT),
  // vue éditée en place (réponse 6, la fenêtre vient d'un bouton de la vue)
  if (body.type === 5 && typeof body.data?.custom_id === "string" && body.data.custom_id.split(":")[0] === "penduduel_mot") {
    const mot = body.data.components?.[0]?.components?.[0]?.value ?? "";
    const discordId = body.member?.user?.id;
    const solo = body.data.custom_id.endsWith(":solo");
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handlePenduMot(webhookUrl, discordId, mot, { solo }));
    return;
  }

  // ── Pendu : composants (suffixe `:solo` : partie solo de celui qui
  // clique, sinon le 1v1). penduduel_proposer ouvre la fenêtre de saisie
  // (réponse synchrone 9, sans rien lire) ; penduduel_lettre:<lettre>
  // (voyelles), penduduel_consonne (menu) et l'abandon éditent la vue en
  // place ; penduduel_ouvrir (Jouer / Reprendre ma partie) et penduduel_regles : nouvel
  // éphémère.
  if (body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("penduduel_")) {
    const [action, ...args] = body.data.custom_id.split(":");
    const solo = args.at(-1) === "solo";
    const opts = { solo };
    if (action === "penduduel_proposer") return res.status(200).json({ type: 9, data: buildPenduModalMot(solo) });
    if (action === "penduduel_regles" || action === "penduduel_ouvrir") {
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (action === "penduduel_regles") runBackground(() => handlePenduRegles(webhookUrl));
      else runBackground(() => handlePenduOuvrir(webhookUrl, body, opts));
      return;
    }
    const ETAPES_ABANDON = { penduduel_abandon: "demande", penduduel_abandon_ok: "ok", penduduel_abandon_non: "non" };
    if (action === "penduduel_lettre" || action === "penduduel_consonne" || ETAPES_ABANDON[action]) {
      const discordId = body.member?.user?.id;
      res.status(200).json({ type: 6 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      if (ETAPES_ABANDON[action]) runBackground(() => handlePenduAbandon(webhookUrl, discordId, ETAPES_ABANDON[action], opts));
      else runBackground(() => handlePenduLettre(webhookUrl, discordId, action === "penduduel_lettre" ? args[0] : body.data.values?.[0], opts));
      return;
    }
  }

  // ── /gobelet : lance un duel du Jeu du Gobelet autonome (1 ou 2 joueurs, N
  // manches) — jeu développé en parallèle du jeu spécial, sans lien avec
  // lui. Réservé au rôle MINI-JEUX, même principe que /blackjack ci-dessus.
  if (body.type === 2 && body.data?.name === "gobelet") {
    const manchesOpt = body.data.options?.find((o) => o.name === "manches");
    const maxPlayers = nombreDeJoueurs(body);
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
