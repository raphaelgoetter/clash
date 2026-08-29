// ============================================================
// blackjack.js — Handlers Discord pour Blackjack (7 jours, 1 point de
// victoire par jour gagné contre le Croupier, classement cumulé au Jour 7).
// Embed, boutons d'action (Jouer/Piocher/Arrêter), Règles, Journal.
// La publication/suppression quotidienne passe uniquement par
// scripts/postBlackjack.js (postBlackjack) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadBlackjackConfig,
  readState,
  writeState,
  drawCard,
  computeHandValue,
  dealerPlay,
  compareToDealer,
  resolveDay,
  readHand,
  writeHand,
  listHands,
  addPoint,
  readPoints,
  resetPoints,
  buildRanking,
  writeHistoriqueEntry,
  listHistorique,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/blackjack.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const BLACKJACK_COLOR = 0x2ecc71;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustrations statiques (frontend/public/images/blackjack/), même
// principe que robinsonImageUrl() dans api/discord/_handlers/robinson.js.
// "start" pour le lancement (Jour 1) et la révélation finale (Jour 8) ;
// "game" pour les jours intermédiaires (2 à 7).
//
// Suffixe ?v= : Discord met en cache une image par URL EXACTE, y compris
// après remplacement du fichier (Vercel sert bien le nouveau contenu — ETag
// vérifié — mais Discord continue de resservir sa copie mise en cache tant
// que l'URL ne change pas). Incrémenter IMAGE_VERSION force Discord à
// refaire un fetch à chaque remplacement de fichier.
const BLACKJACK_IMAGE_VERSION = 2;
const BLACKJACK_GAME_IMAGE_URL = `${TRUST_ROYALE_URL}/images/blackjack/blackjack-game.webp?v=${BLACKJACK_IMAGE_VERSION}`;
const BLACKJACK_START_IMAGE_URL = `${TRUST_ROYALE_URL}/images/blackjack/blackjack-start.webp?v=${BLACKJACK_IMAGE_VERSION}`;

const DAY1_INTRO =
  "**Table ouverte !** Le Croupier s'installe pour 7 jours — bats-le chaque jour pour cumuler des points. Clique sur *Règles* pour les détails.";

// ── Cartes — rendu texte ────────────────────────────────────────────

function formatCard(card) {
  return `${card.rank}${card.suit}`;
}

function formatCards(cards) {
  return cards.map(formatCard).join(" ");
}

// Les vrais glyphes Unicode de cartes à jouer (bloc U+1F0A0-1F0DF) ont été
// essayés puis abandonnés (29/08, retour utilisateur avec capture d'écran) :
// sans artwork couleur chez Discord, ils restent minuscules même sous un
// titre H1 — contrairement aux emoji standard (♠️♥️♦️♣️ compris) qui
// s'agrandissent normalement. Rang+couleur en titre Markdown (# ) reste donc
// le seul rendu "graphique" fiable.
//
// scoreLabel optionnel : omis quand le score est déjà annoncé juste
// au-dessus (ex. le titre "Score à battre aujourd'hui : N" du Croupier),
// pour ne pas le répéter une 3ᵉ fois.
function formatCardsBlock(cards, scoreLabel = null) {
  const lines = [`# ${formatCards(cards)}`];
  if (scoreLabel) lines.push(`**${scoreLabel}**`);
  return lines;
}

// ── Résolution d'un jour — rendu texte partagé (recap + révélation finale) ──
// Résumé plutôt que liste exhaustive (29/08, retour utilisateur) : avec
// beaucoup de joueurs, détailler la main de chacun rendrait le message
// public illisible. Seuls les gagnants sont nommés (ce qu'il y a de plus
// intéressant à voir publiquement) ; chacun retrouve le détail de SA propre
// main dans le bouton Journal.

async function formatResultsSection(results) {
  if (!results.length) return ["Personne n'a joué ce jour-là."];

  const winners = results.filter((r) => r.result === "win");
  const pushes = results.filter((r) => r.result === "push");
  const losers = results.filter((r) => r.result === "lose");

  const lines = [
    `${results.length} joueur${results.length > 1 ? "s" : ""} ont joué.`,
  ];
  if (winners.length) {
    const names = await Promise.all(
      winners.map((r) => resolveDisplayName(r.discordId, r.username)),
    );
    lines.push(
      `🏆 Gagnant${names.length > 1 ? "s" : ""} (${names.length}) : ${names.join(", ")}`,
    );
  } else {
    lines.push("🏆 Personne n'a battu le Croupier hier.");
  }
  if (pushes.length) lines.push(`🤝 Égalité : ${pushes.length}`);
  if (losers.length)
    lines.push(`❌ Perdant${losers.length > 1 ? "s" : ""} : ${losers.length}`);

  return lines;
}

