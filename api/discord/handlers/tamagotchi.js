// ============================================================
// tamagotchi.js — Handlers Discord pour le Tamagotchi communautaire
// "Bébé Dragon Lilith". Embed, boutons d'action (vote), Inspecter et
// Règles du jeu. La publication/suppression quotidienne passe uniquement
// par scripts/postTamagotchi.js (postTamagotchi) — les boutons restent gérés
// par api/discord/interactions.js.
// ============================================================

import {
  loadTamagotchiConfig,
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
} from "../../../backend/services/tamagotchi.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
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
  "« Wesh la famille ! Je pars 10 jours visiter la Petite France à Strasbourg et déguster des tartes flambées. " +
  "Je vous confie Lilith mon Bébé Dragon de compétition. Il est très difficile : gardez ses jauges équilibrées ! " +
  "Si vous me le rendez en mauvais état le 10ᵉ jour… je débarque dans votre arène avec un deck Mineur-Poison. " +
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

function narrateGauge(kind, value) {
  if (kind === "estomac") {
    if (value < 30) return "🔥 L'estomac de Lilith gargouille dangereusement, affamée elle recommence à cracher de petites flammes sur le mobilier du serveur.";
    if (value > 80) return "🔥 Lilith a une aérophagie enflammée carabinée et somnole, trop repue pour bouger.";
    return "🔥 L'estomac de Lilith est à l'aise, elle digère tranquillement.";
  }
  if (kind === "energie") {
    if (value < 30) return "⚡ En plein burn-out, Lilith refuse d'obéir et fixe le vide d'un air épuisé.";
    if (value > 80) return "⚡ Lilith enchaîne les hyperactivités nocturnes et manque de renverser une tourelle en jouant.";
    return "⚡ Sa forme est correcte, ni trop fatiguée ni trop électrique.";
  }
  if (value < 30) return "🥨 Le moral en berne, Lilith déprime dans son coin et regrette son maître.";
  if (value > 80) return "🥨 Beaucoup trop gâtée, Lilith devient incontrôlable et exige des câlins toutes les cinq minutes.";
  return "🥨 Le moral de Lilith est stable, elle a même l'air de bonne humeur.";
}

async function buildNarrative(jour, gauges, voters, estPremierJour) {
  if (estPremierJour) return DAY1_INTRO;

  const lines = [narrateGauge("estomac", gauges.estomac), narrateGauge("energie", gauges.energie), narrateGauge("moral", gauges.moral)];
  const names = await pickVoterNames(voters, jour);
  if (names.length) {
    lines.push(`Merci à ${names.join(" et ")} pour les soins prodigués hier — Lilith a trouvé un os de dragon dans l'arène et se met à jouer avec ${names[0]} !`);
  }
  return lines.join(" ");
}

// ── Embed / composants du jour ────────────────────────────────────

async function buildTamagotchiEmbed(jour, gauges, config, event, starTotal, estPremierJour, voters) {
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
    renderGaugeLine("🔥 Estomac", gauges.estomac),
    renderGaugeLine("⚡ Énergie", gauges.energie),
    renderGaugeLine("🥨 Moral", gauges.moral),
    "",
    `⭐ Étoiles de dressage : ${starTotal}/${config.duree_jours}`,
  );

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
  const actionIds = Object.keys(config.actions).filter((id) => !config.actions[id].is_info_action);
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
        { type: 2, style: 2, label: inspecter.label, emoji: { name: inspecter.emoji }, custom_id: "tamagotchi_inspecter" },
        { type: 2, style: 2, label: "Règles du jeu", emoji: { name: "📖" }, custom_id: "tamagotchi_regles" },
      ],
    },
  ];
}

async function buildDayPayload(jour, gauges, config, event, starTotal, estPremierJour, voters) {
  const voteCounts = estPremierJour ? {} : await tallyVotes(jour);
  return {
    embed: await buildTamagotchiEmbed(jour, gauges, config, event, starTotal, estPremierJour, voters),
    components: buildTamagotchiComponentsWithCounts(jour, config, voteCounts),
  };
}

// ── Embed de fin de partie (Jour 10) ──────────────────────────────

