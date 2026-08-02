// ============================================================
// robinson.js — Handlers Discord pour Robinson (survie insulaire
// communautaire). Embed, boutons d'action (vote), Journal de Bord.
// La publication/suppression quotidienne passe uniquement par
// scripts/postRobinson.js (postRobinson) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadRobinsonConfig,
  loadNarratifs,
  readState,
  writeState,
  initEconomy,
  readStocks,
  readRadeauPoints,
  harvestResource,
  attemptRaftContribution,
  recordVote,
  releaseVoteSlot,
  writeVoteDetail,
  getVoteDetail,
  tallyVotes,
  countUniqueVoters,
  listVotes,
  listHistorique,
  rollHarvestAmount,
  rollCappedEventAmount,
  rollExplorerYield,
  harvestCapForEvent,
  isExplorerDisabled,
  computeDailyConsumption,
  computeRaftSections,
  isSurvivalVictory,
  eventForDay,
  previewCloseDay,
  closeDayAndAdvance,
} from "../../../backend/services/robinson.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const ROBINSON_COLOR = 0x1abc9c;
const RESOURCE_LABELS = { poisson: "poisson(s)", eau: "eau", bois: "bois" };
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustration du jour — fichiers statiques frontend/public/images/robinson/
// (rob-01.webp à rob-10.webp), servis tels quels par Vercel, même principe
// que tamagotchiImageUrl() dans api/discord/handlers/tamagotchi.js.
function robinsonImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/robinson/rob-${String(jour).padStart(2, "0")}.webp`;
}

// Pitch affiché uniquement au Jour 1 — plante le décor et rappelle le
// principe en 2 phrases, avant de renvoyer vers le bouton Règles du jeu pour
// le détail complet (barème, consommation, événements).
const DAY1_INTRO =
  "⛵ **Naufrage général !** Le navire qui emmenait le clan vers le prochain tournoi d’Arène a sombré cette nuit dans la tempête. Par miracle, tout le monde s’est échoué sain et sauf sur une île déserte — sans le moindre Coffre à l’horizon.\n\n" +
  "Tenez 10 jours, le temps que les secours repèrent l’épave, ou évadez-vous plus tôt en achevant un Radeau. Chaque membre vote une fois par jour ; si une ressource tombe à 0 deux jours de suite, c’est le naufrage définitif. Besoin d’un rappel ? Clique sur *Règles du jeu*.";

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans data/robinson/narratifs.json (pas
// dans le code), même principe que data/tamagotchi/narratifs.json. La
// sélection est déterministe (indexée par le jour, pas Math.random()) : le
// narratif ne doit jamais changer entre deux ré-affichages du MÊME jour (ex.
// après chaque clic de vote qui repatch l'embed), seulement d'un jour à
// l'autre — même si la catégorie de stock (bas/normal/haut), elle, peut
// légitimement changer en cours de journée si le stock franchit un seuil.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

function stockCategory(resource, value) {
  if (value <= 3) return `${resource}_bas`;
  if (value >= 12) return `${resource}_haut`;
  return `${resource}_normal`;
}

async function pickVoterNames(voters) {
  if (!voters?.length) return [];
  const picked = voters.slice(0, 2);
  const resolved = await Promise.all(
    picked.map((v) => resolveDisplayName(v.discordId, v.username)),
  );
  return resolved.filter(Boolean);
}

async function buildNarrative(jour, stocks, voters, estPremierJour) {
  if (estPremierJour) return DAY1_INTRO;

  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);

  const lines = [
    pickFlavor(narratifs[stockCategory("poisson", stocks.poisson)], jour + 1),
    pickFlavor(narratifs[stockCategory("eau", stocks.eau)], jour + 2),
    pickFlavor(narratifs[stockCategory("bois", stocks.bois)], jour + 3),
  ];

  const names = await pickVoterNames(voters);
  if (names.length) {
    const template = pickFlavor(narratifs.cloture_votants, jour + 4);
    lines.push(template.replaceAll("{noms}", names.join(" et ")).replaceAll("{premier}", names[0]));
  }

  return `${intro}\n\n${lines.join("\n")}`;
}

// ── Embed / composants du jour ────────────────────────────────────

function formatStockLine(emoji, label, value) {
  const alerte = value === 0 ? " ⚠️ **à 0** — encore une journée comme ça et c'est la fin !" : "";
  return `${emoji} ${label} : **${value}**${alerte}`;
}

async function buildRobinsonEmbed(jour, stocks, radeauPoints, config, event, estPremierJour, voters) {
  const sections = computeRaftSections(radeauPoints, config.points_par_section);
  const raftBar = "🟩".repeat(sections) + "⬜".repeat(config.radeau_sections_max - sections);

  const narrative = await buildNarrative(jour, stocks, voters, estPremierJour);
  const lines = [narrative, ""];
  if (event) {
    lines.push(`**${event.emoji} Événement du jour : ${event.nom}**`, event.description, "");
  }
  lines.push(
    formatStockLine("🐟", "Nourriture", stocks.poisson),
    formatStockLine("💧", "Eau", stocks.eau),
    formatStockLine("🪵", "Bois", stocks.bois),
    "",
    `🛶 Radeau : [${raftBar}] (${sections}/${config.radeau_sections_max} sections)`,
  );

  return {
    title: `🏝️ Robinson — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: ROBINSON_COLOR,
    image: { url: robinsonImageUrl(jour) },
    footer: {
      text: estPremierJour
        ? "Naufragés ! Survivez ensemble jusqu’au Jour 11, ou évadez-vous avant en finissant le Radeau."
        : "Votez avant 08:00 UTC demain pour orienter la journée.",
    },
  };
}