function formatDealerLine(dealer) {
  return `🎩 **Croupier :** ${formatCards(dealer.cards)} (**${dealer.score}**)`;
}

// Section "score à battre" du jour — le Croupier ne joue plus une vraie main
// (voir dealerPlay() côté service) : un score aléatoire 15-21 est tiré à
// l'ouverture du jour, jamais de saut, révélé immédiatement — les joueurs
// savent exactement ce qu'ils doivent battre avant même de cliquer sur Jouer.
function buildDealerTargetSection(dealer) {
  const lines = [
    `## 🎩 Score à battre aujourd'hui : ${dealer.score}`,
    ...formatCardsBlock(dealer.cards),
    "",
  ];
  // 21 est le maximum atteignable sans dépasser — impossible de faire mieux,
  // seule une égalité (21 aussi) est jouable ce jour-là. Prévient les
  // joueurs avant qu'ils ne cliquent sur Jouer plutôt qu'à la clôture.
  lines.push(
    dealer.score === 21
      ? "😱 21 pile — impossible de faire mieux aujourd'hui, seule une égalité (21 aussi) est possible !"
      : "Fais mieux que ça sans dépasser 21 pour gagner 1 point.",
  );
  return lines;
}

// ── Embed / composants du jour ────────────────────────────────────

function buildDayComponents(jour) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3, // vert (Success) — action principale du message
          label: "Jouer",
          emoji: { name: "🃏" },
          custom_id: `blackjack_jouer:${jour}`,
        },
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "blackjack_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "blackjack_regles",
        },
      ],
    },
  ];
}

async function buildDayEmbed(
  jour,
  config,
  dealer,
  { estPremierJour, previousDealer, previousResults },
) {
  const lines = [];
  if (estPremierJour) {
    lines.push(DAY1_INTRO, "");
  } else {
    lines.push(
      `**📊 Bilan du Jour ${jour - 1}**`,
      formatDealerLine(previousDealer),
      ...(await formatResultsSection(previousResults)),
      "",
    );
  }
  lines.push(...buildDealerTargetSection(dealer));

  return {
    title: `🃏 Blackjack — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: BLACKJACK_COLOR,
    image: {
      url: estPremierJour
        ? BLACKJACK_START_IMAGE_URL
        : BLACKJACK_GAME_IMAGE_URL,
    },
    footer: {
      text: estPremierJour
        ? "Bats le Croupier chaque jour pendant 7 jours pour cumuler des points !"
        : `Joue avant ${formatUtcTimeAsParis(8)} demain pour ne pas manquer ta chance aujourd'hui.`,
    },
  };
}

// ── Embed de révélation finale (Jour 8) ───────────────────────────

function formatMancheHistoryLine(record) {
  const winners = record.winners?.length
    ? record.winners.join(", ")
    : "personne";
  return `Manche ${record.manche} : 🏆 ${winners} — ${record.maxPoints} pts`;
}

async function buildRevealEmbed(
  lastDealer,
  lastResults,
  ranking,
  manchesHistory,
) {
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({
      ...r,
      username: await resolveDisplayName(r.discordId, r.username),
    })),
  );
  const maxPoints = resolvedRanking[0]?.points ?? 0;
  const winners =
    maxPoints > 0 ? resolvedRanking.filter((r) => r.points === maxPoints) : [];

  const lines = [
    `**📊 Bilan du dernier jour**`,
    formatDealerLine(lastDealer),
    ...(await formatResultsSection(lastResults)),
    "",
    "**Classement final :**",
    ...(resolvedRanking.length
      ? resolvedRanking
          .slice(0, 20)
          .map(
            (r, i) =>
              `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`,
          )
      : ["Personne n'a marqué de point cette manche."]),
  ];

  if (winners.length) {
    lines.push(
      "",
      `🏆 Vainqueur${winners.length > 1 ? "s" : ""} (${maxPoints} pt${maxPoints > 1 ? "s" : ""}) : ${winners.map((w) => w.username).join(", ")}`,
    );
  }

  if (manchesHistory.length) {
    lines.push(
      "",
      "**Vainqueurs des manches précédentes :**",
      ...manchesHistory.map(formatMancheHistoryLine),
    );
  }

  return {
    title: "🏁 Blackjack — Révélation finale",
    description: lines.join("\n"),
    color: BLACKJACK_COLOR,
    image: { url: BLACKJACK_START_IMAGE_URL },
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postBlackjack.js) ──

