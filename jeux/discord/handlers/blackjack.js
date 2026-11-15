// ============================================================
// blackjack.js — Handlers Discord pour Blackjack (7 jours, 2 points par
// victoire contre le Croupier, 1 point en cas d'égalité, classement cumulé
// au Jour 7).
// Embed, boutons d'action (Jouer/Piocher/Arrêter), Règles, Journal.
// La publication/suppression quotidienne passe uniquement par
// jeux/scripts/postBlackjack.js (postBlackjack) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadBlackjackConfig,
  readState,
  writeState,
  dealerPlay,
  dealHand,
  applyHandAction,
  canDouble,
  dealerHasNatural,
  compareToDealer,
  pointsForResult,
  resolveDay,
  readHand,
  writeHand,
  listHands,
  addPoints,
  readPoints,
  resetPoints,
  readUsernames,
  buildRanking,
  writeHistoriqueEntry,
  listHistorique,
  sumCardsPerPlayer,
  addResultsCardsToTotals,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../services/blackjack.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

// Ex aequo seulement si points ET cartes piochées égaux (départage officiel,
// voir buildRanking()).
const memeRang = (a, b) => a.points === b.points && a.cards === b.cards;
import { formatUtcTimeAsParis } from "@clash/clash-royale/dateUtils.js";
import { encodeMain } from "../../services/blackjackImage.js";

const BLACKJACK_COLOR = 0x2ecc71;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustrations statiques (frontend/public/images/blackjack/), même
// principe que robinsonImageUrl() dans jeux/discord/handlers/robinson.js.
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
// Exportée : réutilisée par _handlers/minijeux.js pour illustrer Blackjack
// quand c'est le jeu spécial du moment.
export const BLACKJACK_START_IMAGE_URL = `${TRUST_ROYALE_URL}/images/blackjack/blackjack-start.webp?v=${BLACKJACK_IMAGE_VERSION}`;

const DAY1_INTRO =
  "**Table ouverte !** Le Croupier s'installe pour 7 jours. Bats-le chaque jour pour cumuler des points. Clique sur *Règles* pour les détails.";

// ── Cartes — rendu texte ────────────────────────────────────────────

function formatCard(card) {
  return `${card.rank}${card.suit}`;
}

function formatCards(cards) {
  return cards.map(formatCard).join(" ");
}

// ⚠️ Pas de glyphes Unicode de cartes (bloc U+1F0A0-1F0DF) : minuscules
// sur Discord. Les mains sont en image (blackjackImage.js) ; ce rendu texte
// ne sert qu'à la carte visible du Croupier, au bilan et au Journal.

// ── Résolution d'un jour — rendu texte partagé (recap + révélation finale) ──
// Résumé plutôt que liste exhaustive (29/08, retour utilisateur) : avec
// beaucoup de joueurs, détailler la main de chacun rendrait le message
// public illisible. Seuls les gagnants sont nommés (ce qu'il y a de plus
// intéressant à voir publiquement) ; chacun retrouve le détail de SA propre
// main dans le bouton Journal.

async function formatResultsSection(results) {
  if (!results.length) return ["Personne n'a joué ce jour-là."];

  const winners = results.filter((r) => r.result === "win" || r.result === "blackjack");
  const naturels = results.filter((r) => r.result === "blackjack");
  const pushes = results.filter((r) => r.result === "push");

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
  if (naturels.length) lines.push(`🎉 Blackjack : ${naturels.length}`);
  if (pushes.length) lines.push(`🤝 Égalité : ${pushes.length}`);

  return lines;
}

function formatDealerLine(dealer) {
  const issue = dealerHasNatural(dealer) ? "Blackjack" : dealer.score > 21 ? `${dealer.score}, dépasse 21` : String(dealer.score);
  return `🎩 **Croupier :** ${formatCards(dealer.cards)} (**${issue}**)`;
}

