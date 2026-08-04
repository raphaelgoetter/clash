// ============================================================
// bossraid.js — Handlers Discord pour Boss Raid (score attack
// communautaire contre un Boss Colossal). Embed, boutons de vote,
// bouton Espion (projection live), Règles & Rôles, Journal.
// La publication/suppression quotidienne passe uniquement par
// scripts/postBossRaid.js (postBossRaid) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadBossRaidConfig,
  loadNarratifs,
  readState,
  writeState,
  recordVote,
  tallyVotes,
  listHistorique,
  readDernierRole,
  isChevalierVoteAllowed,
  activeEventForDay,
  previewCloture,
  closeDayAndAdvance,
  archiveManche,
  listManches,
} from "../../../backend/services/bossraid.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";

const BOSSRAID_COLOR = 0xc0392b;
const ULTIMATE_NAMES = {
  archeres: "🏹 Volée Céleste",
  sorcier: "🔮 Surcharge Arcane",
  voleuse: "🗡️ Coup à la Gorge",
};
// Rappel systématique de l'effet à chaque affichage du nom d'une Ultime
// (bilan du jour, projection Espion, Journal) — le nom seul ne suffit pas à
// comprendre ce qui vient de se passer.
const ULTIMATE_EFFECTS = {
  archeres: "les Archères ignorent la Défense du Boss et la protection du Chevalier, 100% dégâts pour toutes",
  sorcier: "les dégâts magiques de tous les Sorciers sont doublés",
  voleuse: "la Défense et la Résistance du Boss tombent à 0/10 pour demain",
};
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustration du jour — fichiers statiques frontend/public/images/boss/
// (boss-01.webp à boss-10.webp), servis tels quels par Vercel, même
// principe que robinsonImageUrl() dans api/discord/handlers/robinson.js.
// Affichée uniquement à partir du Jour 1 (jamais au jour d'annonce).
function bossRaidImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/boss/boss-${String(jour).padStart(2, "0")}.webp`;
}

// ── Embed / composants du jour ────────────────────────────────────

function buildStatBar(value) {
  const v = Math.max(0, Math.min(10, value));
  return "🟥".repeat(v) + "⬜".repeat(10 - v);
}

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans data/bossraid/narratifs.json (pas
// dans le code), même principe que Robinson/Tamagoshi. La sélection est
// déterministe (indexée par le jour, pas Math.random()) : le narratif ne
// doit jamais changer entre deux ré-affichages du MÊME jour (ex. après
// chaque clic de vote qui repatch l'embed), seulement d'un jour à l'autre.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

// "normal" (4-6/10) n'a volontairement aucun pool de texte associé : rien
// d'intéressant à raconter sur une posture ordinaire, la ligne est alors
// simplement omise plutôt que de meubler avec une phrase creuse.
function statTier(value) {
  if (value <= 3) return "bas";
  if (value >= 7) return "haut";
  return "normal";
}

// Combattants les plus offensifs du jour clos (plus haut total de dégâts) —
// Chevalier/Espion (0 dégât) n'apparaissent jamais ici.
async function pickFighterNames(perVoteDetails) {
  const attackers = (perVoteDetails || [])
    .filter((d) => d.degats > 0)
    .sort((a, b) => b.degats - a.degats);
  if (!attackers.length) return [];
  const picked = attackers.slice(0, 2);
  const resolved = await Promise.all(picked.map((d) => resolveDisplayName(d.discordId, d.username)));
  return resolved.filter(Boolean);
}

async function buildNarrative(jour, bossStats, closure) {
  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);
  if (!closure) return intro; // Jour 1 : pas de bilan de la veille, juste le mot d'ambiance

  const lines = [];
  const defenseTier = statTier(bossStats.defense);
  if (defenseTier !== "normal") lines.push(pickFlavor(narratifs[`defense_${defenseTier}`], jour + 1));
  const resistanceTier = statTier(bossStats.resistance);
  if (resistanceTier !== "normal") lines.push(pickFlavor(narratifs[`resistance_${resistanceTier}`], jour + 2));

  const names = await pickFighterNames(closure.perVoteDetails);
  if (names.length) {
    const template = pickFlavor(narratifs.cloture_combattants, jour + 3);
    const phrase = template.replaceAll("{noms}", names.join(" et ")).replaceAll("{premier}", names[0]);
    if (lines.length) {
      lines[lines.length - 1] += ` ${phrase}`;
    } else {
      lines.push(phrase);
    }
  }

  if (!lines.length) return intro;
  return `${intro}\n\n${lines.join("\n")}`;
}

function buildAnnonceEmbed(config) {
  return {
    title: "⚔️ Boss Raid — Kiki le P.E.K.K.A. approche…",
    description: [
      "Un P.E.K.K.A. répondant au doux nom de **Kiki** s’apprête à fondre sur le clan ! Rassemblez vos forces : 10 jours de combat commencent dès demain.",
      "",
      `🛡️ Défense initiale : **${config.boss_stats_initiales.defense}/10** — 🔮 Résistance initiale : **${config.boss_stats_initiales.resistance}/10**.`,
      "",
      "Chevaliers, Voleuses, Sorciers, Archères, Espions — chaque rôle compte. Besoin d’un rappel des règles ? Clique sur *Règles & Rôles* ci-dessous.",
    ].join("\n"),
    color: BOSSRAID_COLOR,
    footer: { text: "Le combat commence demain à 08:00 UTC." },
  };
}

async function buildCombatEmbed(jour, bossStats, totalDegatsCumules, closure, event, config) {
  const narrative = await buildNarrative(jour, bossStats, closure);
  const lines = [narrative, ""];

  if (closure) {
    lines.push(`**Bilan du Jour ${jour - 1}**`, `💥 Dégâts infligés : **${closure.totalDamageDuJour}**`);
    if (closure.allIn) {
      lines.push(`⚡ **Ultime déclenchée : ${ULTIMATE_NAMES[closure.allIn]} !** ${ULTIMATE_EFFECTS[closure.allIn]}.`);
    } else {
      // Pas de ligne de régénération lors d'un Coup à la Gorge : Kiki tombe
      // à 0/0 ce jour-là, la régénération ne reprend qu'à partir de demain.
      lines.push(`🔄 Kiki récupère pendant la nuit : **+${closure.regen.defense}** Défense, **+${closure.regen.resistance}** Résistance.`);
    }
    lines.push("");
  }

  if (event) {
    lines.push(`**${event.emoji} Événement du jour : ${event.nom}**`, event.description, "");
  }

  lines.push(
    `🛡️ Défense    : [${buildStatBar(bossStats.defense)}] (${bossStats.defense}/10)`,
    `🔮 Résistance : [${buildStatBar(bossStats.resistance)}] (${bossStats.resistance}/10)`,
    "",
    `🏆 Dégâts cumulés (${config.duree_jours} jours) : **${totalDegatsCumules}**`,
  );

  return {
    title: `⚔️ Boss Raid — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: BOSSRAID_COLOR,
    image: { url: bossRaidImageUrl(jour) },
    footer: { text: "Votez avant 08:00 UTC demain pour orienter la journée. Vote modifiable jusqu’à la clôture." },
  };
}

