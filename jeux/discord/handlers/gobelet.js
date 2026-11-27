// ============================================================
// gobelet.js — Handlers Discord pour le Jeu du Gobelet (7 jours, dés façon
// Yahtzee, classement cumulé au Jour 7). Pas d'adversaire : chaque jour, le
// joueur lance 5 dés, peut en conserver 0 à 5 et relancer les autres, deux
// fois de suite (3 tirages au total), puis la meilleure combinaison
// possible sur le résultat final lui rapporte des points.
// Embed, boutons d'action (Jouer/dés à conserver/Relancer), Règles, Journal.
// La publication/suppression quotidienne passe uniquement par
// jeux/scripts/postGobelet.js (postGobelet) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadGobeletConfig,
  readState,
  writeState,
  rollDice,
  rerollKept,
  computeBestCombination,
  resolveJour,
  readHand,
  writeHand,
  listHands,
  readKept,
  setKeptField,
  resetKept,
  addPoints,
  readPoints,
  readAllUsernames,
  resetPoints,
  buildRanking,
  writeHistoriqueEntry,
  listHistorique,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
  readUsedCategories,
  readAllUsedCategories,
  writeUsedCategories,
  resetUsedCategories,
  withUsedCategory,
  formatBaremeLines,
  listChoices,
  finishHand,
  pickChoice,
  withHandLock,
  JOKER,
  NO_COMBINATION,
} from "../../services/gobelet.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";
import {
  JOURNEE,
  SOIR,
  creneauJouable,
  creneauDepuis,
  messageHorsCreneau,
} from "../../services/creneaux.js";
import { URL_JEUX } from "../../services/urlJeux.js";

// Deux mains par jour (creneaux.js) : journée 8h30-20h, soir 20h-8h, chacune
// avec ses propres combinaisons réalisées et son Joker
const EMOJI_CRENEAU = { [JOURNEE]: "☀️", [SOIR]: "🌙" };
const DE_CRENEAU = { [JOURNEE]: "de la journée", [SOIR]: "du soir" };

const GOBELET_COLOR = 0x9b59b6;

// Illustrations statiques (jeux/public/images/gobelet/), même principe
// que BLACKJACK_*_IMAGE_URL dans _handlers/blackjack.js. gobelet.webp pour
// l'annonce, le Jour 1 et la révélation finale (Jour 8) ; dices.webp pour
// les jours intermédiaires (2 à 7).
//
// Suffixe ?v= : Discord met en cache une image par URL EXACTE, y compris
// après remplacement du fichier. Incrémenter IMAGE_VERSION force Discord à
// refaire un fetch à chaque remplacement de fichier.
const GOBELET_IMAGE_VERSION = 1;
const GOBELET_GAME_IMAGE_URL = `${URL_JEUX}/images/gobelet/dices.webp?v=${GOBELET_IMAGE_VERSION}`;
const GOBELET_START_IMAGE_URL = `${URL_JEUX}/images/gobelet/gobelet.webp?v=${GOBELET_IMAGE_VERSION}`;

const DAY1_INTRO =
  "**Le Gobelet est prêt !** Lance tes dés deux fois par jour pendant 7 jours pour cumuler des points. Clique sur *Règles* pour le barème complet.";

// ── Dés — rendu texte ──────────────────────────────────────────────
// Chiffres "keycap" (1️⃣-6️⃣) plutôt que les glyphes Unicode de dés
// (⚀-⚅) : mêmes raisons que le choix rang+couleur pour les cartes de
// Blackjack (29/08) — les keycaps sont de vrais emoji couleur qui
// s'agrandissent normalement sous un titre H1, contrairement aux glyphes
// texte qui resteraient minuscules. Les faces de dé communes
// (jeux/services/dices.js) ne servent pas ici : la sélection des dés était
// moins lisible (décision du 27/10).
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

// ── Résolution d'un jour — rendu texte partagé (recap + révélation finale) ──
// Résumé plutôt que liste exhaustive (même principe que Blackjack, 29/08) :
// avec beaucoup de joueurs, détailler la main de chacun rendrait le message
// public illisible. Seuls les meilleurs scores sont nommés ; chacun
// retrouve le détail de SA propre main dans le bouton Journal.

