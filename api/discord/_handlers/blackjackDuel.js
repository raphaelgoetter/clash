// ============================================================
// blackjackDuel.js — Handlers Discord pour le Blackjack duel autonome
// (1 à 3 joueurs, N manches), lancé à la demande via /blackjack.
//
// Développé EN PARALLÈLE du jeu spécial (_handlers/blackjack.js), sans
// aucun impact dessus : custom_id préfixés `blackjackduel_*` (jamais
// `blackjack_*`), état Redis dans backend/services/blackjackDuel.js
// (`blackjackduel:*`), aucun import du service du jeu spécial.
//
// Contrairement au jeu spécial, le message public est ÉDITÉ EN PLACE à
// chaque avancée (jamais supprimé/reposté) : il n'y a pas de "jour" qui
// change, seulement des manches qui s'enchaînent en direct.
// ============================================================

import {
  writeState,
  startGame,
  joinAndDeal,
  drawOrStand,
  checkAndResolveManche,
  listHands,
  isDealerRevealed,
  pointsForResult,
} from "../../../backend/services/blackjackDuel.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const BLACKJACKDUEL_COLOR = 0x2ecc71;

// ── Cartes — rendu texte (dupliqué depuis _handlers/blackjack.js : pas de
// dépendance croisée entre les deux jeux) ──────────────────────────

function formatCard(card) {
  return `${card.rank}${card.suit}`;
}

function formatCards(cards) {
  return cards.map(formatCard).join(" ");
}

function formatCardsBlock(cards, scoreLabel = null) {
  const lines = [`# ${formatCards(cards)}`];
  if (scoreLabel) lines.push(`**${scoreLabel}**`);
  return lines;
}

function formatDealerLine(dealer) {
  return `🎩 **Croupier :** ${formatCards(dealer.cards)} (**${dealer.score}**)`;
}

// ── Résolution des rôles/utilisateurs ────────────────────────────────

function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick ||
    body.member?.user?.global_name ||
    body.member?.user?.username ||
    "Inconnu";
  return { discordId, username };
}

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

// ── Édition en place (réponses aux interactions) ──────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[BlackjackDuel] Échec PATCH:", err.message);
  }
}

async function patchPublicMessage(state, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId || !state?.messageId) return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      console.warn(
        `[BlackjackDuel] Échec édition du message public (${res.status}).`,
      );
    }
  } catch (err) {
    console.warn(
      "[BlackjackDuel] Erreur réseau à l'édition du message public:",
      err.message,
    );
  }
}

// ── Embed / composants du message public ──────────────────────────

// Jamais désactivé : le bouton "Jouer" sert aussi aux joueurs déjà inscrits
// pour recevoir leur main de la manche courante (à chaque manche). Le refus
// d'un NOUVEAU joueur une fois les inscriptions verrouillées est géré
// côté serveur (joinAndDeal) avec un message de rejet éphémère, pas en
// désactivant le bouton pour tout le monde.
function buildJoinComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Jouer",
          emoji: { name: "🃏" },
          custom_id: "blackjackduel_jouer",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "blackjackduel_regles",
        },
      ],
    },
  ];
}

async function buildPendingLabel(state, hands) {
  const pendingIds = state.players.filter(
    (id) => !hands[id] || hands[id].status === "en_cours",
  );
  const missingSeats = state.maxPlayers - state.players.length;
  const lines = [];
  if (pendingIds.length > 0) {
    const names = await Promise.all(
      pendingIds.map((id) => resolveDisplayName(id, hands[id]?.username)),
    );
    lines.push(
      `⏳ ${names.length > 1 ? "Doivent" : "Doit"} encore jouer cette manche : ${names.join(", ")}`,
    );
  }
  // Roster incomplet : la manche attend les places libres avant d'être
  // résolue (voir isMancheReady côté service).
  if (missingSeats > 0) {
    lines.push(
      `⏳ En attente de ${missingSeats} joueur${missingSeats > 1 ? "s" : ""} supplémentaire${missingSeats > 1 ? "s" : ""}`,
    );
  }
  if (lines.length === 0) return "Tout le monde a joué, résolution en cours…";
  return lines.join("\n");
}

