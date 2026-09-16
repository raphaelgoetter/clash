// ============================================================
// gobeletDuel.js — Handlers Discord pour le Jeu du Gobelet, duel autonome
// (1 à 3 joueurs, N manches), lancé à la demande via /gobelet.
//
// Développé EN PARALLÈLE du jeu spécial (_handlers/gobelet.js), sans aucun
// impact dessus : custom_id préfixés `gobeletduel_*` (jamais `gobelet_*`),
// état Redis dans backend/services/gobeletDuel.js (`gobeletduel:*`), aucun
// import du service du jeu spécial (seule la config statique diceEmojis est
// relue via loadGobeletConfig, qui ne touche aucun état).
//
// Contrairement au jeu spécial, le message public est ÉDITÉ EN PLACE à
// chaque avancée (jamais supprimé/reposté) : il n'y a pas de "jour" qui
// change, seulement des manches qui s'enchaînent en direct.
// ============================================================

import {
  writeState,
  startGame,
  joinAndDeal,
  toggleKept,
  relance,
  checkAndResolveManche,
  listHands,
} from "../../../backend/services/gobeletDuel.js";
import { loadGobeletConfig } from "../../../backend/services/gobelet.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const GOBELETDUEL_COLOR = 0x9b59b6;
const NO_KEPT = [false, false, false, false, false];

// ── Dés — rendu texte (dupliqué depuis _handlers/gobelet.js : pas de
// dépendance croisée entre les deux variantes de rendu) ──────────────
const DICE_FACES = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

function formatDie(value) {
  return DICE_FACES[value - 1];
}

function formatDice(dice) {
  return dice.map(formatDie).join(" ");
}

function formatDiceBlock(dice) {
  return [`# ${formatDice(dice)}`];
}

// ── Résolution des rôles/utilisateurs ────────────────────────────────

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick || body.member?.user?.global_name || body.member?.user?.username || "Inconnu";
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
    console.error("[GobeletDuel] Échec PATCH:", err.message);
  }
}

async function patchPublicMessage(state, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId || !state?.messageId) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[GobeletDuel] Échec édition du message public (${res.status}).`);
    }
  } catch (err) {
    console.warn("[GobeletDuel] Erreur réseau à l'édition du message public:", err.message);
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
        { type: 2, style: 3, label: "Jouer", emoji: { name: "🎲" }, custom_id: "gobeletduel_jouer" },
        { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "gobeletduel_regles" },
      ],
    },
  ];
}

async function buildPendingLabel(state, hands) {
  const pendingIds = state.players.filter((id) => !hands[id] || hands[id].status === "en_cours");
  if (pendingIds.length === 0) return "Tout le monde a joué, résolution en cours…";
  const names = await Promise.all(pendingIds.map((id) => resolveDisplayName(id, hands[id]?.username)));
  return `⏳ En attente de : ${names.join(", ")}`;
}

async function buildTableEmbed(state, { previousResults } = {}) {
  const hands = await listHands(state.manche);
  const lines = [];

  if (previousResults) {
    const maxPoints = Math.max(...previousResults.map((r) => r.points));
    const winners = previousResults.filter((r) => r.points === maxPoints);
    const winnerNames = await Promise.all(winners.map((w) => resolveDisplayName(w.discordId, w.username)));
    lines.push(
      `**📊 Bilan de la manche ${state.manche - 1}**`,
      `🏆 Meilleur${winnerNames.length > 1 ? "s" : ""} score${winnerNames.length > 1 ? "s" : ""} (${maxPoints} pt${maxPoints > 1 ? "s" : ""}) : ${winnerNames.join(", ")}`,
      "",
    );
  }

  // Pas de "Manche X/Y" ici : déjà dans le titre de l'embed (buildTableEmbed
  // est utilisé pour le body) — même principe que buildTodaySection du jeu
  // spécial (_handlers/gobelet.js).
  const seatsLabel = `${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}`;
  lines.push("## 🎲 À vos dés !", "Clique sur **Jouer** pour lancer tes 5 dés.", "", seatsLabel);

  if (state.players.length > 0) {
    lines.push(await buildPendingLabel(state, hands));
  } else {
    lines.push("Clique sur **Jouer** pour t'inscrire et lancer ta première main.");
  }

  return {
    title: `🎲 Gobelet Duel — Manche ${state.manche}/${state.totalManches}`,
    description: lines.join("\n"),
    color: GOBELETDUEL_COLOR,
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes — la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

async function buildFinalEmbed(state, results, ranking) {
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({ ...r, username: await resolveDisplayName(r.discordId, r.username) })),
  );
  const maxPoints = resolvedRanking[0]?.points ?? 0;
  const winners = maxPoints > 0 ? resolvedRanking.filter((r) => r.points === maxPoints) : [];

  const lastManchePoints = Math.max(...results.map((r) => r.points));
  const lastWinners = results.filter((r) => r.points === lastManchePoints);
  const lastWinnerNames = await Promise.all(lastWinners.map((w) => resolveDisplayName(w.discordId, w.username)));

  const lines = [
    `**📊 Bilan de la dernière manche**`,
    `🏆 Meilleur${lastWinnerNames.length > 1 ? "s" : ""} score${lastWinnerNames.length > 1 ? "s" : ""} (${lastManchePoints} pt${lastManchePoints > 1 ? "s" : ""}) : ${lastWinnerNames.join(", ")}`,
    "",
    "**Classement final :**",
    ...(resolvedRanking.length
      ? resolvedRanking.map((r, i) => `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`)
      : ["Personne n'a marqué de point."]),
  ];

  if (winners.length) {
    lines.push(
      "",
      `🏆 Vainqueur${winners.length > 1 ? "s" : ""} (${maxPoints} pt${maxPoints > 1 ? "s" : ""}) : ${winners.map((w) => w.username).join(", ")}`,
    );
  }

  return {
    title: "🏁 Gobelet Duel — Partie terminée",
    description: lines.join("\n"),
    color: GOBELETDUEL_COLOR,
  };
}

// ── Commande /gobelet ──────────────────────────────────────────────

export async function handleGobeletCommand(webhookUrl, body, { maxPlayers, totalManches }) {
  try {
    const channelId = body.channel_id;
    const result = await startGame(channelId, { maxPlayers, totalManches });

    if (result.alreadyActive) {
      await patchOriginal(webhookUrl, {
        content: `Une partie du Jeu du Gobelet Duel est déjà en cours dans <#${result.state.channelId}> — attends qu'elle se termine (ou qu'elle expire après 24h d'inactivité).`,
        embeds: [],
        components: [],
      });
      return;
    }

    const embed = await buildTableEmbed(result.state);
    const components = buildJoinComponents();

    const token = process.env.DISCORD_TOKEN;
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
    await writeState({ ...result.state, messageId: message.id });

    await patchOriginal(webhookUrl, {
      content: `Table ouverte ! ${maxPlayers} joueur${maxPlayers > 1 ? "s" : ""} max, ${totalManches} manches.`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[GobeletDuel] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du lancement de la partie.",
      embeds: [],
      components: [],
    });
  }
}