async function formatResultsSection(results) {
  if (!results.length) return ["Personne n'a joué ce jour-là."];

  const lines = [
    `${results.length} joueur${results.length > 1 ? "s ont" : " a"} joué.`,
  ];
  const maxPoints = Math.max(...results.map((r) => r.points));
  if (maxPoints === 0) return [...lines, "Personne n'a marqué de point."];
  const winners = results.filter((r) => r.points === maxPoints);
  // Une ligne par combinaison : deux meilleurs scores à égalité peuvent
  // venir de combinaisons différentes (ex. Somme ≤ 7 et Somme ≥ 28).
  const byCategory = new Map();
  for (const r of winners) {
    const name = await resolveDisplayName(r.discordId, r.username);
    byCategory.set(r.category, [...(byCategory.get(r.category) || []), name]);
  }
  for (const [category, names] of byCategory) {
    lines.push(
      `🏆 ${names.join(", ")} : ${category} (${maxPoints} pt${maxPoints > 1 ? "s" : ""})`,
    );
  }

  return lines;
}

// Bilan d'un jour : un bloc par créneau
async function formatBilanJour({ results, resultsSoir }) {
  if (!resultsSoir) return formatResultsSection(results);
  return [
    `${EMOJI_CRENEAU[JOURNEE]} **Journée**`,
    ...(await formatResultsSection(results)),
    `${EMOJI_CRENEAU[SOIR]} **Soir**`,
    ...(await formatResultsSection(resultsSoir)),
  ];
}

// ── Embed / composants du jour d'annonce ───────────────────────────
// Tous les jeux spéciaux ont au moins un jour de présentation avant le
// Jour 1 (voir jeux/CONTRIBUTING.md) : le lancement manuel publie cette annonce,
// le cron du lendemain publie le Jour 1.

function buildAnnonceEmbed(config) {
  return {
    title: "🎲 Jeu du Gobelet : les dés sont prêts…",
    description: [
      "Un nouveau jeu arrive sur l'Arène : lance tes dés façon Yahtzee et réalise les meilleures combinaisons !",
      "",
      `📅 **${config.duree_jours} jours de jeu**, à partir de demain : deux mains par jour (8h30-20h, puis 20h-8h), 5 dés et jusqu'à 2 relances pour marquer un maximum de points.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: GOBELET_COLOR,
    image: { url: GOBELET_START_IMAGE_URL },
    footer: {
      text: "La partie commence demain à 8h30.",
    },
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
          custom_id: "gobelet_regles",
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
          emoji: { name: "🎲" },
          custom_id: `gobelet_jouer:${jour}`,
        },
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "gobelet_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "gobelet_regles",
        },
      ],
    },
  ];
}

function buildTodaySection() {
  return [
    "## 🎲 À toi de jouer",
    "Clique sur **Jouer** pour lancer tes 5 dés. Tu pourras ensuite conserver les dés de ton choix et relancer les autres, deux fois de suite.",
    "",
    "☀️ Main de la journée de 8h30 à 20h, 🌙 main du soir de 20h à 8h.",
    "",
    "Consulte **Règles** pour le barème complet des combinaisons.",
  ];
}

async function buildDayEmbed(
  jour,
  config,
  { estPremierJour, bilan },
) {
  const lines = [];
  if (estPremierJour) {
    lines.push(DAY1_INTRO, "");
  } else {
    lines.push(`**📊 Bilan du Jour ${jour - 1}**`, ...(await formatBilanJour(bilan)), "");
  }
  lines.push(...buildTodaySection());

  return {
    title: `🎲 Jeu du Gobelet (Jour ${jour}/${config.duree_jours})`,
    description: lines.join("\n"),
    color: GOBELET_COLOR,
    image: {
      url: estPremierJour ? GOBELET_START_IMAGE_URL : GOBELET_GAME_IMAGE_URL,
    },
    footer: {
      text: "Deux mains par jour : de 8h30 à 20h, puis de 20h à 8h (décompte à 8h).",
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

// Trophées honorifiques ponctuels (ex. « Trophée du missclick »), saisis à
// la main dans gobelet.json pour une partie donnée : à vider ensuite. Même
// principe que Mario Clash.
function buildTropheesSection(trophees = []) {
  if (!trophees.length) return [];
  return [
    "",
    "**🎖️ Mentions spéciales**",
    ...trophees.map((t) => `${t.emoji} **${t.label}** : ${t.username}`),
  ];
}

async function buildRevealEmbed(bilan, ranking, manchesHistory, config) {
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({
      ...r,
      username: await resolveDisplayName(r.discordId, r.username),
    })),
  );

  const lines = [
    `**📊 Bilan du dernier jour**`,
    ...(await formatBilanJour(bilan)),
    "",
    "**Classement final :**",
    ...(resolvedRanking.length
      ? resolvedRanking
          .slice(0, 20)
          .map(
            (r, i, list) =>
              `${rangExAequo(list, i)}\\. ${r.username} (${r.points} pt${r.points > 1 ? "s" : ""})`,
          )
      : ["Personne n'a marqué de point cette manche."]),
    ...buildTropheesSection(config?.trophees),
  ];

  if (manchesHistory.length) {
    lines.push(
      "",
      "**Vainqueurs des manches précédentes :**",
      ...manchesHistory.map(formatMancheHistoryLine),
    );
  }

  return {
    title: "🏁 Jeu du Gobelet : révélation finale",
    description: lines.join("\n"),
    color: GOBELET_COLOR,
    image: { url: GOBELET_START_IMAGE_URL },
  };
}

// ── Publication quotidienne (appelée uniquement par jeux/scripts/postGobelet.js) ──

async function publishAndWriteState(
  channelId,
  previousState,
  { phase = "jour", jour, embed, components, noPing, termine = false },
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
          `[Gobelet] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Gobelet] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Ping à chaque post (annonce, jours, révélation finale) — comme
  // Comme Blackjack, une action est attendue CHAQUE jour (lancer ses dés).
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
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
  });

  return { jour, embed, message, termine };
}