// Section du jour : seule la première carte du Croupier est visible, la
// seconde reste cachée et il jouera sa main (pioche jusqu'à 17) après les
// joueurs, dévoilée à la clôture. ⚠️ Rien d'autre ne doit fuiter de sa main.
function buildDealerTargetSection(dealer) {
  return [
    `## 🎩 Carte visible du Croupier : ${formatCard(dealer.cards[0])}`,
    "Sa seconde carte est cachée. Il jouera après toi (il pioche jusqu'à 17) et dévoilera sa main demain à la clôture.",
    "",
  ];
}

// ── Embed / composants du jour de présentation (annonce) ─────────────
// Publié au lancement manuel, la veille du Jour 1 (même modèle que Mario
// Clash) : aucun bouton d'action, seulement Règles.

function buildAnnonceEmbed(config) {
  return {
    title: "🃏 Blackjack : la table ouvre demain",
    description: [
      `Le Croupier s'installe pour **${config.duree_jours} jours** : bats-le chaque jour pour cumuler des points (2 par victoire, 1 en cas d'égalité).`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: BLACKJACK_COLOR,
    image: { url: BLACKJACK_START_IMAGE_URL },
    footer: { text: `La partie commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

function buildAnnonceComponents() {
  return [
    {
      type: 1,
      components: [
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
    title: `🃏 Blackjack (Jour ${jour}/${config.duree_jours})`,
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
  return `Manche ${record.manche} : 🏆 ${winners} (${record.maxPoints} pts)`;
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
            (r, i, list) =>
              `${rangExAequo(list, i, memeRang)}. ${r.username} (${r.points} pt${r.points > 1 ? "s" : ""})`,
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
    title: "🏁 Blackjack : révélation finale",
    description: lines.join("\n"),
    color: BLACKJACK_COLOR,
    image: { url: BLACKJACK_START_IMAGE_URL },
  };
}

// ── Publication quotidienne (appelée uniquement par jeux/scripts/postBlackjack.js) ──

async function publishAndWriteState(
  channelId,
  previousState,
  { phase = "jour", jour, dealer, embed, components, noPing, termine = false },
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

  // Ping à chaque post (annonce, Jour 1, jours suivants, révélation finale) — comme
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
    phase,
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
  // reprise ici (voir jeux/CONTRIBUTING.md — incident réel du 23/08/2026 sur Quiz).
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une partie déjà lancée manuellement
  // (l'état "annonce" compte comme partie lancée).
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état -> jour de présentation (jamais le Jour 1 directement).
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = buildAnnonceComponents();
    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      dealer: null,
      embed,
      components,
      noPing,
      termine: false,
    });
  }

  // 2) Transition présentation -> Jour 1 : rien à clôturer, initialisation
  // de la partie (remise à zéro des points) puis ouverture de la table.
  if (state.phase === "annonce") {
    const jour = 1;
    const dealer = dealerPlay();
    const embed = await buildDayEmbed(jour, config, dealer, {
      estPremierJour: true,
    });
    const components = buildDayComponents(jour);

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, phase: "jour", jour, embed, components, pingRoleId };
    }

    await resetPoints();
    return publishAndWriteState(channelId, state, {
      phase: "jour",
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
      // Points simulés selon pointsForResult() (2/1/0), sans écrire dans
      // Redis — pure projection pour npm run blackjack:status / --dry-run.
      for (const r of results) {
        const pts = pointsForResult(r.result, r.double);
        if (pts > 0) pointsActuels[r.discordId] = (pointsActuels[r.discordId] || 0) + pts;
      }
      // Cartes du jour projeté ajoutées aux totaux déjà résolus, pour un
      // départage des ex-æquo cohérent avec la vraie clôture.
      const cardsDrawn = addResultsCardsToTotals(await sumCardsPerPlayer(), results);
      const ranking = buildRanking(pointsActuels, await readUsernames(), cardsDrawn);
      const embed = await buildRevealEmbed(state.dealer, results, ranking, []);
      return { dryRun: true, final: true, embed };
    }
    const nextDealerPreview = dealerPlay();
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
    await addPoints(r.discordId, pointsForResult(r.result, r.double));
  }
  await writeHistoriqueEntry(state.jour, {
    jour: state.jour,
    dealer: state.dealer,
    results,
    resolvedAt: new Date().toISOString(),
  });

  if (estFinDeManche) {
    const points = await readPoints();
    const cardsDrawn = await sumCardsPerPlayer();
    const ranking = buildRanking(points, await readUsernames(), cardsDrawn);
    // Jamais archivé en dry-run NI sur le salon de test (isPublic) — seule
    // une vraie publication publique compte comme une manche réelle (même
    // principe que les autres jeux, voir jeux/CONTRIBUTING.md).
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

  const nextDealer = dealerPlay();
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

// Le Croupier joue après tous les joueurs : le résultat n'est connu qu'à
// la clôture, sauf s'il a un Blackjack (vérifié d'emblée, la main s'arrête
// aussitôt). ⚠️ Rien d'autre de sa main ne doit fuiter.
const pts = (n) => `${n} point${n > 1 ? "s" : ""}`;

function handStatusMessage(hand, dealer) {
  if (dealerHasNatural(dealer) && hand.cards.length === 2 && hand.status !== "en_cours") {
    const result = compareToDealer(hand, dealer);
    return result === "push"
      ? "🎩 Le Croupier a un Blackjack, mais toi aussi : égalité, tu gagnes quand même 1 point aujourd'hui ! 🤝"
      : "🎩 Le Croupier a un Blackjack, personne ne peut le battre aujourd'hui. Pas de point, rendez-vous demain !";
  }
  if (hand.status === "bust") {
    return `💥 Tu dépasses 21${hand.double ? " sur ta mise doublée" : ""}, ta main est perdue pour aujourd'hui. Rendez-vous demain pour une nouvelle chance !`;
  }
  if (hand.status === "stand") {
    const intro = hand.cards.length === 2 && hand.score === 21
      ? "🎉 Blackjack ! 21 sur deux cartes : 3 points si le Croupier n'en a pas aussi."
      : hand.double
        ? `💰 Mise doublée : tu t'arrêtes à ${hand.score}, points doublés si tu gagnes.`
        : `🛑 Tu t'arrêtes à ${hand.score}.`;
    return `${intro} Le Croupier joue après toi, résultat demain à la clôture.`;
  }
  return canDouble(hand)
    ? "Pioche pour te rapprocher de 21, arrête-toi, ou double (une seule carte de plus, points doublés)."
    : "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";
}

// Variante condensée pour le Journal (main déjà affichée juste avant)
function journalStatusMessage(hand, dealer) {
  if (dealerHasNatural(dealer) && hand.cards.length === 2 && hand.status !== "en_cours") {
    return compareToDealer(hand, dealer) === "push"
      ? "Blackjack contre Blackjack : égalité, 1 point. 🤝"
      : "Le Croupier a un Blackjack, pas de point aujourd'hui.";
  }
  if (hand.status === "bust") return "💥 Ta main est perdue pour aujourd'hui. Rendez-vous demain pour une nouvelle chance !";
  if (hand.status === "stand") return `${hand.double ? "Mise doublée. " : ""}Le Croupier dévoile sa main demain à la clôture.`;
  return "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";
}

// Image de la main (blackjackImage.js) : carte visible du Croupier et sa
// carte cachée en haut (main entière seulement sur un Blackjack, déjà
// connu du joueur), main du joueur en bas.
function urlImageMain(jour, hand, dealer) {
  const blackjackCroupier = dealerHasNatural(dealer) && hand.status !== "en_cours";
  const param = encodeMain({
    joueur: {
      nom: hand.username ?? "Toi",
      cartes: hand.cards,
      score: hand.score,
      statut: hand.status,
      issue: blackjackCroupier ? compareToDealer(hand, dealer) : null,
      double: hand.double,
    },
    croupier: blackjackCroupier
      ? { nom: "Croupier", cartes: dealer.cards, score: dealer.score }
      : { nom: "Croupier", cartes: dealer.cards.slice(0, 1), cache: true },
    legende: `Jour ${jour}`,
  });
  return `${TRUST_ROYALE_URL}/api/blackjack/main?d=${param}`;
}

function buildHandEmbed(jour, hand, message, dealer) {
  return {
    title: `🃏 Ta main (Jour ${jour})`,
    description: message,
    image: { url: urlImageMain(jour, hand, dealer) },
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
          emoji: { name: "👆" },
          custom_id: `blackjack_piocher:${jour}`,
        },
        {
          type: 2,
          style: 1,
          label: "Arrêter",
          emoji: { name: "🛑" },
          custom_id: `blackjack_arreter:${jour}`,
        },
        ...(canDouble(hand)
          ? [
              {
                type: 2,
                style: 2,
                label: "Doubler",
                emoji: { name: "💰" },
                custom_id: `blackjack_doubler:${jour}`,
              },
            ]
          : []),
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
            handStatusMessage(existing, state.dealer),
            state.dealer,
          ),
        ],
        components: buildHandComponents(jour, existing),
      });
      return;
    }

    // Un Blackjack du Croupier arrête la main d'emblée
    const hand = dealHand(username, state.dealer);
    await writeHand(jour, discordId, hand);

    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(jour, hand, handStatusMessage(hand, state.dealer), state.dealer),
      ],
      components: buildHandComponents(jour, hand),
    });
  } catch (err) {
    console.error("[Blackjack] Échec Jouer:", err.message);
  }
}