async function publishAndWriteState(
  channelId,
  previousState,
  { jour, dealer, embed, components, noPing, termine = false },
) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(
          `[Blackjack] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Blackjack] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Ping à chaque post (Jour 1, jours suivants, révélation finale) — comme
  // Quiz : une action est attendue CHAQUE jour (jouer sa main), contrairement
  // à Robinson/Tamagoshi qui ne pingent qu'au lancement/à la fin.
  const roleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

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

  await writeState({
    jour,
    dealer,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
  });

  return { jour, embed, message, termine };
}

export async function postBlackjack(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  const config = await loadBlackjackConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  // Garde-fou anti-double-avancée (même incident/pattern que Robinson/Quiz,
  // 26-27/08) : jamais appliqué en dry-run, contournable avec --force.
  if (
    state &&
    !dryRun &&
    !force &&
    isTooSoonSinceLastClosure(state.publishedAt)
  ) {
    return {
      skipped: true,
      reason: "tooSoonSinceLastClosure",
      publishedAt: state.publishedAt,
    };
  }

  // Garde-fou : une partie active sur un AUTRE salon ne doit JAMAIS être
  // reprise ici (voir CONTRIBUTING.md — incident réel du 23/08/2026 sur Quiz).
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une partie déjà lancée manuellement.
  if (!state && requireActiveState) return { skipped: true };

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const dealer = dealerPlay(
      Math.random,
      config.croupier.min,
      config.croupier.max,
    );
    const embed = await buildDayEmbed(jour, config, dealer, {
      estPremierJour: true,
    });
    const components = buildDayComponents(jour);

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }

    await resetPoints();
    return publishAndWriteState(channelId, null, {
      jour,
      dealer,
      embed,
      components,
      noPing,
      termine: false,
    });
  }

  // Résolution du jour actif (state.jour) face à state.dealer, déjà généré
  // (et caché) à l'ouverture de ce jour-là.
  const hands = await listHands(state.jour);
  const results = resolveDay(hands, state.dealer);
  const jourSuivant = state.jour + 1;
  const estFinDeManche = jourSuivant > config.duree_jours;

  if (dryRun) {
    if (estFinDeManche) {
      const pointsActuels = await readPoints();
      // +1 simulé pour chaque gagnant du jour, sans écrire dans Redis — pure
      // projection pour npm run blackjack:status / --dry-run.
      for (const r of results) {
        if (r.result === "win")
          pointsActuels[r.discordId] = (pointsActuels[r.discordId] || 0) + 1;
      }
      const ranking = buildRanking(pointsActuels);
      const embed = await buildRevealEmbed(state.dealer, results, ranking, []);
      return { dryRun: true, final: true, embed };
    }
    const nextDealerPreview = dealerPlay(
      Math.random,
      config.croupier.min,
      config.croupier.max,
    );
    const embed = await buildDayEmbed(jourSuivant, config, nextDealerPreview, {
      estPremierJour: false,
      previousDealer: state.dealer,
      previousResults: results,
    });
    return {
      dryRun: true,
      jour: jourSuivant,
      embed,
      components: buildDayComponents(jourSuivant),
      dealer: nextDealerPreview,
    };
  }

  for (const r of results) {
    if (r.result === "win") await addPoint(r.discordId);
  }
  await writeHistoriqueEntry(state.jour, {
    jour: state.jour,
    dealer: state.dealer,
    results,
    resolvedAt: new Date().toISOString(),
  });

  if (estFinDeManche) {
    const points = await readPoints();
    const ranking = buildRanking(points);
    // Jamais archivé en dry-run NI sur le salon de test (isPublic) — seule
    // une vraie publication publique compte comme une manche réelle (même
    // principe que les autres jeux, voir CONTRIBUTING.md).
    let currentManche = null;
    if (isPublic) {
      const resolvedRanking = await Promise.all(
        ranking.map(async (r) => ({
          ...r,
          username: await resolveDisplayName(r.discordId, r.username),
        })),
      );
      const maxPoints = resolvedRanking[0]?.points ?? 0;
      const winners =
        maxPoints > 0
          ? resolvedRanking
              .filter((r) => r.points === maxPoints)
              .map((r) => r.username)
          : [];
      currentManche = await archiveManche({
        resolvedAt: new Date().toISOString(),
        ranking: resolvedRanking,
        winners,
        maxPoints,
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = await buildRevealEmbed(
      state.dealer,
      results,
      ranking,
      manches,
    );
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      dealer: state.dealer,
      embed,
      components: [],
      noPing,
      termine: true,
    });
    return { ...result, final: true };
  }

  const nextDealer = dealerPlay(
    Math.random,
    config.croupier.min,
    config.croupier.max,
  );
  const embed = await buildDayEmbed(jourSuivant, config, nextDealer, {
    estPremierJour: false,
    previousDealer: state.dealer,
    previousResults: results,
  });
  const components = buildDayComponents(jourSuivant);

  return publishAndWriteState(channelId, state, {
    jour: jourSuivant,
    dealer: nextDealer,
    embed,
    components,
    noPing,
    termine: false,
  });
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
    console.error("[Blackjack] Échec PATCH:", err.message);
  }
}

// ── Main du joueur — Jouer / Piocher / Arrêter ─────────────────────
// Tout se joue en éphémère (message privé au joueur) : le message public du
// jour n'est jamais repatché (contrairement à Tamagotchi/Robinson), il n'y a
// aucun compteur à y afficher — la main de chacun reste secrète jusqu'à la
// clôture du lendemain.

// Le score du Croupier est déjà public dès l'ouverture du jour (voir
// buildDealerTargetSection) : inutile de faire attendre la clôture pour dire
// si la main gagne ou non, le résultat est révélé immédiatement dès que la
// main est figée (stand ou dépassement).
function handStatusMessage(hand, dealerScore) {
  if (hand.status === "bust") {
    return `💥 Tu dépasses 21 (le Croupier était à ${dealerScore}), ta main est perdue pour aujourd'hui. Rendez-vous demain pour une nouvelle chance !`;
  }
  if (hand.status === "stand") {
    const natural = hand.score === 21 && hand.cards.length === 2;
    const intro = natural
      ? "🎉 21 sur deux cartes, la meilleure main possible !"
      : `🛑 Tu t'arrêtes à ${hand.score}.`;
    const result = compareToDealer(hand.score, { score: dealerScore });
    if (result === "win")
      return `${intro} Le Croupier était à ${dealerScore} — tu gagnes 1 point aujourd'hui ! 🏆`;
    if (result === "push")
      return `${intro} Le Croupier était aussi à ${dealerScore} — égalité, aucun point aujourd'hui.`;
    return `${intro} Le Croupier était à ${dealerScore} — pas de point aujourd'hui.`;
  }
  return "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";
}