function buildRobinsonComponents(jour, config, voteCounts, event) {
  const actionIds = Object.keys(config.actions).filter(
    (id) => !(id === "explorer" && isExplorerDisabled(event)),
  );

  return [
    {
      type: 1,
      components: actionIds.map((id) => {
        const action = config.actions[id];
        return {
          type: 2,
          style: 2,
          label: `${action.label} (${voteCounts[id] || 0})`.slice(0, 80),
          emoji: { name: action.emoji },
          custom_id: `robinson_vote:${jour}:${id}`,
        };
      }),
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Journal de Bord",
          emoji: { name: "📜" },
          custom_id: "robinson_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Règles du jeu",
          emoji: { name: "📖" },
          custom_id: "robinson_regles",
        },
      ],
    },
  ];
}

function buildOutcomeEmbed(outcome, config) {
  const image = { url: robinsonImageUrl(config.duree_jours) };
  if (outcome === "victoire_radeau") {
    return {
      title: "🛶 Victoire anticipée — le Radeau est achevé !",
      description:
        "Contre toute attente, la communauté a fini de construire le Radeau avant l’arrivée des secours ! Direction le large — l’île est enfin derrière vous.",
      color: 0xf1c40f,
      image,
    };
  }
  if (outcome === "victoire_jour11") {
    return {
      title: "🚢 Les secours sont arrivés !",
      description:
        "Après 10 jours de survie acharnée, un bateau apparaît enfin à l’horizon ! Bravo à tous les naufragés — vous avez survécu à l’île.",
      color: 0xf1c40f,
      image,
    };
  }
  return {
    title: "💀 Naufrage définitif…",
    description:
      "Une ressource critique est tombée à 0 deux jours de suite — l’île a eu raison du campement. L’aventure s’arrête ici.",
    color: 0x2c3e50,
    image,
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postRobinson.js) ──

export async function postRobinson(channelId, { dryRun = false, noPing = false } = {}) {
  const config = await loadRobinsonConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const stocks = config.stocks_initiaux;
    const embed = await buildRobinsonEmbed(jour, stocks, 0, config, null, true, []);
    const components = buildRobinsonComponents(jour, config, {}, null);

    if (dryRun) {
      const pingRoleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }

    await initEconomy(config.stocks_initiaux);
    return publishAndWriteState(channelId, null, {
      jour,
      event: null,
      zeroStreaks: { poisson: 0, eau: 0, bois: 0 },
      dayVoters: [],
      embed,
      components,
      noPing,
      estPremierJour: true,
    });
  }

  const closure = dryRun ? await previewCloseDay(state, config) : await closeDayAndAdvance(state, config);

  // Fin de partie (victoire par le Radeau ou défaite) — jamais annoncée en
  // temps réel au clic, toujours révélée ici, au cron.
  if (closure.outcome === "victoire_radeau" || closure.outcome === "defaite") {
    const embed = buildOutcomeEmbed(closure.outcome, config);
    if (dryRun) return { dryRun: true, final: true, outcome: closure.outcome, embed };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: closure.zeroStreaksApres,
      dayVoters: [],
      embed,
      components: [],
      noPing: true,
      estPremierJour: false,
      termine: true,
    });
    return { ...result, final: true, outcome: closure.outcome };
  }

  const jourSuivant = state.jour + 1;
  if (isSurvivalVictory(jourSuivant, config.duree_jours)) {
    const embed = buildOutcomeEmbed("victoire_jour11", config);
    if (dryRun) return { dryRun: true, final: true, outcome: "victoire_jour11", embed };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: closure.zeroStreaksApres,
      dayVoters: [],
      embed,
      components: [],
      noPing: true,
      estPremierJour: false,
      termine: true,
    });
    return { ...result, final: true, outcome: "victoire_jour11" };
  }

  const event = eventForDay(jourSuivant, config.evenements);
  const embed = await buildRobinsonEmbed(jourSuivant, closure.stocksApres, closure.radeauPoints, config, event, false, closure.voters);
  const components = buildRobinsonComponents(jourSuivant, config, {}, event);

  if (dryRun) {
    return { dryRun: true, jour: jourSuivant, embed, components, event };
  }

  return publishAndWriteState(channelId, state, {
    jour: jourSuivant,
    event,
    zeroStreaks: closure.zeroStreaksApres,
    dayVoters: closure.voters,
    embed,
    components,
    noPing: true,
    estPremierJour: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring publishAndWriteState() dans api/discord/handlers/tamagotchi.js.
async function publishAndWriteState(
  channelId,
  previousState,
  { jour, event, zeroStreaks, dayVoters, embed, components, noPing, estPremierJour, termine = false },
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
          `[Robinson] Échec suppression du message de la veille (${delRes.status}), publication du nouveau jour quand même.`,
        );
      }
    } catch (err) {
      console.warn("[Robinson] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  const roleId = estPremierJour && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();

  await writeState({
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    event,
    zeroStreaks,
    dayVoters,
  });

  return { jour, embed, message, termine };
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
    console.error("[Robinson] Échec PATCH:", err.message);
  }
}