function buildFinalTierEmbed(starTotal, tier, config) {
  const image = { url: tamagotchiImageUrl(config.duree_jours) };

  if (tier === "S") {
    return {
      title: "🐉 Fin de l'aventure — Mohamed Light est impressionné !",
      description:
        `Lilith rentre en pleine forme, l'écaille brillante et le sourire aux crocs. Mohamed Light décerne au serveur ` +
        `le titre honorifique **🐉 Éleveur de Champion** — un immense bravo à toute la communauté !\n\n` +
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
      color: 0xf1c40f,
      image,
    };
  }
  if (tier === "B") {
    return {
      title: "🐉 Fin de l'aventure — Lilith rentre saine et sauve",
      description:
        `Le Bébé Dragon rentre un peu fatigué, mais indemne. Mohamed Light vous remercie chaleureusement d'avoir pris soin de Lilith !\n\n` +
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
      color: TAMAGOTCHI_COLOR,
      image,
    };
  }
  return {
    title: "🐉 Fin de l'aventure — Lilith crache de la fumée noire",
    description:
      `Mohamed Light retrouve son Bébé Dragon dans un sale état. Furieux, il lance un défi d'arène au serveur — ` +
      `préparez-vous à affronter un deck Mineur-Poison !\n\n` +
      `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
    color: 0x2c3e50,
    image,
  };
}

function buildReglesEmbed(config) {
  const actionLines = Object.entries(config.actions)
    .filter(([, action]) => !action.is_info_action)
    .map(([, action]) => `${action.emoji} **${action.label}** — ${formatGaugeImpact(action.impact)}`);

  return {
    title: "📖 Règles du jeu — Tamagotchi",
    description: [
      `Garde les 3 jauges de Lilith (Estomac 🔥, Énergie ⚡, Moral 🥨) dans la **zone verte (${config.zones_ideales.min}-${config.zones_ideales.max}%)** au moment de la clôture quotidienne (08:00 UTC).`,
      "",
      "**Impacts des actions :**",
      ...actionLines,
      "",
      "🔍 **Inspecter** et 📖 **Règles du jeu** sont des actions d'information : elles ne consomment pas ton vote du jour et ne modifient jamais les jauges.",
      "",
      "Un membre ne peut voter qu'une seule fois par jour parmi les 4 actions ci-dessus, et ce vote n'est pas modifiable.",
    ].join("\n"),
    color: TAMAGOTCHI_COLOR,
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postTamagotchi.js) ──

export async function postTamagotchi(channelId, { dryRun = false, noPing = false } = {}) {
  const config = await loadTamagotchiConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const gauges = config.jauges_initiales;
    const { embed, components } = await buildDayPayload(jour, gauges, config, null, 0, true, []);

    if (dryRun) {
      const pingRoleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      jour,
      gauges,
      starTotal: 0,
      lastEvent: null,
      dayVoters: [],
      embed,
      components,
      noPing,
      estPremierJour: true,
    });
  }

  const closure = dryRun ? await previewCloseDay(state, config) : await closeDayAndAdvance(state, config);
  const starTotalApres = dryRun ? state.starTotal + closure.rating.starDelta : closure.starTotalApres;
  const jour = state.jour + 1;

  if (jour > config.duree_jours) {
    const tier = computeFinalTier(starTotalApres);
    const embed = buildFinalTierEmbed(starTotalApres, tier, config);

    if (dryRun) {
      return { dryRun: true, final: true, tier, starTotal: starTotalApres, embed };
    }
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      gauges: closure.gaugesClosing,
      starTotal: starTotalApres,
      lastEvent: state.lastEvent,
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
  const gauges = event ? applyGaugeDelta(closure.gaugesClosing, event.modificateur_jauges) : closure.gaugesClosing;
  const { embed, components } = await buildDayPayload(jour, gauges, config, event, starTotalApres, false, closure.voters);

  if (dryRun) {
    return { dryRun: true, jour, embed, components, event, starTotal: starTotalApres };
  }
  return publishAndWriteState(channelId, state, {
    jour,
    gauges,
    starTotal: starTotalApres,
    lastEvent: event,
    dayVoters: closure.voters,
    embed,
    components,
    noPing: true,
    estPremierJour: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring postChapter() dans api/discord/handlers/aventure.js.
async function publishAndWriteState(channelId, previousState, {
  jour, gauges, starTotal, lastEvent, dayVoters, embed, components, noPing, estPremierJour, termine = false,
}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(`[Tamagotchi] Échec suppression du message de la veille (${delRes.status}), publication quand même.`);
      }
    } catch (err) {
      console.warn("[Tamagotchi] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  const roleId = estPremierJour && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
  });
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

    const result = await recordVote(state.jour, discordId, actionId, username);

    const confirmText =
      result.status === "rejected"
        ? "Tu as déjà voté aujourd'hui pour une autre action, ton vote est définitif jusqu'à demain !"
        : result.status === "already_recorded"
          ? "Tu as déjà voté cette action aujourd'hui, c'est noté !"
          : "Vote enregistré, merci d'avoir pris soin de Lilith aujourd'hui !";
    await patchOriginal(webhookUrl, { content: confirmText, embeds: [], components: [] });

    if (result.status === "rejected") return;

    const config = await loadTamagotchiConfig();
    const voteCounts = await tallyVotes(state.jour);
    const embed = await buildTamagotchiEmbed(
      state.jour,
      state.gauges,
      config,
      state.lastEvent,
      state.starTotal,
      state.jour === 1 && !state.lastEvent && state.starTotal === 0,
      state.dayVoters,
    );
    const components = buildTamagotchiComponentsWithCounts(state.jour, config, voteCounts);

    await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    console.error("[Tamagotchi] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [🔍 Inspecter] — éphémère, ne consomme pas le vote ─────

export async function handleInspecter(webhookUrl) {
  try {
    const state = await readState();
    if (!state || state.termine) {
      await patchOriginal(webhookUrl, { content: "Aucune journée active en ce moment.", embeds: [], components: [] });
      return;
    }
    const config = await loadTamagotchiConfig();
    const voteCounts = await tallyVotes(state.jour);
    const impact = computeDayImpact(voteCounts, config.actions);
    const projected = applyGaugeDelta(state.gauges, impact);

    const embed = {
      title: "🔍 Projection — clôture demain 08:00 UTC",
      description: [
        renderGaugeLine("🔥 Estomac", projected.estomac),
        renderGaugeLine("⚡ Énergie", projected.energie),
        renderGaugeLine("🥨 Moral", projected.moral),
        "",
        "Basé sur la répartition actuelle des votes — partage ces infos au serveur pour vous coordonner !",
      ].join("\n"),
      color: TAMAGOTCHI_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Tamagotchi] Échec Inspecter:", err.message);
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