function buildHandEmbed(jour, hand, message) {
  const scoreLabel =
    hand.status === "bust" ? "Dépassement" : `Score : ${hand.score}`;
  return {
    title: `🃏 Ta main — Jour ${jour}`,
    description: [
      ...formatCardsBlock(hand.cards, scoreLabel),
      "",
      message,
    ].join("\n"),
    color: BLACKJACK_COLOR,
  };
}

function buildHandComponents(jour, hand) {
  if (hand.status !== "en_cours") return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Piocher",
          emoji: { name: "🎴" },
          custom_id: `blackjack_piocher:${jour}`,
        },
        {
          type: 2,
          style: 1,
          label: "Arrêter",
          emoji: { name: "🛑" },
          custom_id: `blackjack_arreter:${jour}`,
        },
      ],
    },
  ];
}

function isDayInactive(state, jour) {
  return !state || state.termine || String(state.jour) !== String(jour);
}

export async function handleJouer(webhookUrl, jour, discordId, username) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const existing = await readHand(jour, discordId);
    if (existing) {
      await patchOriginal(webhookUrl, {
        embeds: [
          buildHandEmbed(
            jour,
            existing,
            handStatusMessage(existing, state.dealer.score),
          ),
        ],
        components: buildHandComponents(jour, existing),
      });
      return;
    }

    const cards = [drawCard(), drawCard()];
    const score = computeHandValue(cards);
    const status = score === 21 ? "stand" : "en_cours";
    const hand = { cards, score, status, username };
    await writeHand(jour, discordId, hand);

    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(jour, hand, handStatusMessage(hand, state.dealer.score)),
      ],
      components: buildHandComponents(jour, hand),
    });
  } catch (err) {
    console.error("[Blackjack] Échec Jouer:", err.message);
  }
}