export async function handleGobeletRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
    embeds: [],
    components: [],
  });
}

// ── Main du joueur — Jouer / conserver un dé / Relancer ─────────────

function buildHandStatusMessage(hand, kept) {
  if (hand.status === "termine") {
    return `🎯 Combinaison retenue : **${hand.category}** — tu gagnes **${hand.points} point${hand.points > 1 ? "s" : ""}** cette manche !`;
  }
  const toReroll = kept.filter((k) => !k).length;
  const rerollsLeft = 3 - hand.tirage;
  return `Tirage ${hand.tirage}/3 — sélectionne les dés à conserver (🔒) puis clique sur **Relancer** pour relancer les ${toReroll} dé${toReroll > 1 ? "s" : ""} restant${toReroll > 1 ? "s" : ""}. Il te reste ${rerollsLeft} relance${rerollsLeft > 1 ? "s" : ""}.`;
}

function buildHandEmbed(manche, hand, kept) {
  return {
    title: `🎲 Ta main — Manche ${manche}`,
    description: [...formatDiceBlock(hand.dice), "", buildHandStatusMessage(hand, kept)].join("\n"),
    color: GOBELETDUEL_COLOR,
  };
}

function relancerLabel(kept) {
  const count = kept.filter((k) => !k).length;
  return count === 0 ? "Passer au tirage suivant" : `Relancer (${count} dé${count > 1 ? "s" : ""})`;
}

// Emoji d'application Discord uploadés une fois via `npm run gobelet:emojis`
// (voir scripts/uploadGobeletEmojis.js) — même config statique que le jeu
// spécial (data/gobelet/gobelet.json, clé diceEmojis), relue directement
// (loadGobeletConfig ne touche aucun état, aucun risque de couplage).
function buildDieEmoji(value, kept, diceEmojis) {
  const emojiId = diceEmojis?.[String(value)];
  if (emojiId) return { id: emojiId, name: `gobelet_dice_${value}` };
  return { name: kept ? "🔒" : "🎲" };
}

function buildHandComponents(manche, hand, kept, diceEmojis) {
  if (hand.status !== "en_cours") return [];
  return [
    {
      type: 1,
      components: hand.dice.map((value, i) => ({
        type: 2,
        style: kept[i] ? 3 : 2,
        label: String(value),
        emoji: buildDieEmoji(value, kept[i], diceEmojis),
        custom_id: `gobeletduel_toggle:${manche}:${i}`,
      })),
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: relancerLabel(kept),
          emoji: { name: kept.every(Boolean) ? "➡️" : "🔁" },
          custom_id: `gobeletduel_relancer:${manche}`,
        },
      ],
    },
  ];
}