export async function postGobelet(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  // ⚠️ Jamais de ping hors salon public, quel que soit l'appelant
  if (!isPublic) noPing = true;
  const config = await loadGobeletConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  // Garde-fou anti-double-avancée (même pattern que Blackjack et les autres
  // jeux à cron du repo) : jamais appliqué en dry-run, contournable avec --force.
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
  // reprise ici (voir jeux/CONTRIBUTING.md, « Salon test / salon public »).
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une partie déjà lancée manuellement.
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état -> jour de présentation (jamais de Jour 1 direct).
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
      embed,
      components,
      noPing,
      termine: false,
    });
  }

  // 2) Transition présentation -> Jour 1 : rien à clôturer. Un état sans
  // `phase` (partie lancée avant l'ajout de l'annonce) est un jour normal.
  if (state.phase === "annonce") {
    const jour = 1;
    const embed = await buildDayEmbed(jour, config, { estPremierJour: true });
    const components = buildDayComponents(jour);

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }

    await resetPoints();
    await resetUsedCategories();
    return publishAndWriteState(channelId, state, {
      jour,
      embed,
      components,
      noPing,
      termine: false,
    });
  }

  // Résolution du jour actif (state.jour).
  // Chaque créneau est résolu avec ses propres combinaisons réalisées
  const usedJournee = await readAllUsedCategories(JOURNEE);
  const usedSoir = await readAllUsedCategories(SOIR);
  const results = resolveJour(await listHands(state.jour, JOURNEE), usedJournee);
  const resultsSoir = resolveJour(await listHands(state.jour, SOIR), usedSoir);
  const toutes = [...results, ...resultsSoir];
  const bilan = { results, resultsSoir };
  const jourSuivant = state.jour + 1;
  const estFinDeManche = jourSuivant > config.duree_jours;

  if (dryRun) {
    if (estFinDeManche) {
      const pointsActuels = await readPoints();
      // Points simulés selon results[].points, sans écrire dans Redis —
      // pure projection pour npm run gobelet:status / --dry-run.
      for (const r of toutes) {
        pointsActuels[r.discordId] =
          (pointsActuels[r.discordId] || 0) + r.points;
      }
      const ranking = buildRanking(pointsActuels, await readAllUsernames());
      const embed = await buildRevealEmbed(bilan, ranking, [], config);
      return { dryRun: true, final: true, embed };
    }
    const embed = await buildDayEmbed(jourSuivant, config, {
      estPremierJour: false,
      bilan,
    });
    return {
      dryRun: true,
      jour: jourSuivant,
      embed,
      components: buildDayComponents(jourSuivant),
    };
  }

  for (const [creneau, liste, usedByPlayer] of [[JOURNEE, results, usedJournee], [SOIR, resultsSoir, usedSoir]]) {
    for (const r of liste) {
      await addPoints(r.discordId, r.points);
      const used = usedByPlayer[r.discordId] || [];
      const nextUsed = withUsedCategory(used, r.category);
      if (nextUsed !== used) await writeUsedCategories(r.discordId, nextUsed, creneau);
    }
  }
  await writeHistoriqueEntry(state.jour, {
    jour: state.jour,
    results,
    resultsSoir,
    resolvedAt: new Date().toISOString(),
  });

  if (estFinDeManche) {
    const points = await readPoints();
    const ranking = buildRanking(points, await readAllUsernames());
    // Jamais archivé en dry-run NI sur le salon de test (isPublic) — seule
    // une vraie publication publique compte comme une manche réelle.
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
    const embed = await buildRevealEmbed(bilan, ranking, manches, config);
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      embed,
      components: [],
      noPing,
      termine: true,
    });
    return { ...result, final: true, manche: currentManche };
  }

  const embed = await buildDayEmbed(jourSuivant, config, {
    estPremierJour: false,
    bilan,
  });
  const components = buildDayComponents(jourSuivant);

  return publishAndWriteState(channelId, state, {
    jour: jourSuivant,
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
    console.error("[Gobelet] Échec PATCH:", err.message);
  }
}