async function handleDrawOrStand(webhookUrl, jour, discordId, { draw }) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé, regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const hand = await readHand(jour, discordId);
    if (!hand) {
      await patchOriginal(webhookUrl, {
        content:
          "Clique d'abord sur **Jouer** pour recevoir tes 2 premières cartes !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (hand.status !== "en_cours") {
      await patchOriginal(webhookUrl, {
        embeds: [
          buildHandEmbed(
            jour,
            hand,
            "Ta main est déjà terminée pour aujourd'hui.",
          ),
        ],
        components: [],
      });
      return;
    }

    const cards = draw ? [...hand.cards, drawCard()] : hand.cards;
    const score = computeHandValue(cards);
    const status = !draw
      ? "stand"
      : score > 21
        ? "bust"
        : score === 21
          ? "stand"
          : "en_cours";
    const updated = { ...hand, cards, score, status };
    await writeHand(jour, discordId, updated);

    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(
          jour,
          updated,
          handStatusMessage(updated, state.dealer.score),
        ),
      ],
      components: buildHandComponents(jour, updated),
    });
  } catch (err) {
    console.error(
      `[Blackjack] Échec ${draw ? "Piocher" : "Arrêter"}:`,
      err.message,
    );
  }
}

export async function handlePiocher(webhookUrl, jour, discordId) {
  return handleDrawOrStand(webhookUrl, jour, discordId, { draw: true });
}

export async function handleArreter(webhookUrl, jour, discordId) {
  return handleDrawOrStand(webhookUrl, jour, discordId, { draw: false });
}

// ── Bouton [📜 Journal] — lecture seule ─────────────────────────────

function formatHistoriqueLine(entry, discordId) {
  const mine = entry.results?.find((r) => r.discordId === discordId);
  const monResultat = !mine
    ? " — tu n'as pas joué"
    : mine.result === "win"
      ? " — 🏆 tu as gagné"
      : mine.result === "push"
        ? " — 🤝 égalité"
        : " — ❌ tu as perdu";
  return `Jour ${entry.jour} : Croupier **${entry.dealer.score}**${monResultat}`;
}

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Blackjack en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }

    const [config, hand, points, { entries }] = await Promise.all([
      loadBlackjackConfig(),
      readHand(state.jour, discordId),
      readPoints(),
      listHistorique({ limit: 10 }),
    ]);

    const ranking = buildRanking(points);
    const resolvedRanking = await Promise.all(
      ranking.slice(0, 10).map(async (r) => ({
        ...r,
        username: await resolveDisplayName(r.discordId, r.username),
      })),
    );

    const lines = [`**Jour ${state.jour}/${config.duree_jours}**`];
    if (hand) {
      lines.push(
        `Ta main aujourd'hui : ${formatCards(hand.cards)} (**${hand.score}**) — ${handStatusMessage(hand, state.dealer.score)}`,
      );
    } else {
      lines.push(
        "Tu n'as pas encore joué aujourd'hui — clique sur **Jouer** !",
      );
    }

    lines.push(
      "",
      "**Classement cumulé :**",
      ...(resolvedRanking.length
        ? resolvedRanking.map(
            (r, i) =>
              `${i + 1}. ${r.username} — ${r.points} pt${r.points > 1 ? "s" : ""}`,
          )
        : ["Personne n'a encore marqué de point."]),
    );

    if (entries.length > 0) {
      lines.push(
        "",
        "**Jours précédents :**",
        ...entries.map((e) => formatHistoriqueLine(e, discordId)),
      );
    }

    const embed = {
      title: "📜 Journal",
      description: lines.join("\n"),
      color: BLACKJACK_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Blackjack] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du jeu — Blackjack",
    description: [
      "Bats le Croupier chaque jour pendant 7 jours pour cumuler des points.",
      "",
      "**Valeur des cartes :** 2 à 10 = leur valeur, Valet/Dame/Roi = 10, As = 11 ou 1 (automatiquement ramené à 1 si besoin pour éviter de dépasser 21).",
      "",
      "**Déroulement (1 main par jour, définitive) :**",
      "🃏 **Jouer** — reçois 2 cartes.",
      "🎴 **Piocher** — reçois une carte de plus (autant de fois que tu veux).",
      "🛑 **Arrêter** — fige ton score pour aujourd'hui.",
      "Dépasser 21 = main perdue immédiatement pour la journée.",
      "",
      "**Résultat quotidien :** le plus proche de 21 sans le dépasser gagne **1 point**. Égalité = personne ne marque. Une main non jouée ne rapporte ni ne coûte rien.",
      "",
      `Au Jour ${config.duree_jours}, le classement cumulé désigne le(s) vainqueur(s) de la manche.`,
      "",
      "📜 **Journal** — consulte ta main du jour, le classement cumulé et l'historique des jours précédents. Simple lecture, clique dessus autant de fois que tu veux.",
    ].join("\n"),
    color: BLACKJACK_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadBlackjackConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Blackjack] Échec Règles:", err.message);
  }
}