async function buildTableEmbed(state, { previousResults, previousDealer } = {}) {
  const hands = await listHands(state.manche);
  const lines = [];
  const isSolo = state.maxPlayers === 1;

  if (previousResults) {
    if (isSolo) {
      const winners = previousResults.filter((r) => r.result === "win");
      const winnerNames = await Promise.all(
        winners.map((w) => resolveDisplayName(w.discordId, w.username)),
      );
      lines.push(
        `**📊 Bilan de la manche ${state.manche - 1}**`,
        formatDealerLine(previousDealer),
        winnerNames.length
          ? `🏆 Gagnant${winnerNames.length > 1 ? "s" : ""} : ${winnerNames.join(", ")}`
          : "🏆 Personne n'a battu le Croupier.",
        "",
      );
    } else {
      const winners = previousResults.filter((r) => r.result === "win" || r.result === "push");
      const winnerNames = await Promise.all(
        winners.map((w) => resolveDisplayName(w.discordId, w.username)),
      );
      lines.push(
        `**📊 Bilan de la manche ${state.manche - 1}**`,
        winnerNames.length
          ? `🏆 Vainqueur${winnerNames.length > 1 ? "s" : ""} de la manche : ${winnerNames.join(", ")}`
          : "🏆 Personne n'a de main valide sur cette manche.",
        "",
      );
    }
  }

  // Pas de "Manche X/Y" ici : déjà dans le titre de l'embed (buildTableEmbed
  // est utilisé pour le body) — même principe que buildDealerTargetSection
  // du jeu spécial (_handlers/blackjack.js), qui n'affiche pas non plus le
  // "Jour X/Y" en double dans son propre corps de message.
  const seatsLabel = `${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}`;
  if (!isSolo) {
    // 2-3 joueurs : pas de Croupier — duel direct, résultat connu dès que
    // tous les joueurs inscrits ont fini leur main.
    lines.push(
      "## 🃏 Duel entre joueurs — pas de Croupier",
      "La meilleure main l'emporte. Résultat révélé dès que tout le monde a joué.",
      "",
      seatsLabel,
    );
  } else if (isDealerRevealed(state.manche)) {
    // Manches impaires : le Croupier joue en premier, score révélé tout de
    // suite. Manches paires (15/09, retour utilisateur, même mécanique que le
    // jeu spécial) : le Croupier joue en second, après tous les joueurs —
    // révélé seulement à la résolution de la manche.
    lines.push(
      `## 🎩 Score à battre : ${state.dealer.score}`,
      ...formatCardsBlock(state.dealer.cards),
      "",
      seatsLabel,
    );
  } else {
    lines.push(
      "## 🎩 Le Croupier joue en second cette manche",
      "Il n'a pas encore joué sa main — il jouera après tous les joueurs, résultat révélé à la fin de la manche.",
      "",
      seatsLabel,
    );
  }

  if (state.players.length > 0) {
    lines.push(await buildPendingLabel(state, hands));
  } else {
    lines.push("Clique sur **Jouer** pour t'inscrire et jouer ta première main.");
  }

  return {
    title: `🃏 Blackjack Duel — Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n"),
    color: BLACKJACKDUEL_COLOR,
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes — la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

// Une ligne par manche : main + score de chaque joueur, et points gagnés —
// le Croupier n'apparaît que sur les manches solo (mancheRecord.dealer est
// null en duel 2-3 joueurs, voir resolveManche côté service).
async function buildMancheHistoryBlocks(history) {
  const blocks = [];
  for (const entry of history) {
    const header = entry.dealer
      ? `**Manche ${entry.manche}** — ${formatDealerLine(entry.dealer)}`
      : `**Manche ${entry.manche}**`;
    const playerParts = await Promise.all(
      entry.results.map(async (r) => {
        const name = await resolveDisplayName(r.discordId, r.username);
        const pts = pointsForResult(r.result);
        const scoreLabel = r.status === "bust" ? "💥" : `${r.score}`;
        const badge = pts === 2 ? " 🏆" : pts === 1 ? " 🤝" : "";
        return `${name} ${formatCards(r.cards)} (${scoreLabel})${badge} +${pts} pt${pts > 1 ? "s" : ""}`;
      }),
    );
    blocks.push(`${header}\n${playerParts.join("\n")}`);
  }
  return blocks;
}

async function buildFinalEmbed(state, ranking) {
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({
      ...r,
      username: await resolveDisplayName(r.discordId, r.username),
    })),
  );
  const historyBlocks = await buildMancheHistoryBlocks(state.history || []);

  const lines = [
    "**📊 Détail des manches**",
    ...historyBlocks,
    "",
    "**Classement final :**",
    ...(resolvedRanking.length
      ? resolvedRanking.map(
          (r, i) =>
            `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`,
        )
      : ["Personne n'a marqué de point."]),
  ];

  return {
    title: "🏁 Blackjack Duel — Partie terminée",
    description: lines.join("\n"),
    color: BLACKJACKDUEL_COLOR,
  };
}

// ── Commande /blackjack ──────────────────────────────────────────────

export async function handleBlackjackCommand(webhookUrl, body, { maxPlayers, totalManches }) {
  try {
    const channelId = body.channel_id;
    const result = await startGame(channelId, { maxPlayers, totalManches });

    if (result.alreadyActive) {
      await patchOriginal(webhookUrl, {
        content: `Une partie de Blackjack Duel est déjà en cours dans <#${result.state.channelId}> — attends qu'elle se termine (ou qu'elle expire après 2h d'inactivité).`,
        embeds: [],
        components: [],
      });
      return;
    }

    const embed = await buildTableEmbed(result.state);
    const components = buildJoinComponents();

    const token = process.env.DISCORD_TOKEN;
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ embeds: [embed], components }),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
    }
    const message = await res.json();
    await writeState({ ...result.state, messageId: message.id });

    await patchOriginal(webhookUrl, {
      content: `Table ouverte ! ${maxPlayers} joueur${maxPlayers > 1 ? "s" : ""} max, ${totalManches} manches.`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[BlackjackDuel] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du lancement de la partie.",
      embeds: [],
      components: [],
    });
  }
}