// ── Main du joueur — Jouer / conserver un dé / Relancer ────────────
// Tout se joue en éphémère (message privé au joueur) : le message public du
// jour n'est jamais repatché, il n'y a aucun compteur à y afficher — la
// main de chacun reste secrète jusqu'à la clôture du lendemain.

function buildHandStatusMessage(hand, kept, jour, creneau) {
  if (hand.status === "termine") {
    return `🎯 Combinaison retenue : **${hand.category}**.\nTu gagnes **${hand.points} point${hand.points > 1 ? "s" : ""}** avec cette main !`;
  }
  if (hand.status === "choix") {
    return "🎯 Plusieurs combinaisons possibles : choisis celle à retenir dans la liste. Sans choix avant la fin du créneau, la plus payante (hors Joker) est retenue.";
  }
  const toReroll = kept.filter((k) => !k).length;
  const rerollsLeft = 3 - hand.tirage;
  // Consigne détaillée à la première main seulement, ensuite le joueur sait quoi faire
  if (jour > 1 || creneau === SOIR) {
    return `Tirage ${hand.tirage}/3. Il te reste ${rerollsLeft} lancer${rerollsLeft > 1 ? "s" : ""}.`;
  }
  return `Tirage ${hand.tirage}/3 : sélectionne les dés à conserver (🔒) puis clique sur **Relancer** pour relancer les ${toReroll} dé${toReroll > 1 ? "s" : ""} restant${toReroll > 1 ? "s" : ""}. Il te reste ${rerollsLeft} relance${rerollsLeft > 1 ? "s" : ""}.`;
}

// Combinaisons réalisées les jours précédents sur ce créneau : chacune ne
// rapporte qu'une fois par créneau, le joueur doit savoir lesquelles tenter.
function formatUsedLine(used, creneau) {
  return used.length ? ["", `🚫 Déjà réalisées (${creneau === SOIR ? "soir" : "journée"}) : ${used.join(", ")}`] : [];
}