function buildComponents(jour, phase, voteCounts, config) {
  const utilityRow = {
    type: 1,
    components: [
      { type: 2, style: 2, label: "Règles & Rôles", emoji: { name: "📖" }, custom_id: "bossraid_regles" },
      { type: 2, style: 2, label: "Journal", emoji: { name: "📜" }, custom_id: "bossraid_journal" },
    ],
  };

  if (phase !== "combat") return [utilityRow];

  const voteRow = {
    type: 1,
    components: Object.entries(config.roles).map(([roleId, role]) => ({
      type: 2,
      style: 2,
      label: `${role.label} (${voteCounts[roleId] || 0})`.slice(0, 80),
      emoji: { name: role.emoji },
      custom_id: roleId === "espion" ? `bossraid_espion:${jour}` : `bossraid_vote:${jour}:${roleId}`,
    })),
  };

  return [voteRow, utilityRow];
}

// Le jeu est rejoué plusieurs fois dans l'année : la manche qui vient de se
// terminer est comparée aux précédentes (manches, currentManche — voir
// archiveManche()/listManches() dans bossraid.js), avec un 🏆 sur le
// meilleur total de dégâts toutes manches confondues.

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — **${record.totalDegatsCumules}** dégâts${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) => (b.totalDegatsCumules > a.totalDegatsCumules ? b : a));
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) => formatMancheLine(m, m.manche === currentManche, m.manche === best.manche)),
  ];
}