// Après une relance qui peut terminer une main (3ᵉ tirage atteint) : vérifie
// si la manche (ou la partie) doit se résoudre, puis rafraîchit le message
// public en place — jamais de suppression/repost (contrairement au jeu
// spécial), il n'y a pas de "jour" qui change.
async function refreshPublicMessage() {
  const outcome = await checkAndResolveManche();
  if (outcome.inactive) return;

  if (!outcome.resolved) {
    // Rien à résoudre pour l'instant (ou résolution déjà prise par un autre
    // clic concurrent) : on rafraîchit juste le compteur "en attente de".
    const embed = await buildTableEmbed(outcome.state);
    await patchPublicMessage(outcome.state, { embeds: [embed], components: buildJoinComponents() });
    return;
  }

  if (outcome.final) {
    const embed = await buildFinalEmbed(outcome.state, outcome.results, outcome.ranking);
    await patchPublicMessage(outcome.state, { embeds: [embed], components: [] });
    return;
  }

  const embed = await buildTableEmbed(outcome.state, { previousResults: outcome.results });
  await patchPublicMessage(outcome.state, { embeds: [embed], components: buildJoinComponents() });
}

export async function handleJouer(webhookUrl, discordId, username) {
  try {
    const result = await joinAndDeal(discordId, username);

    if (result.inactive) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie du Jeu du Gobelet Duel en cours pour le moment.",
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

    const { diceEmojis } = await loadGobeletConfig();
    const state = result.state;
    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(state.manche, result.hand, result.kept)],
      components: buildHandComponents(state.manche, result.hand, result.kept, diceEmojis),
    });

    if (result.isNew) {
      await refreshPublicMessage();
    }
  } catch (err) {
    console.error("[GobeletDuel] Échec Jouer:", err.message);
  }
}

export async function handleToggle(webhookUrl, discordId, index) {
  try {
    const result = await toggleKept(discordId, Number(index));

    if (result.inactive) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie du Jeu du Gobelet Duel en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour lancer tes 5 dés !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state.manche, result.hand, NO_KEPT)],
        components: [],
      });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();
    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state.manche, result.hand, result.kept)],
      components: buildHandComponents(result.state.manche, result.hand, result.kept, diceEmojis),
    });
  } catch (err) {
    console.error("[GobeletDuel] Échec sélection de dé:", err.message);
  }
}

export async function handleRelancer(webhookUrl, discordId) {
  try {
    const result = await relance(discordId);

    if (result.inactive) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie du Jeu du Gobelet Duel en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: "Clique d'abord sur **Jouer** pour lancer tes 5 dés !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state.manche, result.hand, NO_KEPT)],
        components: [],
      });
      return;
    }

    const { diceEmojis } = await loadGobeletConfig();
    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state.manche, result.hand, result.kept)],
      components: buildHandComponents(result.state.manche, result.hand, result.kept, diceEmojis),
    });

    await refreshPublicMessage();
  } catch (err) {
    console.error("[GobeletDuel] Échec Relancer:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed() {
  return {
    title: "📖 Règles du jeu — Jeu du Gobelet Duel",
    description: [
      "Duel fermé à 1-3 joueurs, sur plusieurs manches.",
      "",
      "**Inscription :** clique sur **Jouer** pour rejoindre — dès que tous les sièges sont pris (ou dès que la 1ʳᵉ manche se termine), les inscriptions sont définitivement closes.",
      "",
      "**Déroulement (1 main par manche) :**",
      "🎲 **Jouer** — lance tes 5 dés.",
      "🔒 **Clique sur un dé** pour le conserver (ou le relâcher) avant la relance.",
      "🔁 **Relancer** — relance tous les dés non conservés. Possible 2 fois, donc 3 tirages au total.",
      "Ta combinaison finale est calculée automatiquement — pas besoin de choisir toi-même la catégorie.",
      "",
      "**Barème (la catégorie applicable la plus valorisée est toujours retenue) :**",
      "🎲 Aucune combinaison : somme des 5 dés",
      "🎯 Brelan (3 dés identiques) : 20 pts",
      "🎯 Carré (4 dés identiques) : 30 pts",
      "🎯 Full (3 + 2) : 40 pts",
      "🎯 Somme ≤ 7 : 40 pts",
      "🎯 Somme ≥ 28 : 40 pts",
      "🎯 Petite Suite (1,2,3,4,5) : 45 pts",
      "🎯 Grande Suite (2,3,4,5,6) : 50 pts",
      "🎯 Gobelet (5 dés identiques) : 60 pts",
      "",
      "Une manche se termine dès que tous les joueurs inscrits ont fini leurs 3 tirages. Le classement cumulé à la fin de la dernière manche désigne le(s) vainqueur(s) de la partie. Une partie inactive plus de 24h est automatiquement annulée.",
    ].join("\n"),
    color: GOBELETDUEL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed()], components: [] });
  } catch (err) {
    console.error("[GobeletDuel] Échec Règles:", err.message);
  }
}