function buildHandEmbed(jour, hand, kept, used, creneau, message = null) {
  return {
    title: `${EMOJI_CRENEAU[creneau]} Ta main ${DE_CRENEAU[creneau]} (Jour ${jour})`,
    description: [
      ...formatDiceBlock(hand.dice),
      "",
      message ?? buildHandStatusMessage(hand, kept, jour, creneau),
      ...formatUsedLine(used, creneau),
    ].join("\n"),
    color: GOBELET_COLOR,
  };
}

function relancerLabel(kept) {
  const count = kept.filter((k) => !k).length;
  return count === 0
    ? "Passer au tirage suivant"
    : `Relancer (${count} dé${count > 1 ? "s" : ""})`;
}

// Bouton de dé : 🔒 gardé / 🎲 relancé, la valeur en libellé.
function buildDieEmoji(kept) {
  return { name: kept ? "🔒" : "🎲" };
}

// Main en attente de choix : un select avec chaque combinaison possible
// (Joker compris s'il est libre), la plus payante en premier.
function buildChoiceComponents(customId, hand, used) {
  const choices = listChoices(hand.dice, used);
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: customId,
          placeholder: "Choisis ta combinaison",
          options: choices.map((c, i) => ({
            label: `${c.category} (${c.points} pt${c.points > 1 ? "s" : ""})`,
            value: c.category,
            emoji: { name: c.category === JOKER ? "🃏" : "🎯" },
            ...(i === 0 ? { description: "Le plus de points" } : {}),
          })),
        },
      ],
    },
  ];
}

// Le bouton Valider n'apparaît que si les dés COURANTS (indépendamment de
// ce qui est coché "à garder") forment déjà une combinaison pas encore
// réalisée — dès le 1ᵉʳ tirage. Le libellé ne nomme volontairement pas la
// combinaison : à chacun de la repérer.
// custom_id : `gobelet_<action>:<jour>:<créneau>` (dés : `gobelet_toggle:<jour>:<dé>:<créneau>`)
function buildHandComponents(jour, hand, kept, used, creneau) {
  if (hand.status === "choix") {
    return buildChoiceComponents(`gobelet_choix:${jour}:${creneau}`, hand, used);
  }
  if (hand.status !== "en_cours") return [];
  const { category } = computeBestCombination(hand.dice, used, {
    allowJoker: false,
  });
  const canValider = category !== NO_COMBINATION;
  const secondRow = [
    {
      type: 2,
      style: 1,
      label: relancerLabel(kept),
      emoji: { name: kept.every(Boolean) ? "➡️" : "🔁" },
      custom_id: `gobelet_relancer:${jour}:${creneau}`,
    },
  ];
  if (canValider) {
    secondRow.push({
      type: 2,
      style: 3,
      label: "Valider",
      emoji: { name: "👍" },
      custom_id: `gobelet_valider:${jour}:${creneau}`,
    });
  }
  return [
    {
      type: 1,
      components: hand.dice.map((value, i) => ({
        type: 2,
        style: kept[i] ? 3 : 2,
        label: String(value),
        emoji: buildDieEmoji(kept[i]),
        custom_id: `gobelet_toggle:${jour}:${i}:${creneau}`,
      })),
    },
    { type: 1, components: secondRow },
  ];
}

function isDayInactive(state, jour) {
  return !state || state.termine || String(state.jour) !== String(jour);
}

const NO_KEPT = [false, false, false, false, false];
const messageSeul = (content) => ({ content, embeds: [], components: [] });
const JOURNEE_CHANGEE = messageSeul("La journée a changé, regarde le nouveau message !");
const SANS_MAIN = messageSeul("Clique d'abord sur **Jouer** pour lancer tes 5 dés !");

// Contexte d'une action sur une main existante (boutons de l'éphémère) :
// null après avoir répondu (jour changé, pas de main, créneau terminé).
async function contexteMain(webhookUrl, jour, creneauBouton, discordId) {
  const state = await readState();
  if (isDayInactive(state, jour)) {
    await patchOriginal(webhookUrl, JOURNEE_CHANGEE);
    return null;
  }
  const creneau = creneauDepuis(creneauBouton);
  const [used, hand] = await Promise.all([
    readUsedCategories(discordId, creneau),
    readHand(jour, discordId, creneau),
  ]);
  if (!hand) {
    await patchOriginal(webhookUrl, SANS_MAIN);
    return null;
  }
  // Créneau terminé (20h ou décompte de 8h) : la main reste figée, elle
  // sera résolue à la clôture sur ses dés courants
  if (creneauJouable(state.publishedAt) !== creneau) {
    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, hand, NO_KEPT, used, creneau, `Le créneau ${DE_CRENEAU[creneau]} est terminé, ta main est figée.`)],
      components: [],
    });
    return null;
  }
  return { creneau, used, hand };
}