// Relit l'état public frais (stocks, radeau, compteurs de votes) et
// rafraîchit le message du salon en PATCH direct (bot token, pas webhook) —
// même découplage que handleVoteButton dans tamagotchi.js.
async function refreshPublicMessage(state, config, botToken) {
  const [stocks, radeauPoints, voteCounts] = await Promise.all([
    readStocks(),
    readRadeauPoints(),
    tallyVotes(state.jour),
  ]);
  const embed = await buildRobinsonEmbed(state.jour, stocks, radeauPoints, config, state.event, state.jour === 1, state.dayVoters);
  const components = buildRobinsonComponents(state.jour, config, voteCounts, state.event);

  await fetch(
    `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], components }),
    },
  );
}

function formatHarvestConfirmation(actionId, config, detail) {
  if (actionId === "explorer") {
    const [resourceId] = Object.entries(detail.yields).find(([, n]) => n > 0) ?? [];
    return `🔍 Exploration réussie : tu ramènes 3 ${RESOURCE_LABELS[resourceId]} !`;
  }
  const action = config.actions[actionId];
  if (detail.amount === 0) {
    return `${action.emoji} ${action.label} : bredouille cette fois-ci, rien à ramener !`;
  }
  return `${action.emoji} ${action.label} : tu récoltes ${detail.amount} ${RESOURCE_LABELS[action.resource]} !`;
}

// ── Bouton de vote — actions de récolte (Pêcher/Eau/Bois/Explorer) ──
// Tirage EN DIRECT au moment du clic (décision validée) : le joueur voit
// immédiatement en éphémère ce qu'il a récolté. Ack routeur en type 5
// éphémère (comme Tamagotchi) — chaque vote a un résultat individuel à
// révéler en privé, le message public est mis à jour séparément par un
// second PATCH direct (bot token) au salon.

async function handleHarvestVote(webhookUrl, state, config, actionId, discordId, username, botToken) {
  const result = await recordVote(state.jour, discordId, actionId, username);

  if (result.status === "rejected") {
    await patchOriginal(webhookUrl, {
      content: "Tu as déjà voté aujourd’hui pour une autre action, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.status === "already_recorded") {
    const detail = await getVoteDetail(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content: detail ? formatHarvestConfirmation(actionId, config, detail) : "Tu as déjà voté cette action aujourd’hui, c’est noté !",
      embeds: [],
      components: [],
    });
    return;
  }

  // "recorded" — premier vote réussi du joueur ce jour-ci : le tirage a
  // réellement lieu maintenant, et le stock est incrémenté immédiatement.
  let detail;
  if (actionId === "explorer") {
    const yields = rollExplorerYield(Math.random);
    await Promise.all(
      Object.entries(yields).map(([resourceId, amount]) => harvestResource(resourceId, amount)),
    );
    detail = { actionId, yields, at: new Date().toISOString() };
  } else {
    const resourceId = config.actions[actionId].resource;
    const amount = harvestCapForEvent(state.event, actionId)
      ? rollCappedEventAmount(Math.random)
      : rollHarvestAmount(Math.random);
    await harvestResource(resourceId, amount);
    detail = { actionId, amount, at: new Date().toISOString() };
  }
  await writeVoteDetail(state.jour, discordId, detail);

  await patchOriginal(webhookUrl, {
    content: formatHarvestConfirmation(actionId, config, detail),
    embeds: [],
    components: [],
  });

  await refreshPublicMessage(state, config, botToken);
}

// ── Bouton de vote — Construire le Radeau ──
// Seule action pouvant échouer (stock de Bois insuffisant) : si elle échoue,
// le slot de vote réservé par recordVote() est libéré (releaseVoteSlot), le
// joueur peut réessayer plus tard dans la journée sans avoir "gâché" son vote.

async function handleRadeauVote(webhookUrl, state, config, discordId, username, botToken) {
  const result = await recordVote(state.jour, discordId, "radeau", username);

  if (result.status === "rejected") {
    await patchOriginal(webhookUrl, {
      content: "Tu as déjà voté aujourd’hui pour une autre action, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.status === "already_recorded") {
    await patchOriginal(webhookUrl, {
      content: "🛶 Tu as déjà contribué au Radeau aujourd’hui, c’est noté !",
      embeds: [],
      components: [],
    });
    return;
  }

  const contribution = await attemptRaftContribution(config.bois_par_point_radeau);
  if (!contribution.success) {
    await releaseVoteSlot(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content: `🛶 Pas assez de Bois pour construire le Radeau (il en faut ${config.bois_par_point_radeau}) — réessaie plus tard si le stock remonte !`,
      embeds: [],
      components: [],
    });
    return;
  }

  await writeVoteDetail(state.jour, discordId, {
    actionId: "radeau",
    pointsAdded: 1,
    boisRestant: contribution.boisRestant,
    at: new Date().toISOString(),
  });
  await patchOriginal(webhookUrl, {
    content: `🛶 Contribution réussie ! +1 point de construction (il reste ${contribution.boisRestant} Bois).`,
    embeds: [],
    components: [],
  });

  await refreshPublicMessage(state, config, botToken);
}

export async function handleVoteButton(webhookUrl, jour, actionId, discordId, username, botToken) {
  try {
    const state = await readState();
    if (!state || state.termine || String(state.jour) !== String(jour)) {
      await patchOriginal(webhookUrl, {
        content: "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    if (actionId === "explorer" && isExplorerDisabled(state.event)) {
      await patchOriginal(webhookUrl, {
        content: "🧌 L’exploration est bloquée aujourd’hui à cause des Gobelins !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadRobinsonConfig();

    if (actionId === "radeau") {
      await handleRadeauVote(webhookUrl, state, config, discordId, username, botToken);
      return;
    }

    await handleHarvestVote(webhookUrl, state, config, actionId, discordId, username, botToken);
  } catch (err) {
    console.error("[Robinson] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [📜 Journal de Bord] — lecture seule, hors-vote ──────────
// Ne consomme jamais le vote du jour, relit toujours l'état courant (pas de
// garde de fraîcheur nécessaire, contrairement à un vote).

function formatHistoriqueLine(entry) {
  if (entry.outcome === "victoire_radeau") return `Jour ${entry.jour} : 🛶 Victoire par le Radeau !`;
  if (entry.outcome === "victoire_jour11") return `Jour ${entry.jour} : 🚢 Les secours sont arrivés !`;
  if (entry.outcome === "defaite") return `Jour ${entry.jour} : 💀 Naufrage.`;
  const vol = entry.gobelinsVoleur ? " — 🧌 les Gobelins ont volé 5 Poissons" : "";
  return `Jour ${entry.jour} : ${entry.V} votant${entry.V > 1 ? "s" : ""}${vol}`;
}

export async function handleJournal(webhookUrl) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie Robinson en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }

    const [stocks, V, { entries }] = await Promise.all([
      readStocks(),
      countUniqueVoters(state.jour),
      listHistorique({ limit: 10 }),
    ]);
    const besoin = computeDailyConsumption(V);
    const manque = {
      poisson: Math.max(0, besoin.poisson - stocks.poisson),
      eau: Math.max(0, besoin.eau - stocks.eau),
      bois: Math.max(0, besoin.bois - stocks.bois),
    };

    const lines = [
      `**Votants aujourd’hui : ${V}**`,
      "",
      "**Besoins pour la clôture de 08:00 UTC :**",
      `🐟 Nourriture : ${besoin.poisson} nécessaire${manque.poisson > 0 ? ` — **il en manque ${manque.poisson}**` : " (couvert)"}`,
      `💧 Eau : ${besoin.eau} nécessaire${manque.eau > 0 ? ` — **il en manque ${manque.eau}**` : " (couvert)"}`,
      `🪵 Bois : ${besoin.bois} nécessaire${manque.bois > 0 ? ` — **il en manque ${manque.bois}**` : " (couvert)"}`,
    ];

    if (entries.length > 0) {
      lines.push("", "**Jours précédents :**", ...entries.map(formatHistoriqueLine));
    }

    const embed = { title: "📜 Journal de Bord", description: lines.join("\n"), color: ROBINSON_COLOR };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Robinson] Échec Journal de Bord:", err.message);
  }
}

// ── Bouton [📖 Règles du jeu] — éphémère, statique ────────────────
// Ne consomme jamais le vote du jour, contenu généré depuis robinson.json,
// aucune lecture/écriture d'état (même principe que Tamagotchi).

function buildReglesEmbed(config) {
  const actionLines = Object.entries(config.actions).map(([id, action]) => {
    if (id === "radeau") {
      return `${action.emoji} **${action.label}** — coûte ${config.bois_par_point_radeau} Bois pour +1 point de construction (${config.points_par_section} points = 1 section, ${config.radeau_sections_max} sections = évasion !). Refusé sans consommer ton vote si le stock de Bois est insuffisant.`;
    }
    if (id === "explorer") {
      return `${action.emoji} **${action.label}** — rapporte toujours 3 unités d’une seule ressource, tirée au hasard parmi Nourriture, Eau et Bois.`;
    }
    return `${action.emoji} **${action.label}** — rapporte de 0 à 3 ${RESOURCE_LABELS[action.resource]} au hasard (25 % de chances chacun).`;
  });

  return {
    title: "📖 Règles du jeu — Robinson",
    description: [
      "Naufragés sur une île, survivez 10 jours jusqu’à l’arrivée des secours au Jour 11, ou évadez-vous plus tôt en achevant le Radeau.",
      "",
      "**Actions (1 vote par membre et par jour) :**",
      ...actionLines,
      "",
      "**Consommation automatique chaque nuit** (V = votants uniques du jour) : −V Nourriture, −V Eau, −⌈V/2⌉ Bois.",
      "",
      "**Défaite :** une ressource à 0 pendant 2 jours consécutifs met fin à l’aventure.",
      "",
      "Un vote n’est pas modifiable une fois qu’il a réellement abouti. Attention, des événements imprévus peuvent frapper l’île à tout moment…",
    ].join("\n"),
    color: ROBINSON_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadRobinsonConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Robinson] Échec Règles du jeu:", err.message);
  }
}
