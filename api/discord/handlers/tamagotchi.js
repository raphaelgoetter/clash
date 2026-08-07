// ============================================================
// tamagotchi.js — Handlers Discord pour le Tamagotchi communautaire
// "Bébé Dragon Lilith". Embed, boutons d'action (vote), Projections et
// Règles du jeu. La publication/suppression quotidienne passe uniquement
// par scripts/postTamagotchi.js (postTamagotchi) — les boutons restent gérés
// par api/discord/interactions.js.
// ============================================================

import {
  loadTamagotchiConfig,
  loadNarratifs,
  readState,
  writeState,
  recordVote,
  tallyVotes,
  previewCloseDay,
  closeDayAndAdvance,
  eventForDay,
  applyGaugeDelta,
  computeDayImpact,
  computeFinalTier,
  archiveManche,
  listManches,
} from "../../../backend/services/tamagotchi.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const TAMAGOTCHI_COLOR = 0xe67e22;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustration du jour — fichiers statiques frontend/public/images/tamagotchi/
// (tama-01.webp à tama-10.webp), servis tels quels par Vercel, aucun besoin de
// masquer l'URL comme pour le jeu Frame (pas un jeu de devinette).
function tamagotchiImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/tamagotchi/tama-${String(jour).padStart(2, "0")}.webp`;
}

const FLAVOR_NAMES = [
  "Aurel",
  "Rico",
  "Mariechou",
  "Pasqua",
  "Azzgameuse",
  "Lepamowi",
  "Snaatchou",
  "Electron",
  "Kayzor",
];

const DAY1_INTRO =
  "« Wesh la famille ! Je pars 10 jours visiter la Petite France à Strasbourg et déguster des tartes flambées.\n" +
  "Je vous confie Lilith mon Bébé Dragon de compétition. Il est très difficile : gardez ses jauges équilibrées !\n" +
  "Je reviendrai le 11e jour pour récupérer ma Lilith. Attention, si vous me la rendez en mauvais état… je débarque dans votre arène avec un deck Mineur-Poison et je défonce tout.\n" +
  "Bon courage ! » — Mohamed Light";

// ── Rendu des jauges ─────────────────────────────────────────────

export function renderGaugeBar(value) {
  const filled = Math.max(0, Math.min(5, Math.round(value / 20)));
  return `${"🟩".repeat(filled)}${"🟥".repeat(5 - filled)} ${value}%`;
}

function renderGaugeLine(label, value) {
  return `${label} : ${renderGaugeBar(value)}`;
}

// Format lisible d'un objet {estomac, energie, moral} en "Estomac +25, Énergie
// -10, Moral +0" — réutilisé pour les impacts d'action (Règles du jeu) et le
// modificateur d'un événement, pour qu'on puisse toujours deviner son effet
// sans avoir à ouvrir tamagotchi.json.
function formatGaugeImpact({ estomac, energie, moral }) {
  const fmt = (v) => `${v >= 0 ? "+" : ""}${v}`;
  return `Estomac ${fmt(estomac)}, Énergie ${fmt(energie)}, Moral ${fmt(moral)}`;
}

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans data/tamagotchi/narratifs.json (pas
// dans le code) pour être facilement enrichies sans toucher au JS. La
// sélection est déterministe (indexée par le jour, pas Math.random()) : le
// narratif ne doit jamais changer entre deux ré-affichages du MÊME jour
// (ex. après chaque clic de vote qui repatch l'embed), seulement d'un jour
// à l'autre.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

function gaugeCategory(kind, value) {
  if (value <= 30) return `${kind}_bas`;
  if (value >= 80) return `${kind}_haut`;
  return `${kind}_normal`;
}

// Icône affichée devant chaque jauge — l'Estomac reste fixe (🍭, symbolise la
// nourriture), l'Énergie et le Moral varient selon le niveau pour que l'état
// se lise d'un coup d'œil, sans avoir à lire le pourcentage.
const GAUGE_ICONS = {
  estomac_bas: "🍭",
  estomac_normal: "🍭",
  estomac_haut: "🍭",
  energie_bas: "🪫",
  energie_normal: "⚡",
  energie_haut: "🔋",
  moral_bas: "🥱",
  moral_normal: "😐",
  moral_haut: "😋",
};

function gaugeIcon(kind, value) {
  return GAUGE_ICONS[gaugeCategory(kind, value)];
}

async function pickVoterNames(voters, jour) {
  if (voters?.length) {
    const picked = voters.slice(0, 2);
    const resolved = await Promise.all(
      picked.map((v) => resolveDisplayName(v.discordId, v.username)),
    );
    return resolved.filter(Boolean);
  }
  // Aucun vote la veille : pioche stable (déterministe par jour) dans le pool
  // de pseudos de secours, pour que le narratif reste cohérent en dry-run.
  const start = (jour * 2) % FLAVOR_NAMES.length;
  return [FLAVOR_NAMES[start], FLAVOR_NAMES[(start + 1) % FLAVOR_NAMES.length]];
}

// Chaque ligne du message de Mohamed Light préfixée par "> " — rendu Discord
// en citation multi-lignes (contrairement à ">>>" qui citerait aussi la
// mini-explication ajoutée après, qui doit rester du texte normal).
function quoteBlock(text) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildDay1Intro() {
  return [
    "**VOUS AVEZ REÇU UN NOUVEAU MESSAGE !**",
    "",
    quoteBlock(DAY1_INTRO),
    "",
    "Collaborez ensemble pour vous occuper du Bébé Dragon et subvenir à ses besoins.",
  ].join("\n");
}

// "normal" n'a volontairement aucun pool de texte associé (contrairement à
// GAUGE_ICONS, qui a besoin d'une icône même en normal) : rien
// d'intéressant à raconter sur une jauge ordinaire, la ligne est alors
// simplement omise plutôt que de meubler avec une phrase creuse.
async function buildNarrative(jour, gauges, voters, estPremierJour) {
  if (estPremierJour) return buildDay1Intro();

  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);

  const lines = [];
  const estomacKey = gaugeCategory("estomac", gauges.estomac);
  if (!estomacKey.endsWith("_normal")) lines.push(pickFlavor(narratifs[estomacKey], jour + 1));
  const energieKey = gaugeCategory("energie", gauges.energie);
  if (!energieKey.endsWith("_normal")) lines.push(pickFlavor(narratifs[energieKey], jour + 2));
  const moralKey = gaugeCategory("moral", gauges.moral);
  if (!moralKey.endsWith("_normal")) lines.push(pickFlavor(narratifs[moralKey], jour + 3));

  const names = await pickVoterNames(voters, jour);
  if (names.length) {
    const template = pickFlavor(narratifs.cloture_soins, jour + 4);
    const phrase = template.replaceAll("{noms}", names.join(" et ")).replaceAll("{premier}", names[0]);
    // Rattachée à la dernière ligne (même paragraphe) si possible, sinon
    // ligne à part (les 3 jauges peuvent toutes être "normal" ce jour-là).
    if (lines.length) {
      lines[lines.length - 1] += ` ${phrase}`;
    } else {
      lines.push(phrase);
    }
  }

  if (!lines.length) return intro;
  return `${intro}\n\n${lines.join("\n")}`;
}

const RATING_LABELS = {
  parfaite: "✅ Parfaite (+1 ⭐)",
  moyenne: "⚠️ Moyenne (+0 ⭐)",
  catastrophe: "❌ Catastrophe (-1 ⭐)",
};

// ── Embed / composants du jour ────────────────────────────────────

async function buildTamagotchiEmbed(
  jour,
  gauges,
  config,
  event,
  starTotal,
  estPremierJour,
  voters,
  previousRating,
) {
  const narrative = await buildNarrative(jour, gauges, voters, estPremierJour);
  const lines = [narrative, ""];
  if (event) {
    lines.push(
      `**📯 Événement du jour : ${event.titre}**`,
      event.description,
      `Effet : ${formatGaugeImpact(event.modificateur_jauges)}`,
      "",
    );
  }
  lines.push(
    renderGaugeLine(
      `${gaugeIcon("estomac", gauges.estomac)} Estomac`,
      gauges.estomac,
    ),
    renderGaugeLine(
      `${gaugeIcon("energie", gauges.energie)} Énergie`,
      gauges.energie,
    ),
    renderGaugeLine(`${gaugeIcon("moral", gauges.moral)} Moral`, gauges.moral),
    "",
  );
  // Rend visible POURQUOI le score a (ou n'a pas) bougé : sans ça, une seule
  // jauge hors zone (donnant 0 étoile, pas de malus) est facilement confondue
  // avec un score qui "n'augmente jamais".
  if (previousRating) {
    lines.push(
      `Bilan d'hier : ${RATING_LABELS[previousRating.rating] || previousRating.rating}`,
      "",
    );
  }
  lines.push(`⭐ Étoiles de dressage : ${starTotal}/${config.duree_jours}`);

  return {
    title: `Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: TAMAGOTCHI_COLOR,
    image: { url: tamagotchiImageUrl(jour) },
    footer: {
      text: estPremierJour
        ? "Mohamed Light vous confie Lilith — bon courage !"
        : "Votez avant 08:00 UTC demain pour orienter la journée.",
    },
  };
}

function buildTamagotchiComponentsWithCounts(jour, config, voteCounts) {
  const actionIds = Object.keys(config.actions).filter(
    (id) => !config.actions[id].is_info_action,
  );
  const inspecter = config.actions.inspecter;

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
          custom_id: `tamagotchi_vote:${jour}:${id}`,
        };
      }),
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: inspecter.label,
          emoji: { name: inspecter.emoji },
          custom_id: `tamagotchi_inspecter:${jour}`,
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "tamagotchi_regles",
        },
      ],
    },
  ];
}

async function buildDayPayload(
  jour,
  gauges,
  config,
  event,
  starTotal,
  estPremierJour,
  voters,
  previousRating,
) {
  const voteCounts = estPremierJour ? {} : await tallyVotes(jour);
  return {
    embed: await buildTamagotchiEmbed(
      jour,
      gauges,
      config,
      event,
      starTotal,
      estPremierJour,
      voters,
      previousRating,
    ),
    components: buildTamagotchiComponentsWithCounts(jour, config, voteCounts),
  };
}

// ── Embed de fin de partie (Jour 10) ──────────────────────────────
// Le jeu est rejoué plusieurs fois dans l'année : la manche qui vient de se
// terminer est comparée aux précédentes (manches, currentManche — voir
// archiveManche()/listManches() dans tamagotchi.js), avec un 🏆 sur le
// meilleur total d'étoiles toutes manches confondues.

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — ${record.starTotal}⭐ (${record.tier})${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) => (b.starTotal > a.starTotal ? b : a));
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) => formatMancheLine(m, m.manche === currentManche, m.manche === best.manche)),
  ];
}

function buildFinalTierEmbed(starTotal, tier, config, manches = [], currentManche = null) {
  const image = { url: tamagotchiImageUrl(config.duree_jours) };
  const manchesLines = buildManchesSection(manches, currentManche);

  if (tier === "S") {
    return {
      title: "🐉 Fin de l'aventure — Mohamed Light est impressionné !",
      description: [
        `Lilith rentre en pleine forme, l'écaille brillante et le sourire aux crocs. Mohamed Light décerne au serveur ` +
          `le titre honorifique **🐉 Éleveur de Champion** — un immense bravo à toute la communauté !`,
        "",
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
        ...manchesLines,
      ].join("\n"),
      color: 0xf1c40f,
      image,
    };
  }
  if (tier === "B") {
    return {
      title: "🐉 Fin de l'aventure — Lilith rentre saine et sauve",
      description: [
        `Le Bébé Dragon rentre un peu fatigué, mais indemne. Mohamed Light vous remercie chaleureusement d'avoir pris soin de Lilith !`,
        "",
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
        ...manchesLines,
      ].join("\n"),
      color: TAMAGOTCHI_COLOR,
      image,
    };
  }
  return {
    title: "🐉 Fin de l'aventure — Lilith crache de la fumée noire",
    description: [
      `Mohamed Light retrouve son Bébé Dragon dans un sale état. Furieux, il lance un défi d'arène au serveur — ` +
        `préparez-vous à affronter un deck Mineur-Poison !`,
      "",
      `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
      ...manchesLines,
    ].join("\n"),
    color: 0x2c3e50,
    image,
  };
}

function buildReglesEmbed(config) {
  const actionLines = Object.entries(config.actions)
    .filter(([, action]) => !action.is_info_action)
    .map(
      ([, action]) =>
        `${action.emoji} **${action.label}** — ${formatGaugeImpact(action.impact)}`,
    );

  return {
    title: "📖 Règles du jeu — Tamagotchi",
    description: [
      `Garde les 3 jauges de Lilith (Estomac 🍭, Énergie ⚡, Moral 😐) dans la **zone verte (${config.zones_ideales.min}-${config.zones_ideales.max}%)** au moment de la clôture quotidienne (08:00 UTC).`,
      "",
      "**Impacts des actions :**",
      ...actionLines,
      "",
      "🔮 **Projections** ne modifie jamais les jauges, mais consomme ton vote du jour comme les 4 actions ci-dessus (c'est un choix, pas une simple consultation). Seul 📖 **Règles du jeu** est consultable librement, sans jamais consommer ton vote.",
      "",
      "Un membre ne peut voter qu'une seule fois par jour parmi Nourrir, Bretzel, Sieste, Entraînement et Projections, et ce vote n'est pas modifiable.",
    ].join("\n"),
    color: TAMAGOTCHI_COLOR,
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postTamagotchi.js) ──

export async function postTamagotchi(
  channelId,
  { dryRun = false, noPing = false, isPublic = false } = {},
) {
  const config = await loadTamagotchiConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const gauges = config.jauges_initiales;
    const { embed, components } = await buildDayPayload(
      jour,
      gauges,
      config,
      null,
      0,
      true,
      [],
    );

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      jour,
      gauges,
      starTotal: 0,
      lastEvent: null,
      lastRating: null,
      dayVoters: [],
      embed,
      components,
      noPing,
      estPremierJour: true,
    });
  }

  const closure = dryRun
    ? await previewCloseDay(state, config)
    : await closeDayAndAdvance(state, config);
  const starTotalApres = dryRun
    ? state.starTotal + closure.rating.starDelta
    : closure.starTotalApres;
  const jour = state.jour + 1;

  if (jour > config.duree_jours) {
    const tier = computeFinalTier(starTotalApres);

    // Archivage de la manche AVANT lecture de la liste : la manche qui
    // vient de se terminer apparaît alors dans son propre récap comparatif
    // (marquée "cette manche"). Jamais archivé en dry-run NI sur le salon de
    // test (isPublic) — seule une vraie publication sur le salon public
    // compte comme une manche réelle, pour ne jamais polluer l'archive avec
    // des parties de test (voir CONTRIBUTING.md, section Manches).
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({ starTotal: starTotalApres, tier, resolvedAt: new Date().toISOString() });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildFinalTierEmbed(starTotalApres, tier, config, manches, currentManche);

    if (dryRun) {
      return {
        dryRun: true,
        final: true,
        tier,
        starTotal: starTotalApres,
        embed,
      };
    }
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      gauges: closure.gaugesClosing,
      starTotal: starTotalApres,
      lastEvent: state.lastEvent,
      lastRating: closure.rating,
      dayVoters: closure.voters,
      embed,
      components: [],
      noPing: true,
      estPremierJour: false,
      termine: true,
    });
    return { ...result, final: true, tier, starTotal: starTotalApres };
  }

  const event = eventForDay(jour, config.evenements_possibles);
  const gauges = event
    ? applyGaugeDelta(closure.gaugesClosing, event.modificateur_jauges)
    : closure.gaugesClosing;
  const { embed, components } = await buildDayPayload(
    jour,
    gauges,
    config,
    event,
    starTotalApres,
    false,
    closure.voters,
    closure.rating,
  );

  if (dryRun) {
    return {
      dryRun: true,
      jour,
      embed,
      components,
      event,
      starTotal: starTotalApres,
    };
  }
  return publishAndWriteState(channelId, state, {
    jour,
    gauges,
    starTotal: starTotalApres,
    lastEvent: event,
    lastRating: closure.rating,
    dayVoters: closure.voters,
    embed,
    components,
    noPing: true,
    estPremierJour: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring postChapter() dans api/discord/handlers/aventure.js.
async function publishAndWriteState(
  channelId,
  previousState,
  {
    jour,
    gauges,
    starTotal,
    lastEvent,
    lastRating,
    dayVoters,
    embed,
    components,
    noPing,
    estPremierJour,
    termine = false,
  },
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
          `[Tamagotchi] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Tamagotchi] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  const roleId =
    estPremierJour && !noPing
      ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
      : null;

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
    gauges,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    starTotal,
    lastEvent,
    lastRating,
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
    console.error("[Tamagotchi] Échec PATCH:", err.message);
  }
}