export async function handleBlackjackRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
    embeds: [],
    components: [],
  });
}

// ── Main du joueur — Jouer / Piocher / Arrêter ─────────────────────

// Manches impaires : résultat révélé dès que la main est figée (même
// logique que le jeu spécial). Manches paires : le Croupier joue en second,
// donc même un bust (toujours perdant quel que soit son score) ne doit pas
// laisser fuiter dealer.score — résultat complet révélé à la résolution.
function handStatusMessage(hand, dealer, manche, isSolo) {
  if (!isSolo) {
    if (hand.status === "bust") {
      return "💥 Tu dépasses 21, ta main est perdue pour cette manche.";
    }
    if (hand.status === "stand") {
      const natural = hand.score === 21 && hand.cards.length === 2;
      const intro = natural
        ? "🎉 21 sur deux cartes, la meilleure main possible !"
        : `🛑 Tu t'arrêtes à ${hand.score}.`;
      return `${intro} Résultat connu dès que tous les joueurs auront fini leur main.`;
    }
    return "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";
  }

  const revealed = isDealerRevealed(manche);
  if (hand.status === "bust") {
    return revealed
      ? `💥 Tu dépasses 21 (le Croupier était à ${dealer.score}), ta main est perdue pour cette manche.`
      : "💥 Tu dépasses 21, ta main est perdue pour cette manche.";
  }
  if (hand.status === "stand") {
    const natural = hand.score === 21 && hand.cards.length === 2;
    const intro = natural
      ? "🎉 21 sur deux cartes, la meilleure main possible !"
      : `🛑 Tu t'arrêtes à ${hand.score}.`;
    if (!revealed) {
      return `${intro} Le Croupier n'a pas encore joué — il jouera en second cette manche, tu sauras si tu l'as battu à la résolution.`;
    }
    if (hand.score > dealer.score) return `${intro} Le Croupier était à ${dealer.score} — tu gagnes 2 points !`;
    if (hand.score === dealer.score)
      return `${intro} Le Croupier était aussi à ${dealer.score} — égalité, tu gagnes quand même 1 point !`;
    return `${intro} Le Croupier était à ${dealer.score} — pas de point cette manche.`;
  }
  return "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";
}

function buildHandEmbed(manche, hand, message) {
  const scoreLabel = hand.status === "bust" ? "Dépassement" : `Score : ${hand.score}`;
  return {
    title: `🃏 Ta main — Manche ${manche}`,
    description: [...formatCardsBlock(hand.cards, scoreLabel), "", message].join("\n"),
    color: BLACKJACKDUEL_COLOR,
  };
}

function buildHandComponents(manche, hand) {
  if (hand.status !== "en_cours") return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Piocher",
          emoji: { name: "👆" },
          custom_id: `blackjackduel_piocher:${manche}`,
        },
        {
          type: 2,
          style: 1,
          label: "Arrêter",
          emoji: { name: "🛑" },
          custom_id: `blackjackduel_arreter:${manche}`,
        },
      ],
    },
  ];
}