// Main déjà finie : repeint son état réel, sans action
async function repeindreMainFinie(webhookUrl, jour, { hand, used, creneau }) {
  await patchOriginal(webhookUrl, {
    embeds: [buildHandEmbed(jour, hand, NO_KEPT, used, creneau)],
    components: buildHandComponents(jour, hand, NO_KEPT, used, creneau),
  });
}

async function jouer(webhookUrl, jour, discordId, username) {
  try {
    const state = await readState();
    if (isDayInactive(state, jour)) {
      await patchOriginal(webhookUrl, JOURNEE_CHANGEE);
      return;
    }
    // Le créneau se décide à l'heure du clic (heure de Paris)
    const creneau = creneauJouable(state.publishedAt);
    if (!creneau) {
      await patchOriginal(webhookUrl, messageSeul(messageHorsCreneau(state.publishedAt)));
      return;
    }
    const used = await readUsedCategories(discordId, creneau);

    const existing = await readHand(jour, discordId, creneau);
    if (existing) {
      const kept =
        existing.status === "en_cours"
          ? await readKept(jour, discordId, creneau)
          : NO_KEPT;
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(jour, existing, kept, used, creneau)],
        components: buildHandComponents(jour, existing, kept, used, creneau),
      });
      return;
    }

    const dice = rollDice(5);
    const hand = {
      dice,
      tirage: 1,
      status: "en_cours",
      category: null,
      points: null,
      username,
    };
    await writeHand(jour, discordId, hand, creneau);
    await resetKept(jour, discordId, creneau);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, hand, NO_KEPT, used, creneau)],
      components: buildHandComponents(jour, hand, NO_KEPT, used, creneau),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Jouer:", err.message);
  }
}

export async function handleToggle(webhookUrl, jour, index, creneauBouton, discordId) {
  try {
    const ctx = await contexteMain(webhookUrl, jour, creneauBouton, discordId);
    if (!ctx) return;
    const { creneau, used, hand } = ctx;
    if (hand.status !== "en_cours") return repeindreMainFinie(webhookUrl, jour, ctx);

    const i = Number(index);
    const kept = await readKept(jour, discordId, creneau);
    await setKeptField(jour, discordId, i, !kept[i], creneau);
    const updatedKept = kept.map((k, idx) => (idx === i ? !k : k));

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, hand, updatedKept, used, creneau)],
      components: buildHandComponents(jour, hand, updatedKept, used, creneau),
    });
  } catch (err) {
    console.error("[Gobelet] Échec sélection de dé:", err.message);
  }
}

async function relancer(webhookUrl, jour, creneauBouton, discordId) {
  try {
    const ctx = await contexteMain(webhookUrl, jour, creneauBouton, discordId);
    if (!ctx) return;
    const { creneau, used, hand } = ctx;
    if (hand.status !== "en_cours") return repeindreMainFinie(webhookUrl, jour, ctx);

    const kept = await readKept(jour, discordId, creneau);
    const dice = rerollKept(hand.dice, kept, Math.random);
    const tirage = hand.tirage + 1;
    let updated;
    let nextKept;
    if (tirage >= 3) {
      updated = finishHand({ ...hand, dice, tirage }, used);
      await resetKept(jour, discordId, creneau);
      nextKept = NO_KEPT;
    } else {
      updated = { ...hand, dice, tirage };
      // kept N'EST PAS réinitialisé (retour utilisateur, 16/09) : les dés
      // déjà cochés "à garder" le restent au tirage suivant — seuls les dés
      // qui viennent d'être relancés repartent "non gardés" par défaut
      // (déjà le cas, leur position n'a jamais été cochée).
      nextKept = kept;
    }
    await writeHand(jour, discordId, updated, creneau);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, updated, nextKept, used, creneau)],
      components: buildHandComponents(jour, updated, nextKept, used, creneau),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Relancer:", err.message);
  }
}