// ── Bouton de vote ────────────────────────────────────────────────
// Ack routeur : type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, éphémère) car
// on doit toujours répondre en privé à l'auteur du clic (confirmation ou
// rejet d'un vote déjà posé) — contrairement à Aventure, le message public
// n'est jamais édité via "@original" ici mais via un second appel PATCH
// direct au salon (Bot token), découplé de la réponse éphémère.

export async function handleVoteButton(
  webhookUrl,
  jour,
  actionId,
  discordId,
  username,
  botToken,
) {
  try {
    const state = await readState();
    if (!state || state.termine || String(state.jour) !== String(jour)) {
      await patchOriginal(webhookUrl, {
        content:
          "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const result = await recordVote(state.jour, discordId, actionId, username);

    const confirmText =
      result.status === "rejected"
        ? "Tu as déjà voté aujourd'hui pour une autre action, ton vote est définitif jusqu'à demain !"
        : result.status === "already_recorded"
          ? "Tu as déjà voté cette action aujourd'hui, c'est noté !"
          : "Vote enregistré, merci d'avoir pris soin de Lilith aujourd'hui !";
    await patchOriginal(webhookUrl, {
      content: confirmText,
      embeds: [],
      components: [],
    });

    if (result.status === "rejected") return;

    const config = await loadTamagotchiConfig();
    const voteCounts = await tallyVotes(state.jour);
    // lastRating n'est jamais renseigné pour le Jour 1 (aucun jour précédent
    // à clôturer) et toujours renseigné à partir du Jour 2 — repère fiable
    // pour reconstruire le MÊME embed que celui posté initialement ce jour-là.
    const estPremierJour = state.lastRating == null;
    const embed = await buildTamagotchiEmbed(
      state.jour,
      state.gauges,
      config,
      state.lastEvent,
      state.starTotal,
      estPremierJour,
      state.dayVoters,
      state.lastRating,
    );
    const components = buildTamagotchiComponentsWithCounts(
      state.jour,
      config,
      voteCounts,
    );

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
  } catch (err) {
    console.error("[Tamagotchi] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [🔮 Projections] — consomme le vote du jour (comme les 4 actions),
// mais n'a jamais d'impact sur les jauges au Cron (is_info_action dans
// tamagotchi.json l'exclut de computeDayImpact) : voter Projections revient à
// "s'abstenir" tout en consultant la projection. Ack routeur en type 5
// éphémère, comme le bouton de vote — voir handleVoteButton pour le même
// principe de garde (jour périmé) et de rejet (vote déjà posé ailleurs).

export async function handleInspecter(webhookUrl, jour, discordId, username) {
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

    const result = await recordVote(state.jour, discordId, "inspecter", username);
    if (result.status === "rejected") {
      await patchOriginal(webhookUrl, {
        content: "Tu as déjà voté aujourd'hui pour une autre action, ton vote est définitif jusqu'à demain !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadTamagotchiConfig();
    const voteCounts = await tallyVotes(state.jour);
    const impact = computeDayImpact(voteCounts, config.actions);
    const projected = applyGaugeDelta(state.gauges, impact);

    // Ne compte que les 4 actions réelles (Projections elle-même n'a aucun
    // impact, la compter ici donnerait l'impression à tort qu'un vote a déjà
    // influencé la projection).
    const realActionIds = Object.keys(config.actions).filter((id) => !config.actions[id].is_info_action);
    const totalRealVotes = realActionIds.reduce((sum, id) => sum + (voteCounts[id] || 0), 0);

    // Avertissement affiché seulement au moment où le vote est réellement
    // consommé (1er clic du jour) — inutile de le répéter à chaque reclic
    // (already_recorded), qui reste purement informatif à ce stade.
    const voteNotice =
      result.status === "recorded"
        ? "⚠️ Ce choix consomme ton vote du jour — tu ne pourras plus voter Nourrir/Bretzel/Sieste/Entraînement aujourd'hui."
        : "(Tu as déjà voté Projections aujourd'hui — ton vote reste enregistré.)";

    const embed = {
      title: "🔮 Projections — clôture demain 08:00 UTC",
      description: [
        renderGaugeLine(`${gaugeIcon("estomac", projected.estomac)} Estomac`, projected.estomac),
        renderGaugeLine(`${gaugeIcon("energie", projected.energie)} Énergie`, projected.energie),
        renderGaugeLine(`${gaugeIcon("moral", projected.moral)} Moral`, projected.moral),
        "",
        totalRealVotes === 0
          ? "Personne n'a encore voté une action aujourd'hui — ces valeurs sont celles de la clôture d'hier, inchangées tant qu'aucun vote n'est enregistré."
          : "Basé sur la répartition actuelle des votes — partage ces infos au serveur pour vous coordonner !",
        "",
        voteNotice,
      ].join("\n"),
      color: TAMAGOTCHI_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Tamagotchi] Échec Projections:", err.message);
  }
}

// ── Bouton [📖 Règles du jeu] — éphémère, statique ────────────────

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadTamagotchiConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Tamagotchi] Échec Règles du jeu:", err.message);
  }
}