function buildOutcomeEmbed(totalDegatsCumules, config, manches = [], currentManche = null) {
  return {
    title: "🏆 Boss Raid terminé !",
    description: [
      `Après ${config.duree_jours} jours de combat acharné, Kiki le P.E.K.K.A. se retire enfin — le clan a tenu bon jusqu’au bout !`,
      "",
      `💥 **Dégâts totaux infligés à Kiki : ${totalDegatsCumules}**`,
      ...buildManchesSection(manches, currentManche),
      "",
      "Merci à tous les combattants qui ont participé à ce Raid !",
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: bossRaidImageUrl(config.duree_jours) },
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postBossRaid.js) ──

export async function postBossRaid(channelId, { dryRun = false, noPing = false, isPublic = false } = {}) {
  const config = await loadBossRaidConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  // 1) Aucun état -> jour d'annonce (pas de vote possible, ping éventuel)
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = buildComponents(null, "annonce", {}, config);

    if (dryRun) {
      const pingRoleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }

    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      bossStats: config.boss_stats_initiales,
      totalDegatsCumules: 0,
      embed,
      components,
      noPing,
      estAnnonce: true,
    });
  }

  // 2) Transition annonce -> Jour 1/10 : rien à clôturer (aucun vote possible avant), jamais de ping ici
  if (state.phase === "annonce") {
    const jour = 1;
    const event = activeEventForDay(jour, config.evenements_boss);
    const embed = await buildCombatEmbed(jour, state.bossStats, state.totalDegatsCumules, null, event, config);
    const components = buildComponents(jour, "combat", {}, config);

    if (dryRun) return { dryRun: true, phase: "combat", jour, embed, components, event };

    return publishAndWriteState(channelId, state, {
      phase: "combat",
      jour,
      bossStats: state.bossStats,
      totalDegatsCumules: state.totalDegatsCumules,
      embed,
      components,
      noPing: true,
      estAnnonce: false,
    });
  }

  // 3) Clôture normale d'un jour de combat
  const closure = dryRun
    ? await previewCloture(state.jour, config)
    : await closeDayAndAdvance(state.jour, config);

  const jourSuivant = state.jour + 1;

  // Fin de partie (10 jours écoulés) — score final, plus aucun vote possible.
  if (jourSuivant > config.duree_jours) {
    // Archivage AVANT lecture de la liste : la manche qui vient de se
    // terminer apparaît alors dans son propre récap comparatif (marquée
    // "cette manche"). Jamais archivé en dry-run NI sur le salon de test
    // (isPublic) — seule une vraie publication sur le salon public compte
    // comme une manche réelle, pour ne jamais polluer l'archive avec des
    // parties de test (voir CONTRIBUTING.md, section Manches).
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        totalDegatsCumules: closure.totalDegatsApres,
        bossStatsFinal: closure.bossStatsApres,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed(closure.totalDegatsApres, config, manches, currentManche);
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, {
      phase: "combat",
      jour: state.jour,
      bossStats: closure.bossStatsApres,
      totalDegatsCumules: closure.totalDegatsApres,
      embed,
      components: [],
      noPing: true,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true };
  }

  const event = activeEventForDay(jourSuivant, config.evenements_boss);
  const embed = await buildCombatEmbed(jourSuivant, closure.bossStatsApres, closure.totalDegatsApres, closure, event, config);
  const components = buildComponents(jourSuivant, "combat", {}, config);

  if (dryRun) return { dryRun: true, jour: jourSuivant, embed, components, event, closure };

  return publishAndWriteState(channelId, state, {
    phase: "combat",
    jour: jourSuivant,
    bossStats: closure.bossStatsApres,
    totalDegatsCumules: closure.totalDegatsApres,
    embed,
    components,
    noPing: true,
    estAnnonce: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring publishAndWriteState() dans api/discord/handlers/robinson.js.
async function publishAndWriteState(
  channelId,
  previousState,
  { phase, jour, bossStats, totalDegatsCumules, embed, components, noPing, estAnnonce, termine = false },
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
          `[BossRaid] Échec suppression du message de la veille (${delRes.status}), publication du nouveau jour quand même.`,
        );
      }
    } catch (err) {
      console.warn("[BossRaid] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  // Ping réservé au tout premier post (jour d'annonce) — jamais ensuite.
  const roleId = estAnnonce && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;

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
    phase,
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    bossStats,
    totalDegatsCumules,
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
    console.error("[BossRaid] Échec PATCH:", err.message);
  }
}

// Message de suivi ÉPHÉMÈRE (visible uniquement par l'auteur du clic),
// indépendant du message public — utilisé pour le rejet Chevalier : le
// message public (édité par le type 6 déjà acquitté) ne doit PAS changer,
// seul l'auteur doit voir pourquoi son vote n'a pas été enregistré.
async function postFollowup(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, flags: 64 }),
    });
  } catch (err) {
    console.error("[BossRaid] Échec followup:", err.message);
  }
}