async function validerMain(webhookUrl, jour, creneauBouton, discordId) {
  try {
    const ctx = await contexteMain(webhookUrl, jour, creneauBouton, discordId);
    if (!ctx) return;
    const { creneau, used, hand } = ctx;
    if (hand.status !== "en_cours") return repeindreMainFinie(webhookUrl, jour, ctx);

    const { category } = computeBestCombination(hand.dice, used, {
      allowJoker: false,
    });
    if (category === NO_COMBINATION) {
      // Garde-fou : le bouton ne devrait normalement pas être cliquable
      // dans ce cas (voir buildHandComponents), mais un client Discord qui
      // affiche encore l'ancien message (avant un relance qui a changé les
      // dés) pourrait renvoyer ce clic — on ignore juste et on repeint l'état
      // réel plutôt que de figer une main sans combinaison.
      const kept = await readKept(jour, discordId, creneau);
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(jour, hand, kept, used, creneau)],
        components: buildHandComponents(jour, hand, kept, used, creneau),
      });
      return;
    }

    const updated = finishHand(hand, used);
    await writeHand(jour, discordId, updated, creneau);
    await resetKept(jour, discordId, creneau);

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(jour, updated, NO_KEPT, used, creneau)],
      components: buildHandComponents(jour, updated, NO_KEPT, used, creneau),
    });
  } catch (err) {
    console.error("[Gobelet] Échec Valider:", err.message);
  }
}

// Select de fin de main : fige la combinaison choisie par le joueur.
async function choisirCombinaison(webhookUrl, jour, creneauBouton, discordId, category) {
  try {
    const ctx = await contexteMain(webhookUrl, jour, creneauBouton, discordId);
    if (!ctx) return;
    const { creneau, used, hand } = ctx;
    // Choix invalide ou main déjà figée : on repeint simplement l'état réel.
    const updated = pickChoice(hand, used, category) ?? hand;
    if (updated !== hand) await writeHand(jour, discordId, updated, creneau);
    await repeindreMainFinie(webhookUrl, jour, { ...ctx, hand: updated });
  } catch (err) {
    console.error("[Gobelet] Échec choix de combinaison:", err.message);
  }
}

// Jouer / Relancer / Valider / choix passent par un verrou par joueur
// (voir withHandLock) : un clic simultané est ignoré au lieu de relancer.
// Verrou commun aux deux créneaux (Jouer ne connaît pas encore le sien).
function verrouille(action) {
  return async (webhookUrl, jour, ...rest) => {
    const discordId = action === jouer ? rest[0] : rest[1];
    try {
      await withHandLock(`gobelet:lock:${jour}:${discordId}`, () =>
        action(webhookUrl, jour, ...rest),
      );
    } catch (err) {
      console.error("[Gobelet] Échec verrou de main:", err.message);
    }
  };
}

// Signatures : (webhookUrl, jour, discordId, username) pour Jouer,
// (webhookUrl, jour, créneau, discordId[, category]) pour les autres
export const handleJouer = verrouille(jouer);
export const handleRelancer = verrouille(relancer);
export const handleValider = verrouille(validerMain);
export const handleChoisir = verrouille(choisirCombinaison);

// ── Bouton [📜 Journal] — lecture seule ─────────────────────────────

function formatResultatCreneau(results, discordId) {
  const mine = results?.find((r) => r.discordId === discordId);
  return !mine ? "pas jouée" : `**${mine.category}** (${mine.points} pt${mine.points > 1 ? "s" : ""})`;
}