// Après chaque action (Jouer, Piocher, Arrêter) qui peut terminer une main :
// vérifie si la manche (ou la partie) doit se résoudre, puis rafraîchit le
// message public en place — jamais de suppression/repost (contrairement au
// jeu spécial), il n'y a pas de "jour" qui change.
async function refreshPublicMessage() {
  const outcome = await checkAndResolveManche();
  if (outcome.inactive) return;

  if (!outcome.resolved) {
    // Rien à résoudre pour l'instant (ou résolution déjà prise par un autre
    // clic concurrent) : on rafraîchit juste le compteur "en attente de".
    const embed = await buildTableEmbed(outcome.state);
    await patchPublicMessage(outcome.state, {
      embeds: [embed],
      components: buildJoinComponents(),
    });
    return;
  }

  if (outcome.final) {
    const embed = await buildFinalEmbed(outcome.state, outcome.ranking);
    await patchPublicMessage(outcome.state, { embeds: [embed], components: [] });
    return;
  }

  const embed = await buildTableEmbed(outcome.state, {
    previousResults: outcome.results,
    previousDealer: outcome.dealer,
  });
  await patchPublicMessage(outcome.state, {
    embeds: [embed],
    components: buildJoinComponents(),
  });
}

export async function handleJouer(webhookUrl, discordId, username) {
  try {
    const result = await joinAndDeal(discordId, username);

    if (result.inactive) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Blackjack Duel en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.rosterLocked) {
      await patchOriginal(webhookUrl, {
        content: "Cette partie a déjà commencé (ou les sièges sont tous pris) — tu ne peux pas rejoindre.",
        embeds: [],
        components: [],
      });
      return;
    }

    const state = result.state;
    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(
          state.manche,
          result.hand,
          handStatusMessage(result.hand, state.dealer, state.manche, state.maxPlayers === 1),
        ),
      ],
      components: buildHandComponents(state.manche, result.hand),
    });

    if (result.isNew) {
      await refreshPublicMessage();
    }
  } catch (err) {
    console.error("[BlackjackDuel] Échec Jouer:", err.message);
  }
}

async function handleDrawOrStand(webhookUrl, discordId, { draw }) {
  try {
    const result = await drawOrStand(discordId, { draw });

    if (result.inactive) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Blackjack Duel en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour recevoir tes 2 premières cartes !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state.manche, result.hand, "Ta main est déjà terminée pour cette manche.")],
        components: [],
      });
      return;
    }

    const state = result.state;
    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(
          state.manche,
          result.hand,
          handStatusMessage(result.hand, state.dealer, state.manche, state.maxPlayers === 1),
        ),
      ],
      components: buildHandComponents(state.manche, result.hand),
    });

    await refreshPublicMessage();
  } catch (err) {
    console.error(`[BlackjackDuel] Échec ${draw ? "Piocher" : "Arrêter"}:`, err.message);
  }
}

export async function handlePiocher(webhookUrl, discordId) {
  return handleDrawOrStand(webhookUrl, discordId, { draw: true });
}

export async function handleArreter(webhookUrl, discordId) {
  return handleDrawOrStand(webhookUrl, discordId, { draw: false });
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed() {
  return {
    title: "📖 Règles du jeu — Blackjack Duel",
    description: [
      "Duel fermé à 1-3 joueurs, sur plusieurs manches.",
      "",
      "**Valeur des cartes :** 2 à 10 = leur valeur, Valet/Dame/Roi = 10, As = 11 ou 1 (ramené à 1 si besoin pour éviter de dépasser 21).",
      "",
      "**Inscription :** clique sur **Jouer** pour rejoindre — dès que tous les sièges sont pris (ou dès que la 1ʳᵉ manche se termine), les inscriptions sont définitivement closes.",
      "",
      "**Déroulement (1 main par manche) :**",
      "🃏 **Jouer** — reçois 2 cartes.",
      "👆 **Piocher** — reçois une carte de plus (autant de fois que tu veux).",
      "🛑 **Arrêter** — fige ton score pour cette manche.",
      "Dépasser 21 = main perdue immédiatement pour la manche.",
      "",
      "**En solo (1 joueur) :** tu affrontes le Croupier. Sur les manches impaires (1, 3, 5…), il joue en premier — son score est connu à l'avance. Sur les manches paires, il joue en second — tu joues sans connaître son score, révélé seulement à la résolution.",
      "",
      "**À 2 ou 3 joueurs :** pas de Croupier — vous vous affrontez directement. La meilleure main non dépassée l'emporte, résultat révélé dès que tout le monde a joué sa main.",
      "",
      "**Résultat d'une manche :** le vainqueur gagne **2 points**. Égalité (avec le Croupier en solo, ou entre joueurs à 2-3) = **1 point** quand même. Une manche se termine dès que toutes les places sont prises et que chaque joueur a joué.",
      "",
      "Le classement cumulé à la fin de la dernière manche désigne le(s) vainqueur(s) de la partie. Une partie inactive depuis plus de 2h peut être remplacée en relançant /blackjack.",
    ].join("\n"),
    color: BLACKJACKDUEL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed()], components: [] });
  } catch (err) {
    console.error("[BlackjackDuel] Échec Règles:", err.message);
  }
}

export { extractMember };