async function handleDrawOrStand(webhookUrl, jour, discordId, { draw, double = false }) {
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
            state.dealer,
          ),
        ],
        components: [],
      });
      return;
    }

    if (double && !canDouble(hand)) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(jour, hand, "On ne peut doubler que sur ses 2 premières cartes.", state.dealer)],
        components: buildHandComponents(jour, hand),
      });
      return;
    }
    const updated = applyHandAction(hand, double ? "doubler" : draw ? "piocher" : "arreter");
    await writeHand(jour, discordId, updated);

    await patchOriginal(webhookUrl, {
      embeds: [
        buildHandEmbed(
          jour,
          updated,
          handStatusMessage(updated, state.dealer),
          state.dealer,
        ),
      ],
      components: buildHandComponents(jour, updated),
    });
  } catch (err) {
    console.error(
      `[Blackjack] Échec ${double ? "Doubler" : draw ? "Piocher" : "Arrêter"}:`,
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

export async function handleDoubler(webhookUrl, jour, discordId) {
  return handleDrawOrStand(webhookUrl, jour, discordId, { draw: true, double: true });
}

// ── Bouton [📜 Journal] — lecture seule ─────────────────────────────

function formatHistoriqueLine(entry, discordId) {
  const mine = entry.results?.find((r) => r.discordId === discordId);
  const gain = mine ? pointsForResult(mine.result, mine.double) : 0;
  const monResultat = !mine
    ? " (tu n'as pas joué)"
    : mine.result === "blackjack"
      ? ` (🎉 Blackjack, +${gain})`
      : mine.result === "win"
        ? ` (🏆 tu as gagné, +${gain})`
        : mine.result === "push"
          ? ` (🤝 égalité, +${gain})`
          : " (❌ tu as perdu)";
  const croupier = dealerHasNatural(entry.dealer) ? "Blackjack" : entry.dealer.score > 21 ? "dépasse 21" : entry.dealer.score;
  return `Jour ${entry.jour} : Croupier **${croupier}**${monResultat}`;
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
    if (state.phase === "annonce") {
      await patchOriginal(webhookUrl, {
        content: `La partie commence demain à ${formatUtcTimeAsParis(8)}, rien à consulter pour l'instant.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const [config, hand, points, usernames, { entries }, cardsDrawn] = await Promise.all([
      loadBlackjackConfig(),
      readHand(state.jour, discordId),
      readPoints(),
      readUsernames(),
      listHistorique({ limit: 10 }),
      sumCardsPerPlayer(),
    ]);

    const ranking = buildRanking(points, usernames, cardsDrawn);
    const resolvedRanking = await Promise.all(
      ranking.slice(0, 10).map(async (r) => ({
        ...r,
        username: await resolveDisplayName(r.discordId, r.username),
      })),
    );

    const lines = [`**Jour ${state.jour}/${config.duree_jours}**`];
    if (hand) {
      lines.push(
        `Ta main aujourd'hui : ${formatCards(hand.cards)} (**${hand.score}**). ${journalStatusMessage(hand, state.dealer)}`,
      );
    } else {
      lines.push(
        "Tu n'as pas encore joué aujourd'hui, clique sur **Jouer** !",
      );
    }

    const myRankIndex = ranking.findIndex((r) => r.discordId === discordId);
    const myPoints = myRankIndex === -1 ? 0 : ranking[myRankIndex].points;
    const myRank = myRankIndex === -1 ? null : rangExAequo(ranking, myRankIndex, memeRang);
    lines.push(
      `Ton total : **${myPoints} pt${myPoints > 1 ? "s" : ""}**${myRank == null ? "" : ` (${myRank}${myRank === 1 ? "er" : "ème"} au classement)`}`,
    );

    lines.push(
      "",
      "**Classement cumulé (top10) :**",
      ...(resolvedRanking.length
        ? resolvedRanking.map(
            (r, i, list) =>
              `${rangExAequo(list, i, memeRang)}. ${r.username} (${r.points} pt${r.points > 1 ? "s" : ""})`,
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
    title: "📖 Règles du Blackjack",
    description: [
      "Bats le Croupier chaque jour pendant 7 jours pour cumuler des points.",
      "",
      "**Valeur des cartes :** 2 à 10 = leur valeur, Valet/Dame/Roi = 10, As = 11 ou 1 (automatiquement ramené à 1 si besoin pour éviter de dépasser 21).",
      "",
      "**Déroulement (1 main par jour, définitive) :**",
      "🃏 **Jouer** : reçois 2 cartes.",
      "👆 **Piocher** : reçois une carte de plus (autant de fois que tu veux).",
      "🛑 **Arrêter** : fige ton score pour aujourd'hui.",
      "💰 **Doubler** : sur tes 2 premières cartes seulement, une seule carte de plus puis ta main s'arrête, points doublés.",
      "Dépasser 21 = main perdue immédiatement pour la journée.",
      "",
      "**Le Croupier :** une de ses deux cartes est visible dès l'ouverture, l'autre est cachée. Il joue après les joueurs : il pioche jusqu'à 17 et peut dépasser 21. Sa main est dévoilée à la clôture. S'il a un Blackjack, ta main s'arrête tout de suite.",
      "",
      "**Résultat quotidien :** battre le Croupier sans dépasser 21 rapporte **2 points** (s'il dépasse 21, toute main valide gagne). Égalité = **1 point**. **Blackjack** (21 avec tes 2 premières cartes) = **3 points**, et il bat un 21 en 3 cartes ou plus. Main doublée = points doublés. Une main non jouée ne rapporte ni ne coûte rien.",
      "",
      `Au Jour ${config.duree_jours}, le classement cumulé désigne le(s) vainqueur(s) de la manche.`,
      "",
      "📜 **Journal** : consulte ta main du jour, le classement cumulé et l'historique des jours précédents. Simple lecture, clique dessus autant de fois que tu veux.",
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