function formatHistoriqueLine(entry, discordId) {
  const journee = formatResultatCreneau(entry.results, discordId);
  if (!entry.resultsSoir) return `Jour ${entry.jour} : ${journee}`;
  return `Jour ${entry.jour} : ☀️ ${journee} · 🌙 ${formatResultatCreneau(entry.resultsSoir, discordId)}`;
}

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie du Jeu du Gobelet en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (state.phase === "annonce") {
      await patchOriginal(webhookUrl, {
        content: "La partie commence demain à 8h30 !",
        embeds: [],
        components: [],
      });
      return;
    }

    const [config, hand, handSoir, points, historique] = await Promise.all([
      loadGobeletConfig(),
      readHand(state.jour, discordId, JOURNEE),
      readHand(state.jour, discordId, SOIR),
      readPoints(),
      listHistorique({ limit: 10 }),
    ]);

    const ranking = buildRanking(points, await readAllUsernames());
    const resolvedRanking = await Promise.all(
      ranking
        .slice(0, 10)
        .map(async (r) => ({
          ...r,
          username: await resolveDisplayName(r.discordId, r.username),
        })),
    );

    const lines = [`**Jour ${state.jour}/${config.duree_jours}**`];
    for (const [creneau, h] of [[JOURNEE, hand], [SOIR, handSoir]]) {
      const libelle = `${EMOJI_CRENEAU[creneau]} Ta main ${DE_CRENEAU[creneau]}`;
      if (!h) {
        lines.push(`${libelle} : pas encore jouée.`);
        continue;
      }
      const detail =
        h.status === "termine"
          ? `**${h.category}** (${h.points} pt${h.points > 1 ? "s" : ""})`
          : h.status === "choix"
            ? "combinaison à choisir (clique sur **Jouer**)"
            : `en cours (tirage ${h.tirage}/3)`;
      lines.push(`${libelle} : ${formatDice(h.dice)} (${detail})`);
    }

    lines.push(
      "",
      "**Classement cumulé :**",
      ...(resolvedRanking.length
        ? resolvedRanking.map(
            (r, i, list) =>
              `${rangExAequo(list, i)}\\. ${r.username} (${r.points} pt${r.points > 1 ? "s" : ""})`,
          )
        : ["Personne n'a encore marqué de point."]),
    );

    if (historique.length > 0) {
      lines.push(
        "",
        "**Jours précédents :**",
        ...historique.map((e) => formatHistoriqueLine(e, discordId)),
      );
    }

    const embed = {
      title: "📜 Journal",
      description: lines.join("\n"),
      color: GOBELET_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Gobelet] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du Jeu du Gobelet",
    description: [
      "Lance tes dés deux fois par jour pendant 7 jours pour cumuler des points.",
      "",
      "**Deux mains par jour, définitives** (heure de Paris) : ☀️ une de 8h30 à 20h, 🌙 une de 20h à 8h. Une main pas finie à la fin de son créneau est jugée sur ses dés.",
      "",
      "**Déroulement d'une main :**",
      "🎲 **Jouer** : lance tes 5 dés.",
      "🔒 **Clique sur un dé** pour le conserver (ou le relâcher) avant la relance.",
      "🔁 **Relancer** : relance tous les dés non conservés. Possible 2 fois, donc 3 tirages au total.",
      "👍 **Valider** : dès que tes dés forment une combinaison encore libre (hors Joker), arrête tes relances immédiatement.",
      "🎯 **Choix de la combinaison** : si tes dés en forment plusieurs encore libres (Joker compris), choisis celle à retenir dans la liste, par exemple pour garder la plus payante pour un autre jour. Sans choix avant la fin du créneau, la plus payante (hors Joker) est retenue.",
      "",
      "**Une combinaison différente chaque jour :** chaque combinaison (et le Joker) ne rapporte des points qu'une seule fois par partie et par créneau : une fois en journée, une fois le soir. Les combinaisons déjà réalisées sur le créneau ne sont plus proposées ; s'il n'en reste aucune dans tes dés : 0 pt.",
      "",
      "**Barème :**",
      ...formatBaremeLines(),
      "",
      `Au Jour ${config.duree_jours}, le classement cumulé désigne le(s) vainqueur(s) de la manche.`,
      "",
      "📜 **Journal** : consulte tes mains du jour, le classement cumulé et l'historique des jours précédents. Simple lecture, clique dessus autant de fois que tu veux.",
    ].join("\n"),
    color: GOBELET_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadGobeletConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Gobelet] Échec Règles:", err.message);
  }
}