async function renderCombatPayload(state, config) {
  const voteCounts = await tallyVotes(state.jour);
  const event = activeEventForDay(state.jour, config.evenements_boss);
  const embed = await buildCombatEmbed(state.jour, state.bossStats, state.totalDegatsCumules, null, event, config);
  const components = buildComponents(state.jour, state.phase, voteCounts, config);
  return { embed, components };
}

// ── Boutons de vote (Chevalier/Voleuse/Sorcier/Archères) ────────────
// Vote MODIFIABLE jusqu'au cron (comme Aventure) : pas de tirage au clic,
// juste un HSET écrasable + réaffichage du message public en place (type 6,
// géré par le routeur), aucun éphémère ici.

export async function handleVoteButton(webhookUrl, jour, roleId, discordId, username) {
  try {
    const state = await readState();
    const config = await loadBossRaidConfig();

    if (!state || state.termine || state.phase !== "combat" || String(state.jour) !== String(jour)) {
      // Jour changé entre le clic et le traitement : on réaffiche l'état
      // courant sans enregistrer un vote périmé (même principe que
      // handleVoteButton dans aventure.js).
      if (state && state.phase === "combat" && !state.termine) {
        const { embed, components } = await renderCombatPayload(state, config);
        await patchOriginal(webhookUrl, { embeds: [embed], components });
      }
      return;
    }

    if (roleId === "chevalier") {
      const dernierRole = await readDernierRole(discordId);
      if (!isChevalierVoteAllowed(dernierRole)) {
        await postFollowup(webhookUrl, {
          content: "🛡️ Tu as protégé le camp hier — impossible de voter Chevalier 2 jours de suite, choisis un autre rôle aujourd’hui !",
        });
        return;
      }
    }

    await recordVote(jour, discordId, roleId, username);

    const { embed, components } = await renderCombatPayload(state, config);
    await patchOriginal(webhookUrl, { embeds: [embed], components });
  } catch (err) {
    console.error("[BossRaid] Échec traitement du vote:", err.message);
  }
}

// ── Bouton Espion — exception : réponse éphémère avec projection live ──
// Le vote Espion compte dans le dénominateur All-In comme n'importe quel
// autre vote (recordVote), mais sa réponse est privée : projection des
// dégâts du jour EN COURS (previewCloture, écriture nulle) + révélation de
// l'événement prévu pour le LENDEMAIN, exclusivité de ce bouton.

export async function handleEspion(webhookUrl, jour, discordId, username, botToken) {
  try {
    const state = await readState();
    if (!state || state.termine || state.phase !== "combat" || String(state.jour) !== String(jour)) {
      await patchOriginal(webhookUrl, {
        content: "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadBossRaidConfig();
    await recordVote(jour, discordId, "espion", username);

    const projection = await previewCloture(Number(jour), config);
    const lendemain = activeEventForDay(Number(jour) + 1, config.evenements_boss);

    const lines = [
      `🔍 **Projection actuelle du Jour ${jour}** (basée sur les votes en cours, sujette à changement jusqu’à 08:00 UTC) :`,
      `💥 Dégâts projetés : **${projection.totalDamageDuJour}**`,
    ];
    if (projection.allIn) {
      lines.push(`⚡ Ultime en cours de déclenchement : **${ULTIMATE_NAMES[projection.allIn]}** — ${ULTIMATE_EFFECTS[projection.allIn]}.`);
    }
    lines.push(
      "",
      lendemain
        ? `**${lendemain.emoji} Événement prévu demain : ${lendemain.nom}** — ${lendemain.description}`
        : "Aucun événement spécial prévu pour demain.",
    );

    await patchOriginal(webhookUrl, { content: lines.join("\n"), embeds: [], components: [] });

    // Le vote Espion fait aussi avancer le compteur "Espion (n)" du message
    // public — rafraîchi séparément en PATCH direct (bot token), même
    // découplage que Tamagotchi/Robinson pour un vote confirmé en éphémère.
    const { embed, components } = await renderCombatPayload(state, config);
    await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components }),
    });
  } catch (err) {
    console.error("[BossRaid] Échec Espion:", err.message);
  }
}

// ── Bouton [📜 Journal] — lecture seule, hors-vote ─────────────────

function formatHistoriqueLine(entry) {
  const ultimate = entry.allIn ? ` — ⚡ ${ULTIMATE_NAMES[entry.allIn]}` : "";
  const evt = entry.event ? ` — ${entry.event.emoji} ${entry.event.nom}` : "";
  return `Jour ${entry.jour} : 💥 ${entry.totalDamageDuJour} dégâts (cumul ${entry.totalDegatsApres})${ultimate}${evt}`;
}

export async function handleJournal(webhookUrl) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucun Boss Raid en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }

    const { entries } = await listHistorique({ limit: 10 });
    const lines = [
      `🏆 Dégâts cumulés : **${state.totalDegatsCumules}**`,
      `🛡️ Défense actuelle : ${state.bossStats.defense}/10 — 🔮 Résistance actuelle : ${state.bossStats.resistance}/10`,
    ];
    if (entries.length > 0) {
      lines.push("", "**Jours précédents :**", ...entries.map(formatHistoriqueLine));
    }

    const embed = { title: "📜 Journal du Raid", description: lines.join("\n"), color: BOSSRAID_COLOR };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[BossRaid] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles & Rôles] — éphémère, statique, hors-vote ─────
// Ne consomme jamais le vote du jour, contenu généré depuis boss_raid.json.
// Les 3 événements du Boss ne sont volontairement jamais listés ici — même
// principe que Robinson, ils restent une surprise (sauf pour l'Espion, qui
// révèle l'événement du lendemain en exclusivité).

function buildReglesEmbed(config) {
  const lines = [
    "Le clan affronte Kiki, un P.E.K.K.A. colossal, pendant 10 jours de combat. Objectif : accumuler le maximum de dégâts cumulés.",
    "",
    "**Rôles (1 vote par membre et par jour, modifiable jusqu’à 08:00 UTC) :**",
  ];

  const chevalier = config.roles.chevalier;
  lines.push(
    `${chevalier.emoji} **${chevalier.label}** — 0 dégât, protège jusqu’à ${chevalier.protection_slots} unités à distance (Sorcier/Archères). Impossible de voter Chevalier 2 jours de suite.`,
  );

  const voleuse = config.roles.voleuse;
  lines.push(
    `${voleuse.emoji} **${voleuse.label}** — ${voleuse.degats_min} à ${voleuse.degats_max} dégâts (jamais réduits). ${Math.round(voleuse.chance_debuff * 100)}% de chance de réduire la Défense OU la Résistance du Boss de 1 pour le lendemain.`,
  );

  const sorcier = config.roles.sorcier;
  lines.push(
    `${sorcier.emoji} **${sorcier.label}** — ${sorcier.degats_min} à ${sorcier.degats_max} dégâts, réduits par la Résistance du Boss (10%/point). Non protégé par un Chevalier : malus -50%.`,
  );

  const archeres = config.roles.archeres;
  lines.push(
    `${archeres.emoji} **${archeres.label}** — ${archeres.degats_min} à ${archeres.degats_max} dégâts, réduits par la Défense du Boss (10%/point). Non protégée par un Chevalier : malus -50%.`,
  );

  const espion = config.roles.espion;
  lines.push(
    `${espion.emoji} **${espion.label}** — 0 dégât. Réponse privée avec une projection des dégâts du jour et un indice sur l’événement du lendemain.`,
  );

  lines.push(
    "",
    "**Ultimes d’équipe (\"All-In\")** : si un rôle d’attaque réunit plus de 50% des votes du jour, toute l’équipe déclenche son Ultime pour la journée :",
    `**${ULTIMATE_NAMES.archeres}** — ${ULTIMATE_EFFECTS.archeres}.`,
    `**${ULTIMATE_NAMES.sorcier}** — ${ULTIMATE_EFFECTS.sorcier}.`,
    `**${ULTIMATE_NAMES.voleuse}** — ${ULTIMATE_EFFECTS.voleuse}.`,
    "",
    "🔄 **Régénération** : chaque nuit, Kiki récupère naturellement 1 ou 2 points de Défense et 1 ou 2 points de Résistance (tirages indépendants, plafonnés à 10/10) — sans pression suffisante des Voleuses, il finit par se rétablir entièrement.",
    "",
    "Le Boss réserve aussi quelques surprises en cours de route…",
  );

  return { title: "📖 Règles & Rôles — Boss Raid", description: lines.join("\n"), color: BOSSRAID_COLOR };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadBossRaidConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[BossRaid] Échec Règles & Rôles:", err.message);
  }
}
